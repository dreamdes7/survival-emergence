// Low-poly 3D diorama renderer (G3) — the Bad North / Islanders route.
//
// Everything is code-built geometry: the island is a height-field displaced by
// biome (water dips below sea level, rock rises), flat-shaded with per-face
// biome colours; props and survivors are primitive assemblies; one directional
// sun casts real shadows; night is actual lighting, and lit campfires become
// point lights. No models, no textures — the world data IS the scene.
//
// World units: 1 tile = 1 unit. Tile (x, y) maps to world (x + 0.5, h, y + 0.5).

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { FXAAShader } from "three/examples/jsm/shaders/FXAAShader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { AgentState, StructureState, WorldState } from "./types";
import { agentHue, hslToRgbInt } from "./utils";
import { store } from "./store";
import { openAgentModal, openStructModal, renderChrome } from "./ui";
import { chaikin, maskLoops } from "./vector";

// The watercolour preset: the whole frame is re-read as paint on paper.
// A static hand-tremor (paper-field UV wobble) bends every straight CG line;
// a REAL ink outline is drawn from a normals+depth prepass (uInk) — object
// silhouettes and creases, not just luminance steps — and only that line
// "boils" (its wobble re-rolls a few times a second, hand-drawn style) while
// the fills stay still; pigment pools at wash boundaries; luminance settles
// into soft layered bands; granulation sinks pigment into the paper's clumps.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uInk: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uPaper: { value: null as THREE.Texture | null },
    uRes: { value: new THREE.Vector2(1280, 720) },
    uInvVP: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() },
    uCamFwd: { value: new THREE.Vector3(0, 0, -1) },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform sampler2D uInk;
    uniform sampler2D uPaper;
    uniform vec2 uRes;
    uniform float uTime;
    uniform mat4 uInvVP;
    uniform vec3 uCamPos;
    uniform vec3 uCamFwd;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
    // Bousseau's pigment-density equation: d>1 deposits pigment, d<1 lifts it.
    // Nonlinear in C, so near-white paper barely moves while mids granulate —
    // the reason this reads as paint instead of a multiplied overlay.
    vec3 pigment(vec3 C, float d) { return C - (C - C * C) * (d - 1.0); }
    float vn(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                 mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    void main() {
      vec2 asp = vec2(uRes.x / uRes.y, 1.0);

      // hand tremor: the paper's smooth field (G channel) nudges every sample,
      // so straight CG edges come out gently hand-wavy. STATIC — an animated
      // wobble makes the whole frame swim without reading as art.
      float wA = texture2D(uPaper, vUv * asp * 1.35).g;
      float wB = texture2D(uPaper, vUv * asp * 1.35 + vec2(0.31, 0.47)).g;
      vec2 uv = vUv + (vec2(wA, wB) - 0.5) * (2.0 / uRes);
      vec4 c = texture2D(tDiffuse, uv);

      // INK LINE from the normals+depth prepass: Roberts cross over view-space
      // normals (creases, silhouettes) + relative depth jumps (overlaps).
      // Only this line boils: its wobble field re-rolls at 6 fps, so the
      // contour is alive the way a hand-drawn line is, while fills hold still.
      float t6 = floor(uTime * 6.0) / 6.0;
      vec2 roll = vec2(hash(vec2(t6, 3.1)), hash(vec2(t6, 7.7))) * 0.5;
      vec2 bo = (vec2(texture2D(uPaper, uv * asp * 2.2 + roll).g,
                      texture2D(uPaper, uv * asp * 2.2 + roll + vec2(0.53, 0.29)).g)
                 - 0.5) * (3.0 / uRes);
      vec2 iuv = uv + bo;
      vec2 ip = 1.3 / uRes;
      vec4 s0 = texture2D(uInk, iuv + vec2(-ip.x, -ip.y));
      vec4 s1 = texture2D(uInk, iuv + vec2( ip.x,  ip.y));
      vec4 s2 = texture2D(uInk, iuv + vec2( ip.x, -ip.y));
      vec4 s3 = texture2D(uInk, iuv + vec2(-ip.x,  ip.y));
      float far0 = 400.0;
      float d0 = s0.a <= 0.0 ? far0 : s0.a, d1 = s1.a <= 0.0 ? far0 : s1.a;
      float d2 = s2.a <= 0.0 ? far0 : s2.a, d3 = s3.a <= 0.0 ? far0 : s3.a;
      float dn = length(s0.xyz - s1.xyz) + length(s2.xyz - s3.xyz);
      float dmin = min(min(d0, d1), min(d2, d3));
      float dd = (abs(d0 - d1) + abs(d2 - d3)) / max(dmin, 4.0);
      float ink = smoothstep(0.5, 1.1, dn) * 0.55 + smoothstep(0.030, 0.10, dd) * 0.6;
      ink = min(ink, 1.0);
      // the line is deposited pigment, not a drawn stroke: pigment-equation
      // darkening (saturates mids, spares highlights) with a cool ink cast
      c.rgb = pigment(c.rgb, 1.0 + ink * 0.85);
      c.rgb *= mix(vec3(1.0), vec3(0.93, 0.985, 1.04), ink * 0.5);

      // ink pooling: soft luminance edges still pool a little pigment (kept
      // gentle now that the real contour line exists)
      vec2 px = 1.5 / uRes;
      float gx = luma(texture2D(tDiffuse, uv + vec2(px.x, 0.0)).rgb)
               - luma(texture2D(tDiffuse, uv - vec2(px.x, 0.0)).rgb);
      float gy = luma(texture2D(tDiffuse, uv + vec2(0.0, px.y)).rgb)
               - luma(texture2D(tDiffuse, uv - vec2(0.0, px.y)).rgb);
      float edge = min(0.18, (abs(gx) + abs(gy)) * 0.55);
      c.rgb = pow(max(c.rgb, 0.0), vec3(1.0 + edge * 1.5));

      // pigment turbulence anchored in WORLD space: reconstruct the surface
      // point from the prepass depth and sample noise there, so granulation
      // travels with the terrain under camera motion instead of riding the
      // screen like a static overlay (the Bousseau/Cyanilux trick).
      float vDepth = texture2D(uInk, uv).a;
      if (vDepth > 0.0) {
        vec4 hp = uInvVP * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
        vec3 rayDir = normalize(hp.xyz / hp.w - uCamPos);
        vec3 wp = uCamPos + rayDir * (vDepth / max(0.05, dot(rayDir, uCamFwd)));
        float turb = vn(wp.xz * 0.9 + wp.y * 0.5) * 0.6 + vn(wp.xz * 2.4 + 7.7) * 0.4;
        c.rgb = pigment(c.rgb, 1.0 + (turb - 0.5) * 0.30);
      }

      float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));

      // layered washes: luminance settles into soft bands, as if the scene were
      // built from a few flat washes instead of continuous CG shading
      float lq = floor(l * 6.0 + 0.5) / 6.0;
      c.rgb *= mix(1.0, (lq + 0.001) / (l + 0.001), 0.13);

      // split toning: shadows drift teal, highlights drift gold
      vec3 shadowTint = vec3(0.86, 1.02, 1.04);
      vec3 highTint  = vec3(1.08, 1.01, 0.88);
      l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb *= mix(shadowTint, highTint, smoothstep(0.15, 0.85, l));

      // filmic S-curve: rolled shadows, soft shoulder — the "one preset" feel
      c.rgb = mix(c.rgb, c.rgb * c.rgb * (3.0 - 2.0 * c.rgb), 0.38);

      // saturation with a little life back after the curve
      l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb = mix(vec3(l), c.rgb, 1.14);

      // haze-lifted blacks: nothing is ever pure dark
      c.rgb = mix(c.rgb, vec3(0.70, 0.82, 0.80), 0.05);

      // screen-space granulation: barely-there (world-space turbulence above
      // is the real pigment layer), and through the pigment equation so it
      // melts out of the highlights by construction
      float gran = texture2D(uPaper, vUv * asp * 5.0).b - 0.5;
      c.rgb = pigment(c.rgb, 1.0 + gran * 0.10);

      // vignette as UNPAINTED paper: toward the corners colours thin out and
      // lift slightly — the wash runs dry — instead of a photographic darken
      float d = distance(vUv, vec2(0.5));
      float vig = smoothstep(0.42, 0.94, d);
      c.rgb *= 1.0 - vig * 0.14;
      c.rgb = mix(c.rgb, vec3(dot(c.rgb, vec3(0.299, 0.587, 0.114))), vig * 0.10);

      // fine film grain, dialed back — granulation carries the texture now
      float g1 = hash(vUv * vec2(1710.0, 1010.0) + fract(uTime) * 61.0) - 0.5;
      float g2 = hash(floor(vUv * vec2(640.0, 380.0)) / vec2(640.0, 380.0)
                      + fract(uTime * 0.73) * 17.0) - 0.5;
      float grain = g1 * 0.62 + g2 * 0.38;
      float gw = 0.35 + (1.0 - smoothstep(0.45, 0.95, l));
      c.rgb += grain * 0.034 * gw;
      // paper tooth: the whole frame sits on one sheet — quiet, and through
      // the pigment equation (paper is flat relative to the image plane, so
      // screen space is actually correct here; loudness was the overlay tell)
      float paper = texture2D(uPaper, vUv * asp * 2.4).r;
      c.rgb = pigment(c.rgb, 1.0 + (0.91 - paper) * 0.55);
      gl_FragColor = c;
    }`,
};

// Generalized (Papari) Kuwahara — THE Susurrus pass. Eight overlapping
// directional sectors over a disc; each pixel takes the weighted blend of the
// least-varying sectors. Shading flattens into soft washes with painterly
// edges between them: the abstraction step of watercolour rendering
// (Bousseau 2006), and the single filter Susurrus builds its whole look on.
const KuwaharaShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uRes: { value: new THREE.Vector2(1280, 720) },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec2 uRes;
    varying vec2 vUv;
    const int R = 4;
    void main() {
      vec3 m[8]; vec3 s[8]; float w[8];
      for (int k = 0; k < 8; k++) { m[k] = vec3(0.0); s[k] = vec3(0.0); w[k] = 0.0; }
      vec2 px = 1.0 / uRes;
      for (int y = -R; y <= R; y++) {
        for (int x = -R; x <= R; x++) {
          vec2 v = vec2(float(x), float(y)) / float(R);
          float d2 = dot(v, v);
          if (d2 > 1.0) continue;
          vec3 col = texture2D(tDiffuse, vUv + vec2(float(x), float(y)) * px).rgb;
          float g = exp(-3.0 * d2);                    // gaussian falloff
          vec2 vd = d2 > 0.0 ? normalize(v) : vec2(1.0, 0.0);
          for (int k = 0; k < 8; k++) {
            float a = float(k) * 0.7853981634;
            float dw = dot(vd, vec2(cos(a), sin(a)));
            float wk = g * pow(max(0.0, dw), 8.0);
            if (d2 == 0.0) wk = g * 0.125;             // centre feeds all sectors
            m[k] += col * wk; s[k] += col * col * wk; w[k] += wk;
          }
        }
      }
      vec3 outC = vec3(0.0); float wSum = 0.0;
      for (int k = 0; k < 8; k++) {
        vec3 mean = m[k] / max(1e-5, w[k]);
        vec3 varc = s[k] / max(1e-5, w[k]) - mean * mean;
        float sigma = abs(varc.r) + abs(varc.g) + abs(varc.b);
        float wk = 1.0 / (1.0 + pow(255.0 * sigma, 4.0));  // hard q: flat washes
        outC += mean * wk; wSum += wk;
      }
      gl_FragColor = vec4(outC / max(1e-5, wSum), 1.0);
    }`,
};

function lam(color: number): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color, flatShading: true });
}

// Smooth-shaded variant for sculpted surfaces (plate tops and walls).
function lamS(color: number): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color });
}

// Per-instance hue/sat/lightness jitter — no two greens on the island are the
// same paint mix, the cheapest and strongest "mixed by hand" cue there is.
function jitter(color: number, seed: string, amt = 0.05): THREE.Color {
  const c = new THREE.Color(color);
  c.offsetHSL(
    (hashStr(seed + "h") - 0.5) * amt,
    (hashStr(seed + "s") - 0.5) * 0.12,
    (hashStr(seed + "l") - 0.5) * 0.07,
  );
  return c;
}

function lamJ(color: number, seed: string, amt = 0.05): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color: jitter(color, seed, amt), flatShading: true });
}

// ── palette (shared spirit with vector.ts, tuned for lit 3D) ──────────────────
const C = {
  seaDeep: 0x1f5a66,
  seaSurface: 0x3fa7ad,
  sand: 0xeadfa8,
  grass: 0x8fc767,
  jungle: 0x5f9e4d,
  rock: 0xb0a89a,
  cliff: 0x8a6f4c,
  trunk: 0x8a6a45,
  leaf: 0x6f9c5f,
  leafDark: 0x587f4b,
  bush: 0x74a061,
  stone: 0xa8a29a,
  flame: 0xffa54f,
  skyDay: 0xd6e8df,
  skyNight: 0x0e1e34,
};

// Vertical drama: heights come from distance-to-coast (a natural island cone)
// plus large-scale noise, biome bonuses (the rocky core towers), then get
// TERRACED — quantised into steps whose walls auto-paint as cliffs. This is
// the Islanders/Bad North silhouette, produced by generation, not assets.
const TERRACE = 1.35;                     // metres per terrace step — few BOLD plateaus
const PEAK_ROCK = 3.6;                    // extra height of the rocky core
const SEA_FLOOR = -1.7;

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

// ── module state ──────────────────────────────────────────────────────────────
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let controls: OrbitControls;
let sun: THREE.DirectionalLight;
let ambient: THREE.HemisphereLight;
let waterMesh: THREE.Mesh;
let waterShader: { uniforms: Record<string, { value: number }> } | null = null;
let waterTexA: THREE.Texture | null = null;   // painted ripples on the surface
let shimmerMesh: THREE.Mesh | null = null;    // counter-scrolling second layer
let shimmerMat: THREE.MeshBasicMaterial | null = null;
let cloudMat: THREE.MeshBasicMaterial | null = null;
let composer: EffectComposer;
let gradePass: ShaderPass;
let kuwaharaPass: ShaderPass;
let fxaaPass: ShaderPass;
let terrainGroup: THREE.Group | null = null;
let propsGroup: THREE.Group | null = null;
let structsGroup: THREE.Group | null = null;
let foamGroup: THREE.Group | null = null;
let foamMat: THREE.MeshBasicMaterial | null = null;
let cloudsGroup: THREE.Group | null = null;
let skyMesh: THREE.Mesh | null = null;
let skyMat: THREE.ShaderMaterial | null = null;
let fireLights: THREE.PointLight[] = [];
let inkTarget: THREE.WebGLRenderTarget | null = null;
let inkMat: THREE.ShaderMaterial | null = null;
type Swayer = { m: THREE.Object3D; phase: number; amp: number; base: number };
let swayers: Swayer[] = [];
let breathers: Swayer[] = [];               // canopy blobs pulsing in the wind
let waveGroup: THREE.Group | null = null;
let active = false;
let rafId = 0;
let builtMapKey = "";
let heightGrid: number[][] = [];          // smoothed corner heights (n+1)^2
let mapN = 0;
let state: WorldState | null = null;
let nightMix = 0;                          // 0 = day, 1 = night (lerped)
let stormMix = 0;                          // 0 = clear, 1 = storm (lerped)
let followId: string | null = null;        // camera-follow state
let followDollyT = 1e9;                    // seconds since the follow started
const followGoal = new THREE.Vector3();
const followDelta = new THREE.Vector3();

type Agent3d = {
  group: THREE.Group;
  x: number; z: number;                    // current world pos (lerped)
  tx: number; tz: number;                  // target
  status: string;
};
const agents3d = new Map<string, Agent3d>();

// Decorative objects (sky, water, foam, clouds, flames, reflections) live on
// layer 1 only: the main camera renders layers 0+1, the ink prepass renders
// layer 0 alone, so atmosphere never grows an outline.
function markDecor(obj: THREE.Object3D): void {
  obj.traverse((o) => o.layers.set(1));
}

// ── hand-modelled GLB assets (user's own models > primitive assemblies) ───────
// Each model is normalised on load: recentred in XZ, foot at y=0, scaled to a
// target world size — tall props fit by height, ground props (fire pit, hatch)
// by footprint width; `sink` buries base plugs slightly into the ground.
const MODEL_DEFS: Record<string, { url: string; size: number; axis: "y" | "xz"; sink: number }> = {
  campfire: { url: "models/campfire.glb", size: 1.0, axis: "xz", sink: 0.05 },
  lighthouse: { url: "models/lighthouse.glb", size: 3.1, axis: "y", sink: 0.02 },
  bunker: { url: "models/bunker2.glb", size: 1.1, axis: "xz", sink: 0.05 },
};
const models = new Map<string, THREE.Group>();

function loadModels(): void {
  const loader = new GLTFLoader();
  for (const [key, def] of Object.entries(MODEL_DEFS)) {
    loader.load(def.url, (gltf) => {
      const root = gltf.scene;
      root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; }
      });
      const bb = new THREE.Box3().setFromObject(root);
      const size = bb.getSize(new THREE.Vector3());
      const fit = def.axis === "y" ? size.y : Math.max(size.x, size.z);
      const s = def.size / Math.max(0.001, fit);
      const wrap = new THREE.Group();
      wrap.add(root);
      root.scale.setScalar(s);
      root.position.set(
        -(bb.min.x + bb.max.x) / 2 * s,
        -bb.min.y * s - def.sink,
        -(bb.min.z + bb.max.z) / 2 * s,
      );
      models.set(key, wrap);
      if (state && heightGrid.length) buildStructs(state);   // swap in live
    }, undefined, (err) => console.error(`[render3d] model FAILED: ${key}`, err));
  }
}

// ── height sampling ───────────────────────────────────────────────────────────
// Two-octave value noise on a hashed lattice (deterministic, seedless).
function vnoise(x: number, y: number, cell: number, salt: number): number {
  const gx = x / cell, gy = y / cell;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const fx = gx - x0, fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const v00 = hash01(x0, y0, salt), v10 = hash01(x0 + 1, y0, salt);
  const v01 = hash01(x0, y0 + 1, salt), v11 = hash01(x0 + 1, y0 + 1, salt);
  return (v00 * (1 - sx) + v10 * sx) * (1 - sy) + (v01 * (1 - sx) + v11 * sx) * sy;
}

function hash01(x: number, y: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2246822519) >>> 0;
  h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
  return (h >>> 8) / 16777216;
}

function buildHeights(st: WorldState): void {
  const n = st.map.size;
  mapN = n;
  const grid = st.map.grid;
  const isWater = (x: number, y: number) =>
    x < 0 || y < 0 || x >= n || y >= n || grid[y][x].includes("water");

  // BFS distance to the coast — the backbone of the island's cone shape.
  const INF = 1e9;
  const dist: number[][] = Array.from({ length: n }, () => new Array(n).fill(INF));
  const queue: [number, number][] = [];
  for (let y = 0; y < n; y += 1)
    for (let x = 0; x < n; x += 1)
      if (isWater(x, y)) { dist[y][x] = 0; queue.push([x, y]); }
  for (let qi = 0; qi < queue.length; qi += 1) {
    const [x, y] = queue[qi];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < n && ny < n && dist[ny][nx] > dist[y][x] + 1) {
        dist[ny][nx] = dist[y][x] + 1;
        queue.push([nx, ny]);
      }
    }
  }

  const tileH = (x: number, y: number): number => {
    if (isWater(x, y)) return SEA_FLOOR;
    const d = dist[y][x];
    const t = grid[y][x];
    // coastal shelf rises inland, biomes add their storeys
    let h = 0.1 + Math.min(1, d / 7) ** 1.15 * 2.1;
    if (t.includes("rock")) h += PEAK_ROCK * Math.min(1, d / 9 + 0.35);
    else if (t.includes("foliage")) h += 0.5;
    // gentle, slow noise — enough to bend plateau outlines, not to crumb them
    h += (vnoise(x, y, 11, 31) - 0.5) * 0.8 + (vnoise(x, y, 5, 57) - 0.5) * 0.2;
    return Math.max(0.08, h);
  };

  // corner grid, smoothing, then TERRACING (the quantised steps), then one
  // gentle pass so terrace lips aren't razor-sharp
  let g: number[][] = [];
  for (let y = 0; y <= n; y += 1) {
    const row: number[] = [];
    for (let x = 0; x <= n; x += 1) {
      row.push((tileH(x - 1, y - 1) + tileH(x, y - 1) + tileH(x - 1, y) + tileH(x, y)) / 4);
    }
    g.push(row);
  }
  for (let pass = 0; pass < 3; pass += 1) {
    const out = g.map((r) => r.slice());
    for (let y = 1; y < n; y += 1)
      for (let x = 1; x < n; x += 1)
        out[y][x] = (g[y][x] * 2 + g[y - 1][x] + g[y + 1][x] + g[y][x - 1] + g[y][x + 1]) / 6;
    g = out;
  }
  heightGrid = g;    // SMOOTH field — the plates quantise it, not the grid
}

// ── the island as SCULPTURE: stacked extruded plates ─────────────────────────
// Bad North islands are not displaced planes — they are clean 2D outlines
// extruded into vertical-walled plates. We cut the smooth height field at
// fixed thresholds, smooth each cut with Chaikin, and extrude. Flat tops,
// smooth curved walls, an authored silhouette — out of pure generation.
const PLATE_THRESH = [0.05, 1.2, 2.4, 3.6, 4.8];  // raw-height cuts (0 = coastline)
const PLATE_TOP = [0.26, 1.0, 1.74, 2.48, 3.22];  // world-space top of each plate

function rawHeightAt(wx: number, wz: number): number {
  // bilinear over the smooth corner grid
  const x = Math.max(0, Math.min(mapN - 0.001, wx));
  const z = Math.max(0, Math.min(mapN - 0.001, wz));
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const fx = x - x0, fz = z - z0;
  const h00 = heightGrid[z0][x0], h10 = heightGrid[z0][x0 + 1];
  const h01 = heightGrid[z0 + 1][x0], h11 = heightGrid[z0 + 1][x0 + 1];
  return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
}

function plateLevelAt(wx: number, wz: number): number {
  const h = rawHeightAt(wx, wz);
  let level = -1;
  for (let k = 0; k < PLATE_THRESH.length; k += 1) {
    if (h > PLATE_THRESH[k]) level = k;
  }
  return level;                    // -1 = open sea
}

function heightAt(wx: number, wz: number): number {
  const level = plateLevelAt(wx, wz);
  return level < 0 ? SEA_FLOOR : PLATE_TOP[level];
}

// ── scene bootstrap ───────────────────────────────────────────────────────────
function ensureRenderer(stageEl: HTMLElement): void {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;   // filmic colour response
  renderer.toneMappingExposure = 1.15;
  renderer.domElement.style.position = "absolute";
  renderer.domElement.style.inset = "0";
  stageEl.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(C.skyDay);
  scene.fog = new THREE.Fog(C.skyDay, 70, 210);   // ever-present unifying haze

  // Gradient sky dome — the flat backdrop is what screamed "web page".
  skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x8fd0ea) },
      uHor: { value: new THREE.Color(0xf6f3e2) },
    },
    vertexShader: `
      varying float vY;
      void main() {
        vY = normalize(position).y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uTop; uniform vec3 uHor;
      varying float vY;
      void main() {
        float t = clamp(vY * 1.8, 0.0, 1.0);
        gl_FragColor = vec4(mix(uHor, uTop, t), 1.0);
      }`,
  });
  skyMesh = new THREE.Mesh(new THREE.SphereGeometry(420, 20, 14), skyMat);
  markDecor(skyMesh);
  scene.add(skyMesh);

  camera = new THREE.PerspectiveCamera(32, 1, 0.1, 500);
  camera.layers.enable(1);                 // solids on 0, atmosphere on 1

  // Ink prepass: view-space normals in RGB + linear depth in A, rendered with
  // one override material into a half-float target the grade shader reads.
  inkMat = new THREE.ShaderMaterial({
    vertexShader: `
      varying vec3 vN; varying float vD;
      void main() {
        vN = normalMatrix * normal;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vD = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec3 vN; varying float vD;
      void main() { gl_FragColor = vec4(normalize(vN), vD); }`,
  });
  inkTarget = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  loadModels();

  sun = new THREE.DirectionalLight(0xfff2dd, 1.9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  scene.add(sun);
  scene.add(sun.target);

  // Ambient dominates (soft, near-shadowless reference look); the sun only adds
  // gentle modelling and long soft shadows.
  ambient = new THREE.HemisphereLight(0xd8ecec, 0x6a7a5e, 0.85);
  scene.add(ambient);

  // Sea: a segmented surface plane with GPU waves + an opaque deep floor.
  // Painted ripples scroll slowly across it (map), with a counter-scrolling
  // shimmer layer above for parallax — texture and volume instead of a void.
  waterTexA = rippleTexture(1);
  waterTexA.repeat.set(26, 26);                // ~18 world units per tile
  const waterMatl = new THREE.MeshPhongMaterial({
    color: 0x7fb6ba, transparent: true, opacity: 0.5,
    shininess: 14, specular: 0x1e3a44,   // sky-toned matte water (Bad North void);
    map: waterTexA,
  });                                    // the shelf plate supplies the turquoise
  waterMatl.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uAmp = { value: 0.03 };
    shader.vertexShader = "uniform float uTime;\nuniform float uAmp;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         transformed.z += sin(position.x * 0.55 + uTime * 1.1) * uAmp
                        + cos(position.y * 0.45 + uTime * 0.8) * uAmp
                        + sin((position.x + position.y) * 0.22 + uTime * 0.5) * uAmp * 1.4;`,
      );
    waterShader = shader as unknown as { uniforms: Record<string, { value: number }> };
  };
  waterMesh = new THREE.Mesh(new THREE.PlaneGeometry(480, 480, 110, 110), waterMatl);
  waterMesh.rotation.x = -Math.PI / 2;
  waterMesh.position.y = 0;
  waterMesh.receiveShadow = true;
  markDecor(waterMesh);
  scene.add(waterMesh);
  const shimmerTex = rippleTexture(2);
  shimmerTex.repeat.set(15, 15);               // coarser + opposite drift = depth
  shimmerMat = new THREE.MeshBasicMaterial({
    map: shimmerTex, transparent: true, opacity: 0.10,
    color: 0xcdeee4, depthWrite: false,
  });
  shimmerMesh = new THREE.Mesh(new THREE.PlaneGeometry(480, 480), shimmerMat);
  shimmerMesh.rotation.x = -Math.PI / 2;
  shimmerMesh.position.y = 0.02;
  markDecor(shimmerMesh);
  scene.add(shimmerMesh);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(1000, 1000),
    new THREE.MeshLambertMaterial({ color: C.seaDeep }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1.45;
  markDecor(floor);
  scene.add(floor);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.44;    // never below the horizon
  controls.minPolarAngle = Math.PI * 0.12;
  controls.minDistance = 6;
  controls.maxDistance = 140;

  // Selection halo that follows the selected agent.
  selRing = new THREE.Mesh(
    new THREE.RingGeometry(0.26, 0.36, 24),
    new THREE.MeshBasicMaterial({ color: 0x2bd1c4, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
  );
  selRing.rotation.x = -Math.PI / 2;
  selRing.visible = false;
  markDecor(selRing);
  scene.add(selRing);

  // Post: render -> bloom (halation for fire/sky) -> tone-map/sRGB output ->
  // film grade -> FXAA. OutputPass applies ACES + sRGB inside a composer chain;
  // without it the frame stays linear and looks crushed-dark.
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  kuwaharaPass = new ShaderPass(KuwaharaShader);
  composer.addPass(kuwaharaPass);            // abstraction first, on linear HDR
  // bloom kept for fire/lamp halation only: high threshold + modest strength
  // so flat white clouds and bright sand stop glowing like neon
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(1280, 720), 0.22, 0.6, 0.92));
  composer.addPass(new OutputPass());
  gradePass = new ShaderPass(GradeShader);
  gradePass.uniforms.uPaper.value = paperTexture();
  gradePass.uniforms.uInk.value = inkTarget.texture;
  composer.addPass(gradePass);
  fxaaPass = new ShaderPass(FXAAShader);
  composer.addPass(fxaaPass);

  bindPicking(renderer.domElement);

  // debug handle for screenshot tooling (camera framing from Playwright)
  (window as unknown as Record<string, unknown>).__r3d = {
    lookAt(x: number, z: number, dist = 12, azimuth = 0.6): void {
      const y = Math.max(0.02, heightAt(x, z));
      controls.target.set(x, y, z);
      camera.position.set(
        x + Math.sin(azimuth) * dist, y + dist * 0.62, z + Math.cos(azimuth) * dist);
      controls.update();
    },
    follow(id: string | null): void {
      store.selectedAgentId = id;
    },
  };
}

// ── picking: tap = select, double-tap = open the card ─────────────────────────
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let selRing: THREE.Mesh;
let downX = 0, downY = 0, downT = 0;
let lastTapId = "", lastTapT = 0;

function bindPicking(el: HTMLElement): void {
  el.addEventListener("pointerdown", (e) => {
    downX = e.clientX; downY = e.clientY; downT = performance.now();
  });
  el.addEventListener("pointerup", (e) => {
    // a click, not an orbit drag
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;
    if (performance.now() - downT > 500) return;
    pick(e);
  });
}

function pick(e: PointerEvent): void {
  if (!renderer || !state) return;
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.set(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(scene.children, true);
  for (const h of hits) {
    let o: THREE.Object3D | null = h.object;
    while (o) {
      const agentId = o.userData?.agentId as string | undefined;
      const structId = o.userData?.structId as string | undefined;
      if (agentId) {
        const now = performance.now();
        const dbl = now - lastTapT < 320 && lastTapId === agentId;
        lastTapT = now; lastTapId = agentId;
        store.selectedAgentId = agentId;
        store.selectedStructureId = null;
        if (dbl) openAgentModal(agentId);
        else renderChrome();
        return;
      }
      if (structId) {
        const s = state.structures.find((x) => x.id === structId);
        if (s) {
          store.selectedStructureId = structId;
          openStructModal(s);
        }
        return;
      }
      o = o.parent;
    }
  }
  // clicked open scenery: release the selection (and the camera follow)
  store.selectedAgentId = null;
  store.selectedStructureId = null;
  renderChrome();
}

// Screen-space paper, one texture with three INDEPENDENT channels the grade
// shader reads separately: R = fine cold-press tooth (multiplied over the
// frame), G = smooth low-frequency field (drives the hand-tremor UV wobble),
// B = mid-frequency pigment clumps (granulation in mids/shadows).
let paperTex: THREE.Texture | null = null;

function paperTexture(): THREE.Texture {
  if (paperTex) return paperTex;
  const size = 512;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d")!;
  // Periodic value noise so the RepeatWrapping texture tiles with no seam —
  // a seam in the tremor field would tear the frame along a visible line.
  const pnoise = (x: number, y: number, cell: number, salt: number): number => {
    const period = size / cell;
    const gx = x / cell, gy = y / cell;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = gx - x0, fy = gy - y0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const m = (v: number) => ((v % period) + period) % period;
    const v00 = hash01(m(x0), m(y0), salt), v10 = hash01(m(x0 + 1), m(y0), salt);
    const v01 = hash01(m(x0), m(y0 + 1), salt), v11 = hash01(m(x0 + 1), m(y0 + 1), salt);
    return (v00 * (1 - sx) + v10 * sx) * (1 - sy) + (v01 * (1 - sx) + v11 * sx) * sy;
  };
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      // R: per-pixel tooth + a whisper of fibre streaking
      const tooth = hash01(x, y, 3) * 0.7 + hash01(x >> 2, y, 5) * 0.3;
      img.data[i] = 232 + Math.round((tooth - 0.5) * 40);
      // G: two octaves of smooth noise — the tremor field must be continuous
      const w = (pnoise(x, y, 64, 41) - 0.5) * 1.5 + (pnoise(x, y, 32, 43) - 0.5) * 0.6;
      img.data[i + 1] = Math.max(0, Math.min(255, Math.round(128 + w * 170)));
      // B: clumpy granulation — sharpened mid-scale noise plus fine speckle
      const cl = (pnoise(x, y, 8, 47) - 0.5) * 2.1 + (hash01(x, y, 53) - 0.5) * 0.5;
      img.data[i + 2] = Math.max(0, Math.min(255, Math.round(128 + cl * 150)));
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  paperTex = new THREE.CanvasTexture(cv);
  paperTex.wrapS = paperTex.wrapT = THREE.RepeatWrapping;
  return paperTex;
}

// Hand-painted wash v2: layered directional BRUSH STROKES — soft elongated
// gradient stamps with hue jitter (ochre / sage / teal casts), a broad
// diagonal flow crossed by shorter counter-strokes, then a granulation pass.
// Stamped 3×3 so the tile is seamless. Multiplied under the plate colours it
// reads as paint applied by hand, where the old radial blotches read as stains.
let brushTex: THREE.Texture | null = null;

function brushTexture(): THREE.Texture {
  if (brushTex) return brushTex;
  const size = 512;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#f8f6ef";
  ctx.fillRect(0, 0, size, size);
  let s = 40503;
  const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647);
  const stroke = (x: number, y: number, ang: number, len: number, w: number,
                  hue: number, sat: number, lit: number, a: number): void => {
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        if (x + ox < -len || x + ox > size + len ||
            y + oy < -len || y + oy > size + len) continue;
        ctx.save();
        ctx.translate(x + ox, y + oy);
        ctx.rotate(ang);
        ctx.scale(len, w);
        const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
        grad.addColorStop(0, `hsla(${hue},${sat}%,${lit}%,${a})`);
        grad.addColorStop(0.7, `hsla(${hue},${sat}%,${lit}%,${a * 0.5})`);
        grad.addColorStop(1, `hsla(${hue},${sat}%,${lit}%,0)`);
        ctx.fillStyle = grad;
        ctx.fillRect(-1, -1, 2, 2);
        ctx.restore();
      }
    }
  };
  const FLOW = 0.62;                        // one dominant brush direction
  // layer 1: long broad washes along the flow
  for (let i = 0; i < 72; i += 1) {
    stroke(rnd() * size, rnd() * size, FLOW + (rnd() - 0.5) * 0.5,
      60 + rnd() * 95, 9 + rnd() * 15,
      40 + (rnd() - 0.5) * 150, 16 + rnd() * 15, rnd() < 0.5 ? 88 : 48,
      0.06 + rnd() * 0.05);
  }
  // layer 2: shorter counter-strokes across the flow
  for (let i = 0; i < 58; i += 1) {
    stroke(rnd() * size, rnd() * size, FLOW + Math.PI / 2 + (rnd() - 0.5) * 0.7,
      22 + rnd() * 42, 4.5 + rnd() * 8,
      40 + (rnd() - 0.5) * 170, 18 + rnd() * 16, rnd() < 0.5 ? 90 : 45,
      0.05 + rnd() * 0.045);
  }
  // granulation: clumped pixel noise so flats never read as vector fills
  const img = ctx.getImageData(0, 0, size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const g = (hash01(x >> 1, y >> 1, 7) * 0.55 + hash01(x >> 3, y >> 3, 13) * 0.45 - 0.5) * 13;
      img.data[i] += g; img.data[i + 1] += g; img.data[i + 2] += g;
    }
  }
  ctx.putImageData(img, 0, 0);
  brushTex = new THREE.CanvasTexture(cv);
  brushTex.wrapS = brushTex.wrapT = THREE.RepeatWrapping;
  brushTex.colorSpace = THREE.SRGBColorSpace;
  brushTex.repeat.set(1 / 9, 1 / 9);        // plate UVs are world units: 9 u/tile
  return brushTex;
}

// Macro wash baked into vertices: a very-low-frequency warm/cool drift and a
// gentle lightness gradient across the island, plus darkening down the walls
// toward each plate's foot (grounding). This is the "one big brush" pass that
// kills flat-poly uniformity at the scale the tiled texture can't reach.
function tintGeometry(geo: THREE.BufferGeometry, topY: number): void {
  const pos = geo.getAttribute("position");
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const warm = vnoise(x, z, 17, 71) - 0.5;            // warm/cool cast drift
    const light = 0.95 + (vnoise(x, z, 9, 83) - 0.5) * 0.10;
    const drop = Math.max(0, Math.min(1, (topY - y) / 2.2));
    const shade = light * (1 - drop * 0.16);
    colors[i * 3] = shade * (1 + warm * 0.07);
    colors[i * 3 + 1] = shade;
    colors[i * 3 + 2] = shade * (1 - warm * 0.07);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

// ── loop classification for extrusion (outer shells vs holes) ─────────────────
type Loop = [number, number][];

function polyArea(loop: Loop): number {
  let a = 0;
  for (let i = 0; i < loop.length; i += 1) {
    const [x1, y1] = loop[i];
    const [x2, y2] = loop[(i + 1) % loop.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function pointInLoop(px: number, py: number, loop: Loop): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i, i += 1) {
    const [xi, yi] = loop[i];
    const [xj, yj] = loop[j];
    if ((yi > py) !== (yj > py)
        && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Group contour loops into {outer, holes[]} shells by containment parity. */
function classifyLoops(loops: Loop[]): { outer: Loop; holes: Loop[] }[] {
  const info = loops.map((l) => ({ loop: l, area: Math.abs(polyArea(l)), depth: 0, parent: -1 }));
  for (let i = 0; i < info.length; i += 1) {
    const [px, py] = info[i].loop[0];
    let best = -1;
    for (let j = 0; j < info.length; j += 1) {
      if (i === j) continue;
      if (info[j].area > info[i].area && pointInLoop(px, py, info[j].loop)) {
        info[i].depth += 1;
        if (best === -1 || info[j].area < info[best].area) best = j;
      }
    }
    info[i].parent = best;
  }
  const shells: { outer: Loop; holes: Loop[] }[] = [];
  const shellIdx = new Map<number, number>();
  info.forEach((it, i) => {
    if (it.depth % 2 === 0) {
      shellIdx.set(i, shells.length);
      shells.push({ outer: it.loop, holes: [] });
    }
  });
  info.forEach((it) => {
    if (it.depth % 2 === 1 && it.parent >= 0 && shellIdx.has(it.parent)) {
      shells[shellIdx.get(it.parent)!].holes.push(it.loop);
    }
  });
  return shells;
}

// ── terrain: the island as SCULPTURE — stacked extruded plates ────────────────
function buildTerrain(st: WorldState): void {
  terrainGroup?.removeFromParent();
  terrainGroup = new THREE.Group();
  const n = st.map.size;
  buildHeights(st);

  // Submerged shelf: a turquoise plate just under the surface — the glowing
  // shallows ring that reads through the translucent water (Islanders shore).
  {
    const solid = (x: number, y: number) =>
      x >= 0 && y >= 0 && x <= n && y <= n && heightGrid[y]?.[x] > -0.65;
    let loops = maskLoops(n + 1, solid).map((l) => chaikin(l, 2));
    loops = loops.map((l) => l.filter((_, i) => i % 2 === 0));
    loops = loops.filter((l) => Math.abs(polyArea(l)) > 4);
    for (const shell of classifyLoops(loops)) {
      const shape = new THREE.Shape(shell.outer.map(([x, z]) => new THREE.Vector2(x, -z)));
      for (const h of shell.holes) {
        shape.holes.push(new THREE.Path(h.map(([x, z]) => new THREE.Vector2(x, -z))));
      }
      const geo = new THREE.ExtrudeGeometry(shape, {
        depth: 1.0, steps: 1, bevelEnabled: false,
      });
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, -1.32, 0);
      const mesh = new THREE.Mesh(geo, [lamS(0x83c9be), lamS(0x63a9a0)]);
      mesh.receiveShadow = true;
      terrainGroup.add(mesh);
    }
  }

  // One plate per level: smooth contour -> Shape (with holes) -> extrusion with
  // a soft bevel lip. Flat tops, smooth vertical walls, authored silhouette.
  const topColors = [0xe9ddb6, 0x9fc37e, 0x93bb74, 0x89ad84, 0xaaa69e];
  // every terrain surface shares the brush wash + per-vertex macro tint
  const washed = (color: number): THREE.MeshLambertMaterial => {
    const m = lamS(color);
    m.map = brushTexture();
    m.vertexColors = true;
    return m;
  };
  const wallLow = washed(0xcfbf9a);            // wet-sand base walls
  const wallHigh = washed(0x9aa1a5);           // grey rock walls above
  const BEV = 0.12;
  const dress = new THREE.Group();             // rim grass + wall-foot rocks
  const tuftMat = lamS(0x7ba763);
  const rockMat = lam(0x9d9890);
  for (let k = 0; k < PLATE_THRESH.length; k += 1) {
    const thr = PLATE_THRESH[k];
    const solid = (x: number, y: number) =>
      x >= 0 && y >= 0 && x <= n && y <= n && heightGrid[y]?.[x] > thr;
    let loops = maskLoops(n + 1, solid).map((l) => chaikin(l, 2));
    loops = loops.map((l) => l.filter((_, i) => i % 2 === 0));   // decimate
    loops = loops.filter((l) => Math.abs(polyArea(l)) > 2.5);    // drop crumbs
    if (!loops.length) continue;

    const baseY = k === 0 ? -1.3 : PLATE_TOP[k - 1] - 0.08;
    const depth = PLATE_TOP[k] - baseY - BEV * 2;
    const topMat = washed(topColors[k]);
    for (const shell of classifyLoops(loops)) {
      const shape = new THREE.Shape(
        shell.outer.map(([x, z]) => new THREE.Vector2(x, -z)));
      for (const h of shell.holes) {
        shape.holes.push(new THREE.Path(h.map(([x, z]) => new THREE.Vector2(x, -z))));
      }
      const geo = new THREE.ExtrudeGeometry(shape, {
        depth, steps: 1,
        bevelEnabled: true, bevelThickness: BEV, bevelSize: BEV * 1.1,
        bevelSegments: 2,
      });
      geo.rotateX(-Math.PI / 2);               // shape XY -> world XZ, depth -> +Y
      geo.translate(0, baseY + BEV, 0);
      tintGeometry(geo, PLATE_TOP[k]);         // macro wash + wall-foot shading
      const mesh = new THREE.Mesh(geo, [topMat, k === 0 ? wallLow : wallHigh]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      terrainGroup.add(mesh);

      // SET DRESSING along this shell's rim: grass tufts just inside the edge
      // (life at the silhouette) and small rocks at the wall's foot below.
      const loop = shell.outer;
      for (let i = 0; i < loop.length; i += 6) {
        const [px, pz] = loop[i];
        const [qx, qz] = loop[(i + 3) % loop.length];
        const tx = qx - px, tz = qz - pz;
        const len = Math.hypot(tx, tz) || 1;
        let nx = -tz / len, nz = tx / len;     // candidate inward normal
        if (!pointInLoop(px + nx * 0.8, pz + nz * 0.8, loop)) { nx = -nx; nz = -nz; }
        const r = hashStr(`d${k}:${i}:${Math.round(px)}`);
        if (r < 0.5) {
          // tuft: three tiny leaning cones on the rim
          for (let b = 0; b < 3; b += 1) {
            const cone3 = new THREE.Mesh(
              new THREE.ConeGeometry(0.035, 0.16 + (b % 2) * 0.06, 4), tuftMat);
            cone3.position.set(
              px + nx * (0.5 + r * 0.5) + (b - 1) * 0.09,
              PLATE_TOP[k] + 0.07, pz + nz * (0.5 + r * 0.5) + ((b + 1) % 2) * 0.07);
            cone3.rotation.z = (b - 1) * 0.22;
            dress.add(cone3);
          }
        } else if (r < 0.68 && k >= 1) {
          // rock at the foot of the wall on the plate below
          const rock = new THREE.Mesh(
            new THREE.DodecahedronGeometry(0.1 + r * 0.12, 0), rockMat);
          rock.position.set(px - nx * 0.55, PLATE_TOP[k - 1] + 0.08, pz - nz * 0.55);
          rock.rotation.set(r * 7, r * 3, r * 5);
          rock.castShadow = true;
          dress.add(rock);
        }
      }
    }
  }
  terrainGroup.add(dress);

  // Bad North: the island mirrored as a dark still silhouette in the water.
  const reflMat = new THREE.MeshBasicMaterial({
    color: 0x16323a, transparent: true, opacity: 0.13, depthWrite: false,
  });
  const refl = new THREE.Group();
  for (const child of [...terrainGroup.children]) {
    refl.add(new THREE.Mesh((child as THREE.Mesh).geometry, reflMat));
  }
  refl.scale.y = -1;
  refl.position.y = -0.15;
  markDecor(refl);
  terrainGroup.add(refl);
  scene.add(terrainGroup);

  // Sun geometry sized to the island (kept low so shadows stay long and legible).
  const cx = n / 2, cz = n / 2;
  sun.position.set(cx - 52, 44, cz - 26);
  sun.target.position.set(cx, 0, cz);
  const s = n * 0.75;
  const shCam = sun.shadow.camera as THREE.OrthographicCamera;
  shCam.left = -s; shCam.right = s; shCam.top = s; shCam.bottom = -s;
  shCam.near = 10; shCam.far = 160;
  shCam.updateProjectionMatrix();

  // Sea + sky furniture follows the island.
  waterMesh.position.set(cx, 0, cz);
  shimmerMesh?.position.set(cx, 0.02, cz);
  if (skyMesh) skyMesh.position.set(cx, 0, cz);
  buildFoam(st);
  buildWaves(cx, cz, n);
  buildClouds(cx, cz, n);

  // First-time camera framing: pulled back so the island floats in open sea.
  camera.position.set(cx + n * 0.12, n * 1.1, cz + n * 1.25);
  controls.target.set(cx, 0, cz);
  controls.update();
}

// Foam ribbons hugging the ACTUAL waterline: the y=0 iso-contour of the
// smoothed height grid (the tile land-mask boundary drifts a tile or two from
// where the smoothed terrain really meets the sea).
function buildFoam(st: WorldState): void {
  foamGroup?.removeFromParent();
  foamGroup = new THREE.Group();
  const n = st.map.size;
  const land = (x: number, y: number) =>
    x >= 0 && y >= 0 && x <= n && y <= n && heightGrid[y][x] > 0.03;
  foamMat = new THREE.MeshBasicMaterial({
    color: 0xf2fbf6, transparent: true, opacity: 0.55,
    depthWrite: false, side: THREE.DoubleSide,
  });
  // The Islanders signature: a soft glowing halo just off every shore.
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xaee6d8, transparent: true, opacity: 0.22,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const edge = (x: number, z: number) =>
    x < 0.8 || z < 0.8 || x > n - 0.8 || z > n - 0.8;
  const ribbonFor = (loops: [number, number][][], w: number,
                     mat: THREE.Material, y: number): void => {
    for (const loop of loops) {
      const verts: number[] = [];
      for (let i = 0; i < loop.length; i += 1) {
        const [ax, az] = loop[i];
        const [bx, bz] = loop[(i + 1) % loop.length];
        if (edge(ax, az) || edge(bx, bz)) continue;
        const dx = bx - ax, dz = bz - az;
        const len = Math.hypot(dx, dz) || 1;
        const nx = -dz / len * w, nz = dx / len * w;
        verts.push(
          ax - nx, 0, az - nz, bx - nx, 0, bz - nz, ax + nx, 0, az + nz,
          ax + nx, 0, az + nz, bx - nx, 0, bz - nz, bx + nx, 0, bz + nz,
        );
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts), 3));
      const ribbon = new THREE.Mesh(geo, mat);
      ribbon.position.y = y;
      foamGroup!.add(ribbon);
    }
  };
  const loops = maskLoops(n + 1, land).map((l) => chaikin(l, 2));
  ribbonFor(loops, 0.85, glowMat, 0.035);     // wide soft halo
  ribbonFor(loops, 0.2, foamMat, 0.05);       // crisp foam line
  markDecor(foamGroup);
  scene.add(foamGroup);
}

// Painted water surface: seamless canvas of soft horizontal ripple strokes —
// sine-periodic in x (wraps exactly), stamped ±size in y. Multiplied under the
// water colour and slowly scrolled it gives the sea its brushwork; a second
// counter-scrolling layer above adds the parallax "depth" of moving washes.
function rippleTexture(salt: number): THREE.Texture {
  const size = 512;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#f2f2ee";
  ctx.fillRect(0, 0, size, size);
  let s = 7433 + salt * 1013;
  const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647);
  ctx.lineCap = "round";
  for (let i = 0; i < 46; i += 1) {
    const y0 = rnd() * size;
    const amp = 2 + rnd() * 7;
    const k = 1 + Math.floor(rnd() * 3);        // whole waves per tile = seamless
    const ph = rnd() * Math.PI * 2;
    const dark = rnd() < 0.62;
    const alpha = 0.05 + rnd() * 0.09;
    ctx.strokeStyle = dark
      ? `rgba(96, 128, 128, ${alpha})` : `rgba(255, 255, 252, ${alpha * 1.4})`;
    ctx.lineWidth = 2.5 + rnd() * 5;
    const x0 = rnd() * size, len = size * (0.25 + rnd() * 0.5);
    for (const oy of [-size, 0, size]) {
      for (const ox of [-size, 0]) {          // second stamp wraps the right edge
        ctx.beginPath();
        for (let x = 0; x <= len; x += 8) {
          const y = y0 + oy + Math.sin(((x0 + x) / size) * Math.PI * 2 * k + ph) * amp;
          if (x === 0) ctx.moveTo(x0 + x + ox, y); else ctx.lineTo(x0 + x + ox, y);
        }
        ctx.stroke();
      }
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Sparse hand-drawn wave dashes floating on the water around the island —
// each one slowly surfacing, holding, and sinking away on its own phase.
let waveTex: THREE.Texture | null = null;

function waveStrokeTexture(): THREE.Texture {
  if (waveTex) return waveTex;
  const w = 128, h = 32;
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d")!;
  // a tapered arc dash: thick soft centre, thin dry ends
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineCap = "round";
  for (let pass = 0; pass < 3; pass += 1) {
    ctx.lineWidth = 7 - pass * 2.4;
    ctx.globalAlpha = 0.35 + pass * 0.25;
    ctx.beginPath();
    ctx.moveTo(8 + pass * 6, h * 0.62);
    ctx.quadraticCurveTo(w / 2, h * (0.30 + pass * 0.05), w - 8 - pass * 6, h * 0.62);
    ctx.stroke();
  }
  waveTex = new THREE.CanvasTexture(cv);
  return waveTex;
}

function buildWaves(cx: number, cz: number, n: number): void {
  waveGroup?.removeFromParent();
  waveGroup = new THREE.Group();
  const geo = new THREE.PlaneGeometry(1.6, 0.4);
  for (let i = 0; i < 44; i += 1) {
    // rejection-sample open sea in a ring around the island
    let x = 0, z = 0, ok = false;
    for (let t = 0; t < 12 && !ok; t += 1) {
      const a = hashStr(`wa${i}t${t}`) * Math.PI * 2;
      const r = n * (0.18 + hashStr(`wr${i}t${t}`) * 0.5);
      x = cx + Math.cos(a) * r; z = cz + Math.sin(a) * r * 0.9;
      ok = heightAt(x, z) <= SEA_FLOOR + 0.01;
    }
    if (!ok) continue;
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: waveStrokeTexture(), transparent: true, opacity: 0,
      depthWrite: false, color: 0xeafaf2,
    }));
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = (hashStr(`wg${i}`) - 0.5) * 0.5;
    const sc = 0.8 + hashStr(`ws${i}`) * 1.3;
    m.scale.setScalar(sc);
    m.position.set(x, 0.06, z);
    m.userData.phase = hashStr(`wp${i}`) * Math.PI * 2;
    m.userData.speed = 0.25 + hashStr(`wv${i}`) * 0.3;
    waveGroup.add(m);
  }
  markDecor(waveGroup);
  scene.add(waveGroup);
}

// Islanders-style clouds: flat white unlit slabs drifting high, still casting
// soft moving shadows on the land below.
function buildClouds(cx: number, cz: number, n: number): void {
  cloudsGroup?.removeFromParent();
  cloudsGroup = new THREE.Group();
  // just below pure white: unlit slabs at 1.0 fed the bloom pass and glowed.
  // The material is shared and night-tinted in tick() — paper-white clouds
  // over a midnight sea read as glowing billboards otherwise.
  cloudMat = new THREE.MeshBasicMaterial({
    color: 0xdfe6e2, transparent: true, opacity: 0.92,
  });
  for (let i = 0; i < 7; i += 1) {
    const cluster = new THREE.Group();
    const r = hashStr(`cloud${i}`);
    const slabs = 2 + Math.floor(hashStr(`cs${i}`) * 3);
    for (let b = 0; b < slabs; b += 1) {
      const rb = hashStr(`cloud${i}b${b}`);
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(2.2 + rb * 3.2, 0.45 + rb * 0.35, 1.3 + rb * 1.3), cloudMat);
      slab.position.set(b * 1.5 - slabs * 0.75 + rb, b * 0.4, (rb - 0.5) * 1.8);
      slab.castShadow = true;
      cluster.add(slab);
    }
    // golden-angle scatter with jitter: decorrelated positions, no more
    // clouds marching in a diagonal row (one hash drove x AND z before)
    const a = i * 2.39996 + hashStr(`ca${i}`) * 1.1;
    const rad = n * (0.12 + 0.52 * Math.sqrt((i + hashStr(`crr${i}`)) / 7));
    const sc = 0.7 + hashStr(`csz${i}`) * 0.8;
    cluster.scale.setScalar(sc);
    cluster.position.set(
      cx + Math.cos(a) * rad,
      12.5 + hashStr(`ch${i}`) * 7,
      cz + Math.sin(a) * rad * 0.85,
    );
    cluster.userData.speed = 0.3 + hashStr(`cv${i}`) * 0.45;
    cloudsGroup.add(cluster);
  }
  scene.add(cloudsGroup);
}

// ── props (primitive assemblies, deterministic per node id) ───────────────────
// A palm frond as real geometry: an arched, tapering blade (double-sided strip
// that rises from the crown, arcs outward and droops at the tip).
function frondGeometry(len: number, width: number, droop: number): THREE.BufferGeometry {
  const SEG = 4;
  const verts: number[] = [];
  const centers: [number, number][] = [];
  for (let i = 0; i <= SEG; i += 1) {
    const t = i / SEG;
    const x = len * t;
    const y = Math.sin(t * Math.PI * 0.55) * len * 0.22 - t * t * droop;
    centers.push([x, y]);
  }
  for (let i = 0; i < SEG; i += 1) {
    const w0 = width * (1 - (i / SEG) * 0.85) * 0.5;
    const w1 = width * (1 - ((i + 1) / SEG) * 0.85) * 0.5;
    const [x0, y0] = centers[i];
    const [x1, y1] = centers[i + 1];
    // two triangles per segment, blade lies flat-ish (width along z)
    verts.push(x0, y0, -w0, x1, y1, -w1, x0, y0, w0);
    verts.push(x0, y0, w0, x1, y1, -w1, x1, y1, w1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts), 3));
  geo.computeVertexNormals();
  return geo;
}

function makePalm(id: string): THREE.Group {
  // Curved two-segment trunk + a crown of 7 real arched fronds + coconuts.
  const g = new THREE.Group();
  const r = hashStr(id);
  const h = 1.2 + r * 0.55;
  const lean = (r - 0.5) * 0.5;

  // Trunk as a CONNECTED chain of three tapering segments: each starts exactly
  // where the previous ended, curving progressively (no more disjointed poles).
  const tilts = [lean * 0.35, lean * 0.8, lean * 1.25];
  const lens = [h * 0.4, h * 0.35, h * 0.3];
  const radii: [number, number][] = [[0.075, 0.09], [0.055, 0.075], [0.04, 0.055]];
  let bx = 0, by = 0;
  for (let i = 0; i < 3; i += 1) {
    const t = tilts[i], L = lens[i];
    const dxs = -Math.sin(t) * L, dys = Math.cos(t) * L;
    const seg = new THREE.Mesh(
      new THREE.CylinderGeometry(radii[i][0], radii[i][1], L, 5), lam(C.trunk));
    seg.position.set(bx + dxs / 2, by + dys / 2, 0);
    seg.rotation.z = t;
    seg.castShadow = true;
    g.add(seg);
    bx += dxs; by += dys;
  }
  const topX = bx;
  const crownY = by + 0.02;
  const fronds = 7;
  for (let i = 0; i < fronds; i += 1) {
    const fr = hashStr(id + "f" + i);
    const blade = new THREE.Mesh(
      frondGeometry(0.72 + fr * 0.25, 0.2 + fr * 0.06, 0.5 + fr * 0.25),
      new THREE.MeshLambertMaterial({
        color: jitter(i % 2 ? C.leaf : C.leafDark, id, 0.06),
        flatShading: true, side: THREE.DoubleSide,
      }),
    );
    blade.position.set(topX, crownY, 0);
    blade.rotation.y = (i / fronds) * Math.PI * 2 + r * 2;
    blade.rotation.z = 0.15 + fr * 0.2;            // initial upward tilt, then the arc droops
    blade.castShadow = true;
    g.add(blade);
    // each frond rides the wind on its own phase (animated in tick)
    swayers.push({ m: blade, phase: fr * 17, amp: 0.05 + fr * 0.04, base: blade.rotation.z });
  }
  for (let i = 0; i < 2; i += 1) {
    const nut = new THREE.Mesh(new THREE.SphereGeometry(0.05, 5, 4), lam(0x6d4c2c));
    const a = r * 5 + i * 2.4;
    nut.position.set(topX + Math.cos(a) * 0.09, crownY - 0.06, Math.sin(a) * 0.09);
    g.add(nut);
  }
  return g;
}

function makeFruitTree(id: string): THREE.Group {
  // Fruit trees in three silhouettes — round, stacked-tall, umbrella — so an
  // orchard reads as a mixed stand, not a row of identical lollipops.
  const g = new THREE.Group();
  const r = hashStr(id);
  const v = hashStr(id + "var");
  const h = (0.8 + r * 0.3) * (v > 0.66 ? 0.85 : v > 0.33 ? 1.25 : 1);
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, h, 5), lam(C.trunk));
  trunk.position.y = h / 2;
  trunk.rotation.z = (r - 0.5) * 0.16;
  trunk.castShadow = true;
  g.add(trunk);
  const mat = lamJ(C.leaf, id, 0.07);
  const crowns: THREE.Mesh[] = [];
  if (v > 0.66) {
    // umbrella: one wide flattened crown
    const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5 + r * 0.12, 0), mat);
    crown.position.y = h + 0.14;
    crown.scale.y = 0.55;
    crowns.push(crown);
  } else if (v > 0.33) {
    // stacked: two blobs, big under small — a taller silhouette
    const lo = new THREE.Mesh(new THREE.IcosahedronGeometry(0.36 + r * 0.08, 0), mat);
    lo.position.y = h + 0.05;
    const hi = new THREE.Mesh(new THREE.IcosahedronGeometry(0.24 + r * 0.06, 0), mat);
    hi.position.set((r - 0.5) * 0.14, h + 0.42, (r - 0.5) * 0.1);
    crowns.push(lo, hi);
  } else {
    const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(0.4 + r * 0.1, 0), mat);
    crown.position.y = h + 0.16;
    crown.scale.y = 0.8;
    crowns.push(crown);
  }
  for (const crown of crowns) {
    crown.castShadow = true;
    g.add(crown);
    breathers.push({ m: crown, phase: r * 23, amp: 0.02, base: crown.scale.x });
  }
  for (let i = 0; i < 3; i += 1) {
    const fruit = new THREE.Mesh(new THREE.SphereGeometry(0.045, 5, 4), lam(0xe8842e));
    const a = r * 7 + i * 2.1;
    fruit.position.set(Math.cos(a) * 0.3, h + 0.1 + (i % 2) * 0.18, Math.sin(a) * 0.3);
    g.add(fruit);
  }
  return g;
}

function makeRock(id: string, tint = C.stone): THREE.Group {
  const g = new THREE.Group();
  const r = hashStr(id);
  const rock = new THREE.Mesh(
    new THREE.DodecahedronGeometry(0.2 + r * 0.16, 0),
    new THREE.MeshLambertMaterial({ color: tint, flatShading: true }),
  );
  rock.position.y = 0.12;
  rock.rotation.set(r * 3, r * 7, r * 5);
  rock.scale.y = 0.7;
  rock.castShadow = true;
  g.add(rock);
  return g;
}

function makeBush(id: string): THREE.Group {
  // Bushes in three reads: single mound, three-blob cluster, berry bush.
  const g = new THREE.Group();
  const r = hashStr(id);
  const v = hashStr(id + "var");
  const mat = lamJ(C.bush, id, 0.07);
  if (v > 0.6) {
    for (let i = 0; i < 3; i += 1) {
      const ri = hashStr(id + "b" + i);
      const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(0.12 + ri * 0.09, 0), mat);
      const a = ri * 9 + i * 2.1;
      blob.position.set(Math.cos(a) * 0.13, 0.1 + ri * 0.05, Math.sin(a) * 0.13);
      blob.scale.y = 0.75;
      blob.castShadow = true;
      g.add(blob);
    }
  } else {
    const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22 + r * 0.08, 0), mat);
    bush.position.y = 0.14;
    bush.scale.y = 0.75;
    bush.castShadow = true;
    g.add(bush);
    if (v > 0.3) {
      for (let i = 0; i < 4; i += 1) {
        const a = r * 11 + i * 1.65;
        const berry = new THREE.Mesh(new THREE.SphereGeometry(0.022, 4, 3), lam(0xb2496a));
        berry.position.set(Math.cos(a) * 0.18, 0.15 + (i % 2) * 0.09, Math.sin(a) * 0.18);
        g.add(berry);
      }
    }
  }
  return g;
}

function makePool(): THREE.Group {
  const g = new THREE.Group();
  const rim = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42, 0.46, 0.06, 8),
    new THREE.MeshLambertMaterial({ color: 0x8a7a55, flatShading: true }),
  );
  rim.position.y = 0.03;
  g.add(rim);
  const water = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.34, 0.05, 8),
    new THREE.MeshPhongMaterial({ color: 0x53aabb, shininess: 80 }),
  );
  water.position.y = 0.06;
  g.add(water);
  return g;
}

function buildProps(st: WorldState): void {
  propsGroup?.removeFromParent();
  propsGroup = new THREE.Group();
  swayers = [];
  breathers = [];
  for (const node of st.resources) {
    if (node.quantity <= 0) continue;
    let obj: THREE.Group | null = null;
    const k = node.kind;
    if (k === "wood") obj = makePalm(node.id);
    else if (k === "fruit_tree") obj = makeFruitTree(node.id);
    else if (k === "rocks") obj = makeRock(node.id);
    else if (k === "orerock") obj = makeRock(node.id, 0x7d766c);
    else if (k === "thicket") obj = makeBush(node.id);
    else if (k === "spring" || k === "fishing") obj = makePool();
    else if (k === "shell_bed") obj = makeRock(node.id, 0xe8dcc8);
    if (!obj) continue;
    const wx = node.x + 0.5, wz = node.y + 0.5;
    obj.position.set(wx, Math.max(0.02, heightAt(wx, wz)), wz);
    propsGroup.add(obj);
  }

  // Decorative groves: foliage tiles get purely-visual canopy blobs so forests
  // read as MASSES (references cluster; a lawn with lone lollipops reads cheap).
  const n = st.map.size;
  const canopyMats = Array.from({ length: 6 }, (_, i) => lamJ(0x628f54, `canopy${i}`, 0.1));
  for (let ty = 0; ty < n; ty += 1) {
    for (let tx = 0; tx < n; tx += 1) {
      if (!st.map.grid[ty][tx].includes("foliage")) continue;
      const r = hash01(tx, ty, 91);
      if (r > 0.4) continue;               // sparser, chunkier groves
      const count = r < 0.14 ? 2 : 1;
      for (let k = 0; k < count; k += 1) {
        const ox = hash01(tx, ty, 92 + k) * 0.8 + 0.1;
        const oz = hash01(tx, ty, 95 + k) * 0.8 + 0.1;
        const wx = tx + ox, wz = ty + oz;
        const gy = heightAt(wx, wz);
        if (gy < 0.15) continue;
        const s = 0.3 + hash01(tx, ty, 98 + k) * 0.3;
        const tall = hash01(tx, ty, 102 + k) < 0.22;   // the odd emergent tree
        const stemH = tall ? s * 1.7 : s;
        const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 0),
          canopyMats[(tx * 7 + ty * 13 + k) % 6]);
        blob.position.set(wx, gy + stemH + s * 0.35, wz);
        blob.scale.y = 0.8;
        blob.castShadow = true;
        breathers.push({ m: blob, phase: hash01(tx, ty, 99 + k) * 20, amp: 0.02, base: 1 });
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, stemH, 4), lam(C.trunk));
        stem.position.set(wx, gy + stemH * 0.5, wz);
        propsGroup.add(stem, blob);
        if (tall) {
          const top = new THREE.Mesh(new THREE.IcosahedronGeometry(s * 0.55, 0),
            canopyMats[(tx * 7 + ty * 13 + k + 3) % 6]);
          top.position.set(wx + 0.08, gy + stemH + s * 0.95, wz);
          top.castShadow = true;
          breathers.push({ m: top, phase: hash01(tx, ty, 103 + k) * 20, amp: 0.02, base: 1 });
          propsGroup.add(top);
        }
      }
    }
  }
  scene.add(propsGroup);
}

// ── structures: primitive assemblies per kind (G3.2) ──────────────────────────
const ROLE_COLOR_3D: Record<string, number> = {
  shelter: 0xc4a165, campfire: 0xe2641f, water: 0x4fa3b5, hotspring: 0x5db8c9,
  store: 0xa5824f, salvage: 0x8a8f98, beacon: 0xd8cfae, signal: 0xc0574f,
  escape: 0xd08a4e, workbench: 0x9b7a53, smokehouse: 0x8f6e4e, garden: 0x7fae56,
  lookout: 0xb0946a, signpost: 0xcbb98a, refill_oxygen: 0x7fd0d8, hazard: 0xb0483f,
};
const WOOD = 0xa07848, WOOD_D = 0x7c5a34, CLOTH = 0xd9c69a, CLOTH_D = 0xbfa878;
const METAL = 0x9aa2ab, METAL_D = 0x6e767f, STONEW = 0xb7b0a4;

function box(w: number, h: number, d: number, color: number,
             x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), lam(color));
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

function cyl(rTop: number, rBot: number, h: number, seg: number, color: number,
             x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), lam(color));
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

function cone(r: number, h: number, seg: number, color: number,
              x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), lam(color));
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

// Live fire: three additive cones (orange shell, amber body, pale core) that
// flicker in tick(), plus glowing embers at the base. Registered globally so
// the animation loop can breathe life into every fire on the island.
let flames: THREE.Mesh[] = [];

function makeFire(s: number, y: number): THREE.Group {
  const g = new THREE.Group();
  const layers: [number, number, number, number][] = [
    [0.55, 1.5, 0xff7a2e, 0.75],
    [0.36, 1.15, 0xffb23e, 0.85],
    [0.2, 0.8, 0xffe59a, 0.95],
  ];
  for (const [r, h, colr, op] of layers) {
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(s * r, s * h, 6),
      new THREE.MeshBasicMaterial({
        color: colr, transparent: true, opacity: op,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    cone.position.y = y + s * h * 0.5;
    cone.userData.phase = r * 37;
    cone.userData.baseY = cone.position.y;
    flames.push(cone);
    g.add(cone);
  }
  for (let i = 0; i < 4; i += 1) {                 // embers
    const e = new THREE.Mesh(
      new THREE.SphereGeometry(s * 0.06, 4, 3),
      new THREE.MeshBasicMaterial({
        color: 0xff9a4d, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    const a = i * 1.7;
    e.position.set(Math.cos(a) * s * 0.3, y + s * 0.06, Math.sin(a) * s * 0.3);
    g.add(e);
  }
  markDecor(g);                            // flames never grow an ink outline
  return g;
}

function flameMesh(s: number, y: number): THREE.Group {
  return makeFire(s, y);
}

function makeStructure(s: StructureState): THREE.Group {
  const g = new THREE.Group();
  const st = s.state ?? {};
  const building = st.buildable_kind !== undefined && !st.complete;
  const fp = Math.max(s.w || 1, s.h || 1);        // footprint in tiles
  const lit = Boolean(st.complete) && ((st.fuel as number) ?? 0) > 0;
  const scale = 0.8 + fp * 0.35;                  // applied to the group below

  // Hand-modelled GLB when we have one; k rescales relative to the model's
  // normalised height, and the group scale is pre-divided out so the model
  // keeps its authored absolute size.
  const useModel = (key: string, k = 1): boolean => {
    const mdl = models.get(key);
    if (!mdl) return false;
    const inst = mdl.clone(true);
    inst.scale.multiplyScalar(k / scale);
    g.add(inst);
    return true;
  };

  if (building) {
    // Scaffold: four posts + a crossbar, ghost of the future building inside.
    for (const [px, pz] of [[-0.3, -0.25], [0.3, -0.25], [-0.3, 0.25], [0.3, 0.25]] as const) {
      g.add(cyl(0.025, 0.025, 0.55, 4, WOOD_D, px, 0.27, pz));
    }
    g.add(box(0.75, 0.04, 0.06, WOOD, 0, 0.5, -0.25));
    const ghost = box(0.5, 0.3, 0.4, CLOTH, 0, 0.16, 0);
    (ghost.material as THREE.MeshLambertMaterial).transparent = true;
    (ghost.material as THREE.MeshLambertMaterial).opacity = 0.35;
    g.add(ghost);
    return g;
  }

  switch (s.kind) {
    case "campfire": {
      if (useModel("campfire")) {
        if (lit) g.add(makeFire(0.42, 0.1));
        break;
      }
      // irregular stone ring
      for (let i = 0; i < 7; i += 1) {
        const a = (i / 7) * Math.PI * 2 + 0.4;
        const r = hashStr(`st${i}${s.id}`);
        const stone = new THREE.Mesh(
          new THREE.DodecahedronGeometry(0.055 + r * 0.045, 0), lam(0x8f9296));
        stone.position.set(Math.cos(a) * (0.3 + r * 0.06), 0.05, Math.sin(a) * (0.27 + r * 0.06));
        stone.rotation.set(r * 5, r * 9, r * 3);
        stone.castShadow = true;
        g.add(stone);
      }
      // charred ground + teepee of three leaning logs
      g.add(cyl(0.2, 0.24, 0.04, 7, 0x2e2620, 0, 0.02, 0));
      for (let i = 0; i < 3; i += 1) {
        const log = cyl(0.032, 0.04, 0.4, 5, i % 2 ? WOOD_D : 0x6b4d2e);
        log.position.set(Math.cos(i * 2.1) * 0.08, 0.14, Math.sin(i * 2.1) * 0.08);
        log.rotation.z = 0.9;
        log.rotation.y = i * 2.1;
        log.castShadow = true;
        g.add(log);
      }
      if (lit) g.add(makeFire(0.42, 0.06));
      break;
    }
    case "signal_fire": {
      for (let i = 0; i < 4; i += 1) {
        const log = cyl(0.05, 0.065, 0.85, 5, i % 2 ? WOOD_D : 0x6b4d2e);
        log.position.set(Math.cos(i * 1.57) * 0.16, 0.32, Math.sin(i * 1.57) * 0.16);
        log.rotation.z = 0.5;
        log.rotation.y = i * 1.57 + 0.78;
        log.castShadow = true;
        g.add(log);
      }
      g.add(makeFire(0.75, 0.3));
      break;
    }
    case "tent": case "lean_to": {
      const tent = new THREE.Mesh(new THREE.CylinderGeometry(0, 0.52, 0.62, 4), lam(CLOTH));
      tent.position.y = 0.31;
      tent.rotation.y = Math.PI / 4;
      tent.castShadow = true;
      g.add(tent);
      g.add(box(0.16, 0.26, 0.05, 0x6d4c2c, 0, 0.13, 0.34));   // entrance
      break;
    }
    case "water_still": {
      g.add(cyl(0.3, 0.34, 0.12, 8, 0x8a7a55, 0, 0.06, 0));
      const wtr = cyl(0.24, 0.24, 0.04, 8, 0x53aabb, 0, 0.13, 0);
      (wtr.material as THREE.MeshLambertMaterial).flatShading = false;
      g.add(wtr);
      g.add(cone(0.3, 0.3, 4, CLOTH_D, 0, 0.42, 0));
      break;
    }
    case "well": {
      g.add(cyl(0.28, 0.3, 0.26, 8, STONEW, 0, 0.13, 0));
      g.add(cyl(0.02, 0.02, 0.5, 4, WOOD_D, -0.24, 0.4, 0));
      g.add(cyl(0.02, 0.02, 0.5, 4, WOOD_D, 0.24, 0.4, 0));
      g.add(cone(0.34, 0.22, 4, WOOD, 0, 0.72, 0));
      break;
    }
    case "store": case "storage_crate": case "supply_pile": {
      g.add(box(0.34, 0.34, 0.34, WOOD, -0.2, 0.17, 0.05));
      g.add(box(0.3, 0.3, 0.3, WOOD_D, 0.18, 0.15, -0.08));
      g.add(box(0.28, 0.28, 0.28, WOOD, 0, 0.46, 0));
      break;
    }
    case "workbench": {
      g.add(box(0.7, 0.06, 0.4, WOOD, 0, 0.3, 0));
      g.add(box(0.06, 0.3, 0.06, WOOD_D, -0.28, 0.15, -0.14));
      g.add(box(0.06, 0.3, 0.06, WOOD_D, 0.28, 0.15, 0.14));
      g.add(box(0.14, 0.1, 0.1, METAL, 0.12, 0.38, 0));
      break;
    }
    case "smokehouse": {
      g.add(box(0.5, 0.42, 0.44, WOOD_D, 0, 0.21, 0));
      g.add(cone(0.4, 0.26, 4, 0x6d4c2c, 0, 0.55, 0));
      const puff = new THREE.Mesh(new THREE.SphereGeometry(0.09, 5, 4),
        new THREE.MeshLambertMaterial({ color: 0xcccccc, transparent: true, opacity: 0.5 }));
      puff.position.set(0.06, 0.82, 0);
      markDecor(puff);
      g.add(puff);
      break;
    }
    case "garden": {
      g.add(box(0.8, 0.08, 0.5, 0x8a6a45, 0, 0.04, 0));
      for (let rIdx = 0; rIdx < 2; rIdx += 1)
        for (let i = 0; i < 3; i += 1) {
          g.add(cone(0.06, 0.12, 5, C.bush, -0.25 + i * 0.25, 0.13, -0.12 + rIdx * 0.24));
        }
      break;
    }
    case "signpost": {
      g.add(cyl(0.025, 0.03, 0.6, 5, WOOD_D, 0, 0.3, 0));
      g.add(box(0.4, 0.16, 0.03, WOOD, 0, 0.5, 0.02));
      break;
    }
    case "watchtower": {
      for (const [px, pz] of [[-0.24, -0.24], [0.24, -0.24], [-0.24, 0.24], [0.24, 0.24]] as const) {
        const leg = cyl(0.03, 0.04, 0.85, 4, WOOD_D, px * 0.8, 0.42, pz * 0.8);
        leg.rotation.x = pz > 0 ? -0.12 : 0.12;
        leg.rotation.z = px > 0 ? 0.12 : -0.12;
        g.add(leg);
      }
      g.add(box(0.5, 0.06, 0.5, WOOD, 0, 0.86, 0));
      g.add(box(0.44, 0.16, 0.44, WOOD_D, 0, 0.98, 0));
      g.add(cone(0.4, 0.24, 4, CLOTH_D, 0, 1.2, 0));
      break;
    }
    case "cave": {
      const dome = new THREE.Mesh(new THREE.DodecahedronGeometry(0.55, 0), lam(0x8b867c));
      dome.position.y = 0.28;
      dome.scale.set(1.15, 0.75, 1);
      dome.castShadow = true;
      g.add(dome);
      const mouth = cyl(0.16, 0.2, 0.3, 6, 0x241d16, 0, 0.15, 0.42);
      mouth.rotation.x = Math.PI / 2;
      g.add(mouth);
      break;
    }
    case "hotspring": {
      g.add(cyl(0.42, 0.48, 0.1, 8, 0x8a7a55, 0, 0.05, 0));
      const pool = cyl(0.34, 0.34, 0.05, 8, 0x5db8c9, 0, 0.11, 0);
      (pool.material as THREE.MeshLambertMaterial).flatShading = false;
      g.add(pool);
      for (let i = 0; i < 3; i += 1) {
        const steam = new THREE.Mesh(new THREE.SphereGeometry(0.07 - i * 0.015, 5, 4),
          new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 - i * 0.08 }));
        steam.position.set(0.1 - i * 0.08, 0.3 + i * 0.2, 0);
        markDecor(steam);
        g.add(steam);
      }
      break;
    }
    case "lighthouse": {
      if (useModel("lighthouse")) {
        if (st.active) {
          const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16 / scale, 8, 6),
            new THREE.MeshBasicMaterial({ color: 0xffd166 }));
          lamp.position.y = 2.82 / scale;
          markDecor(lamp);                 // pure glow, no outline
          g.add(lamp);
        }
        break;
      }
      const bands = 4;
      for (let i = 0; i < bands; i += 1) {
        const t = i / bands;
        const rB = 0.34 - t * 0.1, rT = 0.34 - (i + 1) / bands * 0.1;
        g.add(cyl(rT, rB, 0.42, 8, i % 2 ? 0xb8574e : 0xd8d2c4, 0, 0.21 + i * 0.42, 0));
      }
      const lampOn = Boolean(st.active);
      const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.22, 8),
        lampOn ? new THREE.MeshBasicMaterial({ color: 0xffd166 }) : lam(0x3d4650));
      lamp.position.y = bands * 0.42 + 0.11;
      g.add(lamp);
      g.add(cone(0.24, 0.2, 8, METAL_D, 0, bands * 0.42 + 0.32, 0));
      break;
    }
    case "radiotower": {
      for (const a of [0, 2.09, 4.19]) {
        const leg = cyl(0.02, 0.03, 1.5, 4, METAL_D, Math.cos(a) * 0.22, 0.75, Math.sin(a) * 0.22);
        leg.rotation.x = Math.sin(a) * -0.15;
        leg.rotation.z = Math.cos(a) * 0.15;
        g.add(leg);
      }
      for (let i = 1; i <= 3; i += 1) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.2 * (1 - i * 0.22), 0.012, 4, 6), lam(METAL));
        ring.rotation.x = Math.PI / 2;
        ring.position.y = i * 0.38;
        g.add(ring);
      }
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.05, 5, 4),
        new THREE.MeshBasicMaterial({ color: 0xc0574f }));
      tip.position.y = 1.56;
      g.add(tip);
      break;
    }
    case "plane_wreckage": {
      const body = cyl(0.16, 0.2, 1.3, 7, METAL, 0, 0.2, 0);
      body.rotation.z = Math.PI / 2;
      body.rotation.y = 0.4;
      g.add(body);
      const wing = box(0.9, 0.04, 0.26, METAL_D, -0.3, 0.3, 0.3);
      wing.rotation.y = 0.9;
      wing.rotation.z = 0.25;
      g.add(wing);
      const tail = box(0.3, 0.3, 0.05, METAL_D, 0.62, 0.4, -0.2);
      tail.rotation.y = 0.4;
      g.add(tail);
      break;
    }
    case "monolith": {
      const m = box(0.26, 0.9, 0.16, 0x3a3f4a, 0, 0.45, 0);
      m.rotation.y = 0.4;
      m.rotation.z = 0.05;
      g.add(m);
      break;
    }
    case "idol": {
      g.add(cyl(0.14, 0.18, 0.55, 6, WOOD_D, 0, 0.28, 0));
      g.add(box(0.26, 0.2, 0.2, WOOD, 0, 0.66, 0));
      break;
    }
    case "hatch": {
      if (useModel("bunker", 0.8)) break;
      g.add(cyl(0.3, 0.34, 0.08, 8, METAL_D, 0, 0.04, 0));
      const btn = new THREE.Mesh(new THREE.SphereGeometry(0.04, 5, 4),
        new THREE.MeshBasicMaterial({ color: 0xc0574f }));
      btn.position.set(0.14, 0.1, 0);
      g.add(btn);
      break;
    }
    // ── mars kinds: no more default-box placeholders ──────────────────────────
    case "sealed_bunker": {
      if (useModel("bunker", 1.4)) break;
      g.add(box(0.8, 0.55, 0.7, 0x8d9295, 0, 0.28, 0));
      g.add(box(0.3, 0.4, 0.06, 0x4b5257, 0, 0.2, 0.36));   // sealed door
      g.add(cyl(0.03, 0.03, 0.5, 4, METAL_D, 0.32, 0.8, -0.2));
      break;
    }
    case "oxygen_generator": {
      g.add(cyl(0.22, 0.26, 0.5, 8, METAL, 0, 0.25, 0));
      for (const sx of [-0.3, 0.3]) {
        const tank = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.2, 3, 8), lam(0x7fd0d8));
        tank.position.set(sx, 0.24, 0.05);
        tank.castShadow = true;
        g.add(tank);
      }
      g.add(cone(0.1, 0.18, 6, METAL_D, 0, 0.6, 0));
      const vent = new THREE.Mesh(new THREE.SphereGeometry(0.05, 5, 4),
        new THREE.MeshBasicMaterial({ color: 0x9fe8ef, transparent: true, opacity: 0.6 }));
      vent.position.set(0, 0.78, 0);
      markDecor(vent);
      g.add(vent);
      break;
    }
    case "shuttle_wreckage": {
      const hull = cyl(0.14, 0.3, 1.2, 8, METAL, 0, 0.34, 0);
      hull.rotation.z = 1.15;                               // nose buried, tail up
      hull.rotation.y = 0.5;
      g.add(hull);
      const fin = box(0.05, 0.4, 0.26, 0xc0574f, -0.42, 0.62, -0.1);
      fin.rotation.z = 0.5;
      g.add(fin);
      g.add(box(0.7, 0.05, 0.24, METAL_D, 0.3, 0.1, 0.3));  // torn wing on the ground
      for (let i = 0; i < 3; i += 1) {
        const r = hashStr(`${s.id}d${i}`);
        const deb = new THREE.Mesh(new THREE.DodecahedronGeometry(0.07 + r * 0.06, 0), lam(METAL_D));
        deb.position.set(Math.cos(r * 9) * 0.5, 0.06, Math.sin(r * 9) * 0.5);
        g.add(deb);
      }
      break;
    }
    case "habitat_dome": {
      const dome = new THREE.Mesh(
        new THREE.SphereGeometry(0.55, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.5),
        new THREE.MeshLambertMaterial({ color: 0xd8d2c4, flatShading: true }));
      dome.castShadow = true;
      g.add(dome);
      const airlock = box(0.26, 0.24, 0.34, METAL, 0, 0.12, 0.6);
      g.add(airlock);
      g.add(cyl(0.02, 0.02, 0.4, 4, METAL_D, -0.3, 0.75, -0.2));  // antenna
      break;
    }
    case "distress_pod": {
      const pod = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.4, 3, 8), lam(0xd8d2c4));
      pod.rotation.z = Math.PI / 2 - 0.2;                   // crashed on its side
      pod.position.y = 0.18;
      pod.castShadow = true;
      g.add(pod);
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.05, 5, 4),
        new THREE.MeshBasicMaterial({ color: 0xff5040 }));
      beacon.position.set(0.3, 0.42, 0);
      markDecor(beacon);
      g.add(beacon);
      break;
    }
    case "anomaly": {
      const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.22, 0),
        new THREE.MeshLambertMaterial({ color: 0x2b2440, emissive: 0x5a3f8a, emissiveIntensity: 0.6 }));
      core.position.y = 0.55;                               // hovers — clearly unnatural
      core.rotation.set(0.4, 0.8, 0.2);
      g.add(core);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.02, 4, 18),
        new THREE.MeshBasicMaterial({ color: 0x9a7fb8, transparent: true, opacity: 0.5 }));
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.55;
      markDecor(ring);
      g.add(ring);
      break;
    }
    case "hazard_zone": {
      g.add(cyl(0.55, 0.6, 0.03, 9, 0x4a4038, 0, 0.015, 0));   // scorched ground
      for (let i = 0; i < 3; i += 1) {
        const a = i * 2.1 + 0.5;
        const post = cyl(0.025, 0.03, 0.4, 5, i % 2 ? 0xc0574f : 0xd8d2c4,
          Math.cos(a) * 0.45, 0.2, Math.sin(a) * 0.45);
        post.rotation.z = (hashStr(`${s.id}p${i}`) - 0.5) * 0.3;
        g.add(post);
      }
      const haze = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 6),
        new THREE.MeshLambertMaterial({ color: 0x9fd870, transparent: true, opacity: 0.16 }));
      haze.position.y = 0.3;
      markDecor(haze);
      g.add(haze);
      break;
    }
    case "whisperzone": {
      for (let i = 1; i <= 3; i += 1) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.18 * i, 0.015, 4, 12),
          new THREE.MeshLambertMaterial({ color: 0x9a7fb8, transparent: true, opacity: 0.6 - i * 0.12 }));
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.03;
        g.add(ring);
      }
      break;
    }
    case "relic": {
      const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), lam(0x67e0c4));
      gem.position.y = 0.3;
      g.add(gem);
      break;
    }
    default: {
      const w = fp * 0.55, hgt = 0.4 + Math.min(1.2, fp * 0.3);
      g.add(box(w, hgt, w * 0.8, ROLE_COLOR_3D[s.role] ?? 0x9a8f7a, 0, hgt / 2, 0));
    }
  }
  g.traverse((o) => { o.receiveShadow = true; });
  // Bigger footprints scale their assembly up (models pre-divided this out).
  g.scale.set(scale, scale, scale);
  return g;
}

function buildStructs(st: WorldState): void {
  structsGroup?.removeFromParent();
  for (const l of fireLights) l.removeFromParent();
  fireLights = [];
  flames = [];
  structsGroup = new THREE.Group();
  for (const s of st.structures) {
    const obj = makeStructure(s);
    const wx = s.x + 0.5, wz = s.y + 0.5;
    const gy = Math.max(0.02, heightAt(wx, wz));
    obj.position.set(wx, gy, wz);
    obj.userData.structId = s.id;
    structsGroup.add(obj);

    // Lit campfires and active beacons cast real light — the night payoff.
    const lit = (s.role === "campfire" && s.state?.complete && ((s.state?.fuel as number) ?? 0) > 0)
      || (s.role === "signal" && s.kind === "signal_fire")
      || (s.role === "beacon" && s.state?.active);
    if (lit) {
      const pl = new THREE.PointLight(C.flame, 6, 9, 1.6);
      pl.position.set(wx, gy + 0.8, wz);
      scene.add(pl);
      fireLights.push(pl);
    }
  }
  scene.add(structsGroup);
}

// ── survivors (3D meeples) ────────────────────────────────────────────────────
function makeMeeple3d(a: AgentState): THREE.Group {
  // A character, not a bollard: tapered body, skin-tone head with EYES, swinging
  // arms, hair by gender/hash, a small backpack. The group faces +z (movement
  // direction via rotation.y), so the face reads as the front.
  const hue = agentHue(a.id);
  const r = hashStr(a.id + a.name);
  const bodyColor = hslToRgbInt(hue, 62, 52);
  const bodyDark = hslToRgbInt(hue, 62, 38);
  const skin = 0xe8c39a;
  const g = new THREE.Group();

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.16, 0.4, 8), lam(bodyColor));
  body.position.y = 0.28;
  body.castShadow = true;
  g.add(body);
  // legs: two stubs under the body
  for (const sx of [-0.06, 0.06]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.14, 6), lam(bodyDark));
    leg.position.set(sx, 0.07, 0);
    g.add(leg);
  }
  // arms: hang from the shoulders, swing while walking (refs in userData)
  const arms: THREE.Mesh[] = [];
  for (const sx of [-0.16, 0.16]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 0.2, 2, 6), lam(bodyColor));
    arm.position.set(sx, 0.42, 0);
    arm.geometry.translate(0, -0.1, 0);        // pivot at the shoulder
    arm.castShadow = true;
    g.add(arm);
    arms.push(arm);
  }
  g.userData.arms = arms;

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.125, 10, 8), lam(skin));
  head.position.y = 0.62;
  head.castShadow = true;
  g.add(head);
  // eyes: two dark dots on the front — the single biggest "alive" cue
  for (const sx of [-0.05, 0.05]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.018, 5, 4),
      new THREE.MeshBasicMaterial({ color: 0x2a2118 }));
    eye.position.set(sx, 0.645, 0.115);
    g.add(eye);
  }
  // hair: women get a bun; men get a cap or stay bald (hashed)
  const hairColor = r < 0.33 ? 0x3a2a1c : r < 0.66 ? 0x6d4c2c : 0x1e1a16;
  if (a.gender === "female") {
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), lam(hairColor));
    hair.position.set(0, 0.655, -0.025);
    hair.scale.set(1, 0.8, 0.95);
    g.add(hair);
    const bun = new THREE.Mesh(new THREE.SphereGeometry(0.055, 6, 5), lam(hairColor));
    bun.position.set(0, 0.72, -0.12);
    g.add(bun);
  } else if (r > 0.45) {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6,
      0, Math.PI * 2, 0, Math.PI * 0.45), lam(bodyDark));
    cap.position.y = 0.665;
    g.add(cap);
  }
  // backpack: a small contrasting cube on the back
  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.18, 0.08), lam(0x8a6f4c));
  pack.position.set(0, 0.36, -0.15);
  g.add(pack);
  return g;
}

function syncAgents3d(st: WorldState): void {
  const seen = new Set<string>();
  // Agents sharing a tile fan out around its centre (deterministic order by
  // id) so meeples never merge into one another while chatting face to face.
  const byTile = new Map<string, string[]>();
  for (const a of st.agents) {
    const key = `${a.x},${a.y}`;
    const list = byTile.get(key) ?? [];
    list.push(a.id);
    byTile.set(key, list);
  }
  for (const list of byTile.values()) list.sort();
  for (const a of st.agents) {
    seen.add(a.id);
    let v = agents3d.get(a.id);
    let tx = a.x + 0.5, tz = a.y + 0.5;
    const mates = byTile.get(`${a.x},${a.y}`)!;
    if (mates.length > 1) {
      const i = mates.indexOf(a.id);
      const ang = (i / mates.length) * Math.PI * 2 + hashStr(`${a.x},${a.y}`) * 6.28;
      const rad = mates.length === 2 ? 0.17 : 0.26;
      tx += Math.cos(ang) * rad;
      tz += Math.sin(ang) * rad;
    }
    if (!v) {
      const group = makeMeeple3d(a);
      group.position.set(tx, Math.max(0.02, heightAt(tx, tz)), tz);
      group.userData.agentId = a.id;
      scene.add(group);
      v = { group, x: tx, z: tz, tx, tz, status: a.status };
      agents3d.set(a.id, v);
    }
    v.tx = tx; v.tz = tz;
    v.status = a.status;
    // death pose: keel over and dim
    const dead = a.status === "dead";
    v.group.rotation.z = dead ? Math.PI / 2 : a.status === "incapacitated" ? Math.PI / 4 : 0;
    v.group.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshLambertMaterial | undefined;
      if (m && "opacity" in m) { m.transparent = dead; m.opacity = dead ? 0.6 : 1; }
    });
  }
  for (const [id, v] of agents3d) {
    if (!seen.has(id)) {
      v.group.removeFromParent();
      agents3d.delete(id);
    }
  }
}

// ── public API ────────────────────────────────────────────────────────────────
export function sync3d(st: WorldState, stageEl: HTMLElement): void {
  ensureRenderer(stageEl);
  state = st;
  const mapKey = `${st.scenario}:${st.map.size}`;
  if (mapKey !== builtMapKey) {
    builtMapKey = mapKey;
    buildTerrain(st);
    for (const [, v] of agents3d) v.group.removeFromParent();
    agents3d.clear();
  }
  buildProps(st);
  buildStructs(st);
  syncAgents3d(st);
  setActive3d(true);
}

export function setActive3d(on: boolean): void {
  if (on === active) { if (on && renderer) renderer.domElement.style.display = ""; return; }
  active = on;
  if (renderer) renderer.domElement.style.display = on ? "" : "none";
  if (on) {
    const loop = () => {
      if (!active || !renderer) return;
      rafId = requestAnimationFrame(loop);
      tick();
    };
    loop();
  } else {
    cancelAnimationFrame(rafId);
  }
}

export function invalidate3d(): void {
  builtMapKey = "";
}

/** Screen position of an agent's head (for the HTML name/bubble overlay). */
export function agentScreen3d(id: string): { x: number; y: number } | null {
  if (!renderer || !active) return null;
  const v = agents3d.get(id);
  if (!v) return null;
  const p = new THREE.Vector3(v.x, v.group.position.y + 0.95, v.z);
  p.project(camera);
  if (p.z > 1) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  return {
    x: (p.x * 0.5 + 0.5) * rect.width,
    y: (-p.y * 0.5 + 0.5) * rect.height,
  };
}

// ── per-frame ─────────────────────────────────────────────────────────────────
const dayFog = new THREE.Color(C.skyDay);
const nightFog = new THREE.Color(C.skyNight);
const skyTopDay = new THREE.Color(0x8ecfe0);
const skyTopNight = new THREE.Color(0x0a1526);
const skyHorDay = new THREE.Color(0xf4ead2);       // golden-cream horizon
const skyHorNight = new THREE.Color(0x24364e);
const stormGrey = new THREE.Color(0x8f9aa0);
const tmpColor = new THREE.Color();
const clock = new THREE.Clock();

function tick(): void {
  if (!renderer || !state) return;
  const dt = Math.min(0.1, clock.getDelta());
  // resize to stage
  const el = renderer.domElement.parentElement;
  if (el) {
    const w = el.clientWidth, h = el.clientHeight;
    const cur = renderer.getSize(new THREE.Vector2());
    if (Math.abs(cur.x - w) > 1 || Math.abs(cur.y - h) > 1) {
      const pr = Math.min(2, window.devicePixelRatio || 1);
      renderer.setSize(w, h, false);
      renderer.setPixelRatio(pr);
      composer.setSize(w, h);
      composer.setPixelRatio(pr);
      (fxaaPass.material.uniforms.resolution.value as THREE.Vector2)
        .set(1 / (w * pr), 1 / (h * pr));
      (gradePass.uniforms.uRes.value as THREE.Vector2).set(w * pr, h * pr);
      (kuwaharaPass.uniforms.uRes.value as THREE.Vector2).set(w * pr, h * pr);
      inkTarget?.setSize(Math.max(1, Math.round(w * pr)), Math.max(1, Math.round(h * pr)));
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    }
  }

  // agent movement lerp (constant-ish speed toward target)
  for (const v of agents3d.values()) {
    const dx = v.tx - v.x, dz = v.tz - v.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.002) {
      const step = Math.min(dist, 0.06 + dist * 0.06);
      v.x += (dx / dist) * step;
      v.z += (dz / dist) * step;
    }
    const walking = dist > 0.05;
    const bob = walking ? Math.abs(Math.sin(performance.now() / 90)) * 0.05 : 0;
    v.group.position.set(v.x, Math.max(0.02, heightAt(v.x, v.z)) + bob, v.z);
    if (walking) v.group.rotation.y = Math.atan2(dx, dz);
    // arm swing while walking, relaxed at rest
    const arms = v.group.userData.arms as THREE.Mesh[] | undefined;
    if (arms) {
      const swing = walking ? Math.sin(performance.now() / 100) * 0.7 : 0;
      arms[0].rotation.x = swing;
      arms[1].rotation.x = -swing;
    }
  }

  // day/night: real lighting, not an overlay (time-based, frame-rate agnostic)
  const targetNight = state.is_night ? 1 : 0;
  nightMix += (targetNight - nightMix) * Math.min(1, dt * 1.6);
  sun.intensity = (1.9 - nightMix * 1.68) * (1 - stormMix * 0.35);
  ambient.intensity = 0.85 - nightMix * 0.5;
  tmpColor.copy(dayFog).lerp(nightFog, nightMix);
  tmpColor.lerp(stormGrey, stormMix * 0.5);
  (scene.background as THREE.Color).copy(tmpColor);
  scene.fog!.color.copy(tmpColor);
  if (skyMat) {
    (skyMat.uniforms.uTop.value as THREE.Color)
      .copy(skyTopDay).lerp(skyTopNight, nightMix).lerp(stormGrey, stormMix * 0.4);
    (skyMat.uniforms.uHor.value as THREE.Color)
      .copy(skyHorDay).lerp(skyHorNight, nightMix).lerp(stormGrey, stormMix * 0.55);
  }
  sun.color.setHSL(0.09, 0.5, 0.9 - nightMix * 0.25);
  for (const l of fireLights) {
    l.intensity = (4.5 + Math.sin(performance.now() / 120) * 1.2) * (0.4 + nightMix * 0.9);
  }

  // selection halo follows the selected agent
  const sel = store.selectedAgentId ? agents3d.get(store.selectedAgentId) : null;
  if (sel) {
    selRing.visible = true;
    selRing.position.set(sel.x, sel.group.position.y + 0.03, sel.z);
  } else {
    selRing.visible = false;
  }

  // CINEMATIC FOLLOW: while an agent is selected the camera tracks them —
  // orbit target glides onto the meeple (camera moves in parallel, so the
  // user's orbit angle and zoom are preserved), with a one-shot dolly-in and
  // a telephoto squeeze for the film look. Click open water to break free.
  if (store.selectedAgentId !== followId) {
    followId = store.selectedAgentId;
    followDollyT = followId ? 0 : 1e9;
  }
  if (sel) {
    followDollyT += dt;
    followGoal.set(sel.x, sel.group.position.y + 0.35, sel.z);
    followDelta.copy(followGoal).sub(controls.target);
    const k = Math.min(1, dt * 3.2);
    controls.target.addScaledVector(followDelta, k);
    camera.position.addScaledVector(followDelta, k);
    if (followDollyT < 1.5) {                       // approach, then hands off
      followDelta.copy(camera.position).sub(controls.target);
      const len = followDelta.length();
      const want = Math.min(len, 11);
      const nl = len + (want - len) * Math.min(1, dt * 2.2);
      camera.position.copy(controls.target).addScaledVector(followDelta.normalize(), nl);
    }
  }
  const wantFov = sel ? 24 : 32;                    // telephoto while following
  if (Math.abs(camera.fov - wantFov) > 0.05) {
    camera.fov += (wantFov - camera.fov) * Math.min(1, dt * 2.5);
    camera.updateProjectionMatrix();
  }

  // atmosphere: waves, drifting clouds, breathing foam, storm front
  const now = performance.now() / 1000;
  const storm = state.weather === "storm" ? 1 : 0;
  stormMix += (storm - stormMix) * Math.min(1, dt * 1.2);
  if (waterShader) {
    waterShader.uniforms.uTime.value = now;
    waterShader.uniforms.uAmp.value = 0.03 + stormMix * 0.1;
  }
  if (foamMat) foamMat.opacity = 0.42 + Math.sin(now * 1.7) * 0.14;
  // living fire: each flame layer breathes on its own phase
  for (const f of flames) {
    const ph = f.userData.phase as number;
    f.scale.x = f.scale.z = 1 + Math.sin(now * 9 + ph) * 0.1;
    f.scale.y = 1 + Math.sin(now * 13 + ph * 1.3) * 0.22;
    f.position.y = (f.userData.baseY as number) * f.scale.y;
    f.rotation.y = now * 1.4 + ph;
  }
  if (cloudsGroup && state) {
    const n = state.map.size;
    for (const cl of cloudsGroup.children) {
      cl.position.x += (cl.userData.speed as number) * dt * (1 + stormMix * 2.5);
      if (cl.position.x > n / 2 + n) {
        cl.position.x = n / 2 - n;
        cl.position.z = n / 2 + (Math.random() - 0.5) * n * 1.1;   // fresh lane
        cl.position.y = 12.5 + Math.random() * 7;
      }
    }
  }
  if (cloudMat) {
    cloudMat.color.setHex(0xdfe6e2).lerp(new THREE.Color(0x39485a), nightMix)
      .lerp(stormGrey, stormMix * 0.5);
    cloudMat.opacity = 0.92 - nightMix * 0.18;
  }

  // painted water drifts; the shimmer layer counter-scrolls for parallax depth
  if (waterTexA) { waterTexA.offset.x = now * 0.0045; waterTexA.offset.y = now * 0.0016; }
  if (shimmerMat && shimmerMat.map) {
    shimmerMat.map.offset.x = -now * 0.003;
    shimmerMat.map.offset.y = now * 0.0022;
    shimmerMat.opacity = 0.10 - nightMix * 0.05 + stormMix * 0.04;
  }

  // wind: fronds swing, canopies breathe — faster and wider in a storm
  const wind = 1 + stormMix * 2.2;
  const windT = now * (1.5 + stormMix * 1.2);
  for (const sw of swayers) {
    sw.m.rotation.z = sw.base + Math.sin(windT + sw.phase) * sw.amp * wind;
  }
  for (const b of breathers) {
    const k = 1 + Math.sin(now * 1.1 + b.phase) * b.amp * wind;
    b.m.scale.x = b.base * k;
    b.m.scale.z = b.base * (2 - k);
  }

  // painted wave dashes surface, hold, and sink on their own phases
  if (waveGroup) {
    for (const w of waveGroup.children) {
      const t = now * (w.userData.speed as number) + (w.userData.phase as number);
      const vis = Math.max(0, Math.sin(t));
      const mat = (w as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.opacity = vis * vis * (0.5 + stormMix * 0.3);
    }
  }

  const fog = scene.fog as THREE.Fog;
  fog.near = 70 - stormMix * 35;
  fog.far = 210 - stormMix * 90;
  if (gradePass) {
    gradePass.uniforms.uTime.value = now;
    (gradePass.uniforms.uInvVP.value as THREE.Matrix4)
      .multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
    (gradePass.uniforms.uCamPos.value as THREE.Vector3).copy(camera.position);
    camera.getWorldDirection(gradePass.uniforms.uCamFwd.value as THREE.Vector3);
  }

  controls.update();

  // ink prepass: solids only (layer 0), one override material, into the
  // half-float normals+depth target the grade shader reads. Shadow updates
  // are deferred to the main render so they aren't paid twice per frame.
  if (inkTarget && inkMat) {
    renderer.shadowMap.autoUpdate = false;
    const oldBg = scene.background;
    scene.background = null;
    scene.overrideMaterial = inkMat;
    camera.layers.set(0);
    renderer.setRenderTarget(inkTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    scene.overrideMaterial = null;
    scene.background = oldBg;
    camera.layers.set(0);
    camera.layers.enable(1);
    renderer.shadowMap.autoUpdate = true;
  }

  composer.render();
}
