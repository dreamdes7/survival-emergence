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
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { AgentState, StructureState, WorldState } from "./types";
import { agentHue, hslToRgbInt } from "./utils";
import { store } from "./store";
import { gfx, FILM_PROFILES, WORLD_PALETTES, onPaletteChange } from "./gfx";

// The active world palette — island material colours (see gfx.WORLD_PALETTES).
function pal() {
  return WORLD_PALETTES[gfx.palette] ?? WORLD_PALETTES.lagoon;
}
// A palette switch rebuilds the island IMMEDIATELY from the cached state —
// waiting for the next sim tick meant a paused world never showed the new
// colours at all. Falls back to invalidation when no world is built yet.
onPaletteChange(() => {
  invalidate3d();
  if (state && renderer) {
    buildTerrain(state);
    buildProps(state, true);
    buildStructs(state, true);
    buildGrass(state);
    builtMapKey = `${state.scenario}:${state.map.size}`;
  }
});
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
    uStorm: { value: 0 },
    // style knobs (driven from gfx / presets)
    uInkAmt: { value: 0.85 },
    uInkWidth: { value: 0.0 },
    uInkMode: { value: 0.0 },   // 0 = all edges (creases+silhouette), 1 = silhouette only
    uComic: { value: 0.0 },
    uPosterLevels: { value: 6.0 },
    uPosterAmt: { value: 0.13 },
    uHalftone: { value: 0.0 },
    uHalftoneScale: { value: 5.0 },
    uSat: { value: 1.14 },
    uPaperAmt: { value: 1.0 },
    uVignette: { value: 0.14 },
    uBarrel: { value: 0.0 },
    uSepia: { value: 0.0 },
    uFlicker: { value: 0.0 },
    uWeave: { value: 0.0 },
    uHiTint: { value: new THREE.Color(1, 1, 1) },      // time-of-day colour script
    uShadowTint: { value: new THREE.Color(1, 1, 1) },
    // film stock emulation
    uFilm: { value: 0 }, uFilmContrast: { value: 1 }, uFilmSCurve: { value: 0 },
    uFilmToe: { value: 0 }, uFilmShoulder: { value: 0 }, uFilmSat: { value: 1 },
    uFilmHalo: { value: 0 }, uFilmGrain: { value: 0 },
    uFilmShadow: { value: new THREE.Color(1, 1, 1) },
    uFilmHigh: { value: new THREE.Color(1, 1, 1) },
    uFilmHaloTint: { value: new THREE.Color(1, 1, 1) },
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
    uniform float uStorm;
    uniform float uInkAmt, uInkWidth, uInkMode, uComic, uPosterLevels, uPosterAmt;
    uniform float uHalftone, uHalftoneScale, uSat, uPaperAmt, uVignette, uBarrel;
    uniform float uSepia, uFlicker, uWeave;
    uniform vec3 uHiTint, uShadowTint;
    uniform float uFilm, uFilmContrast, uFilmSCurve, uFilmToe, uFilmShoulder, uFilmSat, uFilmHalo, uFilmGrain;
    uniform vec3 uFilmShadow, uFilmHigh, uFilmHaloTint;
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

      // lens barrel: gently bow the image toward the edges, as if seen through
      // glass (optics look). Zero = flat. Feeds every downstream sample.
      vec2 cc = vUv - 0.5;
      vec2 bUv = vUv + cc * dot(cc, cc) * uBarrel;
      // projector GATE WEAVE: the whole frame drifts a hair, like film sliding in
      // an old gate. Tiny + slow so it reads as age, not the swim we avoid.
      bUv += vec2(sin(uTime * 2.3) * 0.6 + sin(uTime * 5.1) * 0.4,
                  sin(uTime * 1.7 + 1.0) * 0.6 + cos(uTime * 3.3) * 0.3)
             * uWeave * 0.0016;

      // hand tremor: the paper's smooth field (G channel) nudges every sample,
      // so straight CG edges come out gently hand-wavy. STATIC — an animated
      // wobble makes the whole frame swim without reading as art.
      float wA = texture2D(uPaper, bUv * asp * 1.35).g;
      float wB = texture2D(uPaper, bUv * asp * 1.35 + vec2(0.31, 0.47)).g;
      vec2 uv = bUv + (vec2(wA, wB) - 0.5) * (2.0 / uRes);
      vec4 c = texture2D(tDiffuse, uv);

      // WET-ON-WET colour bleed: a whisper of the neighbouring wash creeps in, so
      // colour boundaries soften like wet paint. Tiny, and only in painterly
      // presets (scaled by paper), so comic stays crisp and flat.
      vec2 bl = 1.6 / uRes;
      vec3 nbr = texture2D(tDiffuse, uv + vec2(bl.x, 0.0)).rgb
               + texture2D(tDiffuse, uv - vec2(bl.x, 0.0)).rgb
               + texture2D(tDiffuse, uv + vec2(0.0, bl.y)).rgb
               + texture2D(tDiffuse, uv - vec2(0.0, bl.y)).rgb;
      c.rgb = mix(c.rgb, nbr * 0.25, 0.12 * uPaperAmt);

      // INK LINE from the normals+depth prepass: Roberts cross over view-space
      // normals (creases, silhouettes) + relative depth jumps (overlaps).
      // Only this line boils: its wobble field re-rolls at 6 fps, so the
      // contour is alive the way a hand-drawn line is, while fills hold still.
      float t6 = floor(uTime * 6.0) / 6.0;
      vec2 roll = vec2(hash(vec2(t6, 3.1)), hash(vec2(t6, 7.7))) * 0.5;
      // boil amplitude: kept small so the contour reads as a steady hand-drawn
      // line with a hint of life, not a crawling wobble (was 3.0 — too much once
      // the rest of the frame is super-sampled crisp).
      vec2 bo = (vec2(texture2D(uPaper, uv * asp * 2.2 + roll).g,
                      texture2D(uPaper, uv * asp * 2.2 + roll + vec2(0.53, 0.29)).g)
                 - 0.5) * (1.3 / uRes);
      vec2 iuv = uv + bo;
      vec2 ip = (1.9 + uInkWidth * 2.2) / uRes;    // wider cross = bolder line
      vec4 s0 = texture2D(uInk, iuv + vec2(-ip.x, -ip.y));
      vec4 s1 = texture2D(uInk, iuv + vec2( ip.x,  ip.y));
      vec4 s2 = texture2D(uInk, iuv + vec2( ip.x, -ip.y));
      vec4 s3 = texture2D(uInk, iuv + vec2(-ip.x,  ip.y));
      float far0 = 400.0;
      float d0 = s0.a <= 0.0 ? far0 : s0.a, d1 = s1.a <= 0.0 ? far0 : s1.a;
      float d2 = s2.a <= 0.0 ? far0 : s2.a, d3 = s3.a <= 0.0 ? far0 : s3.a;
      float dn = length(s0.xyz - s1.xyz) + length(s2.xyz - s3.xyz);
      float dmin = min(min(d0, d1), min(d2, d3));
      // CLAMP the normalisation (not just floor it): a purely relative threshold
      // (/dmin) makes distant objects need a proportionally huge depth jump, so
      // their outlines fade with distance. Capping dmin at 28 keeps far silhouettes
      // detectable while the floor of 4 still stops near objects over-triggering.
      float dd = (abs(d0 - d1) + abs(d2 - d3)) / clamp(dmin, 4.0, 28.0);
      // ALL-EDGES: normal creases (every interior facet) + depth overlaps.
      float allEdges = smoothstep(0.5, 1.1, dn) * 0.55 + smoothstep(0.030, 0.10, dd) * 0.6;
      // SILHOUETTE: a depth step that COINCIDES with a normal change. This is a
      // true object boundary — the near surface faces one way, whatever's behind
      // faces another. It fires on object outlines, overlaps, and terrace lips
      // (flat top vs vertical face), but NOT on flat receding ground (depth ramp,
      // constant normal) or interior facet creases (sharp normal, no depth step).
      // Thresholds are lowered so small props (rocks, reeds) and distant/weakly-
      // separated boundaries register, while the normal gate still rejects flat
      // ground (constant normal) and the crush of interior facets (no depth step).
      float depthStep   = smoothstep(0.006, 0.03, dd);
      float normalBound = smoothstep(0.22, 0.60, dn);
      float silhouette  = depthStep * normalBound * 1.7;
      float ink = min(mix(allEdges, silhouette, uInkMode), 1.0);
      // COLOURED ink: the line is a darker, slightly cool shade of the LOCAL
      // colour (hue kept) rather than pigment-squared toward black — a red
      // flower gets a dark-red edge, foliage a deep-green one. The old pigment
      // equation crushed small/dark props to near-black, which read as a plain
      // black marker. *0.4 keeps enough chroma that the hue still shows.
      vec3 inkTint = c.rgb * 0.4;
      inkTint *= mix(vec3(1.0), vec3(0.9, 0.98, 1.1), 0.5);   // faint cool cast
      c.rgb = mix(c.rgb, inkTint, min(ink * uInkAmt, 1.0));
      // comic mode still lays a SOLID confident near-black outline over the paint
      c.rgb = mix(c.rgb, vec3(0.05, 0.06, 0.09), clamp(ink, 0.0, 1.0) * uComic * 0.72);

      // ink pooling: soft luminance edges still pool a little pigment (kept
      // gentle now that the real contour line exists)
      vec2 px = 1.5 / uRes;
      float gx = luma(texture2D(tDiffuse, uv + vec2(px.x, 0.0)).rgb)
               - luma(texture2D(tDiffuse, uv - vec2(px.x, 0.0)).rgb);
      float gy = luma(texture2D(tDiffuse, uv + vec2(0.0, px.y)).rgb)
               - luma(texture2D(tDiffuse, uv - vec2(0.0, px.y)).rgb);
      // WET EDGE / backrun: pigment pools a little darker along the wash
      // boundary. Gated by the gradient, so flat areas (sky, open water) are
      // untouched — this darkens edges, never floods fills to black.
      float edge = min(0.20, (abs(gx) + abs(gy)) * 0.6);
      c.rgb = pow(max(c.rgb, 0.0), vec3(1.0 + edge * 1.7 * uPaperAmt));

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
        c.rgb = pigment(c.rgb, 1.0 + (turb - 0.5) * 0.30 * uPaperAmt);
      }

      float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));

      // layered washes → cel steps: luminance settles into bands. Watercolour
      // nudges gently toward them (soft washes); comic snaps hard (flat cel
      // fills with crisp light/shadow terminators).
      float lq = floor(l * uPosterLevels + 0.5) / uPosterLevels;
      c.rgb *= mix(1.0, (lq + 0.001) / (l + 0.001), uPosterAmt);

      // BEN-DAY halftone: in the mid/shadow tones, break the fill into a rotated
      // dot screen whose dots swell as it darkens — the signature comic tone.
      if (uHalftone > 0.001) {
        float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
        float ca = 0.4; mat2 rot = mat2(cos(ca), -sin(ca), sin(ca), cos(ca));
        vec2 hv = rot * (vUv * uRes) / max(2.0, uHalftoneScale);
        float dcell = length(fract(hv) - 0.5) * 2.0;   // 0 centre .. ~1.4 corner
        float radius = (1.0 - lum) * 0.95;              // darker → bigger dot
        float dotMask = smoothstep(radius - 0.12, radius + 0.12, dcell); // 1 paper, 0 ink
        float apply = (1.0 - smoothstep(0.35, 0.8, lum)) * uHalftone;
        c.rgb = mix(c.rgb, c.rgb * mix(0.32, 1.0, dotMask), apply);
      }

      // split toning as a COLOUR SCRIPT: shadows drift teal / highlights gold,
      // but both bend toward the hour's actual light (sun in the highlights, sky
      // in the shadows) so dawn reads rose, noon cool, dusk amber — the palette
      // is art-directed by time instead of fixed. Hue only (brightness-normed).
      vec3 hn = uHiTint / max(0.35, dot(uHiTint, vec3(0.3333)));
      vec3 sn = uShadowTint / max(0.35, dot(uShadowTint, vec3(0.3333)));
      vec3 shadowTint = mix(vec3(0.86, 1.02, 1.04), sn, 0.4);
      vec3 highTint  = mix(vec3(1.08, 1.01, 0.88), hn, 0.4);
      l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb *= mix(shadowTint, highTint, smoothstep(0.15, 0.85, l));

      // filmic S-curve: rolled shadows, soft shoulder — the "one preset" feel
      c.rgb = mix(c.rgb, c.rgb * c.rgb * (3.0 - 2.0 * c.rgb), 0.38);

      // saturation with a little life back after the curve (comic punches it up)
      l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb = mix(vec3(l), c.rgb, uSat);

      // VINTAGE film: age the frame toward a warm faded duotone (shadows drift
      // warm brown, highlights toward cream) — the old-cartoon print, laid over
      // the paint rather than replacing it
      if (uSepia > 0.001) {
        float yl = dot(c.rgb, vec3(0.299, 0.587, 0.114));
        vec3 aged = mix(vec3(0.20, 0.12, 0.07), vec3(1.0, 0.94, 0.80), yl);
        c.rgb = mix(c.rgb, aged, uSepia * 0.8);
      }

      // FILM STOCK emulation (Dehancer-style): the capture medium on top of the
      // paint — a tone curve (contrast + S + toe lift + shoulder rolloff), a
      // channel colour response (how the dye layers push shadows vs highlights),
      // the stock's saturation, and halation glow out of the brights. uFilm=0
      // bypasses it entirely.
      if (uFilm > 0.001) {
        vec3 f = (c.rgb - 0.5) * uFilmContrast + 0.5;
        f = mix(f, f * f * (3.0 - 2.0 * f), uFilmSCurve);
        f = clamp(f, 0.0, 1.0);
        f = uFilmToe + f * (1.0 - uFilmToe - uFilmShoulder);   // latitude
        float yf = dot(f, vec3(0.299, 0.587, 0.114));
        f *= mix(uFilmShadow, uFilmHigh, smoothstep(0.08, 0.92, yf));
        f = mix(vec3(yf), f, uFilmSat);
        f += uFilmHaloTint * smoothstep(0.62, 1.0, yf) * uFilmHalo;
        c.rgb = mix(c.rgb, f, uFilm);
      }

      // haze-lifted blacks: nothing is ever pure dark
      c.rgb = mix(c.rgb, vec3(0.70, 0.82, 0.80), 0.05);

      // storm grade: colour drains hard toward cold slate, highlights come down,
      // and a heavy vignette closes in — the whole frame turns bruised and the
      // horizon presses down while the weather lasts
      if (uStorm > 0.01) {
        float sl = dot(c.rgb, vec3(0.299, 0.587, 0.114));
        c.rgb = mix(c.rgb, vec3(sl) * vec3(0.86, 0.95, 1.08), uStorm * 0.5);
        c.rgb *= 1.0 - uStorm * 0.12;
        // oppressive vignette, weighted to the top so the sky feels like a lid
        float vig = distance(vUv, vec2(0.5, 0.62));
        c.rgb *= 1.0 - smoothstep(0.28, 0.95, vig) * uStorm * 0.4;
      }

      // screen-space granulation: barely-there (world-space turbulence above
      // is the real pigment layer), and through the pigment equation so it
      // melts out of the highlights by construction
      float gran = texture2D(uPaper, vUv * asp * 5.0).b - 0.5;
      c.rgb = pigment(c.rgb, 1.0 + gran * 0.10 * uPaperAmt);

      // vignette as UNPAINTED paper: toward the corners colours thin out and
      // lift slightly — the wash runs dry — instead of a photographic darken
      float d = distance(vUv, vec2(0.5));
      float vig = smoothstep(0.42, 0.94, d);
      c.rgb *= 1.0 - vig * uVignette;
      c.rgb = mix(c.rgb, vec3(dot(c.rgb, vec3(0.299, 0.587, 0.114))), vig * 0.10);

      // fine film grain, dialed back — granulation carries the texture now
      float g1 = hash(vUv * vec2(1710.0, 1010.0) + fract(uTime) * 61.0) - 0.5;
      float g2 = hash(floor(vUv * vec2(640.0, 380.0)) / vec2(640.0, 380.0)
                      + fract(uTime * 0.73) * 17.0) - 0.5;
      float grain = g1 * 0.62 + g2 * 0.38;
      float gw = 0.35 + (1.0 - smoothstep(0.45, 0.95, l));
      c.rgb += grain * (0.034 * gw * uPaperAmt + uFilmGrain * (0.6 + gw * 0.4));

      // old-film density flicker + sparse dust and the odd drifting scratch
      c.rgb *= 1.0 + (hash(vec2(floor(uTime * 20.0), 7.0)) - 0.5) * uFlicker * 0.1;
      if (uSepia > 0.001) {
        float spec = hash(floor(vUv * uRes / 3.0) + floor(uTime * 16.0) * 1.7);
        c.rgb += step(0.9992, spec) * uSepia * 0.55;              // bright dust mote
        float sx = hash(vec2(floor(uTime * 2.0), 11.0));
        c.rgb -= smoothstep(0.004, 0.0, abs(vUv.x - sx)) * uSepia * 0.12;  // scratch
      }
      // paper tooth: the whole frame sits on one sheet — quiet, and through
      // the pigment equation (paper is flat relative to the image plane, so
      // screen space is actually correct here; loudness was the overlay tell)
      float paper = texture2D(uPaper, vUv * asp * 2.4).r;
      c.rgb = pigment(c.rgb, 1.0 + (0.91 - paper) * 0.55 * uPaperAmt);
      // DRY BRUSH: in the lightest passages the paper tooth breaks through, so
      // highlights read dry and textured rather than flatly bright
      float dryL = smoothstep(0.74, 0.97, dot(c.rgb, vec3(0.299, 0.587, 0.114)));
      c.rgb = mix(c.rgb, c.rgb * (0.9 + paper * 0.2), dryL * 0.4 * uPaperAmt);
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
    const int R = 3;
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

// Tilt-shift: a gentle gradient blur away from a horizontal focus band — the
// classic miniature-diorama cue, and in watercolour terms the distance going
// wet-on-wet soft while the subject stays crisp.
const TiltShiftShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uRes: { value: new THREE.Vector2(1280, 720) },
    uFocus: { value: 0.46 },
    uMax: { value: 2.6 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec2 uRes;
    uniform float uFocus;
    uniform float uMax;
    varying vec2 vUv;
    void main() {
      float band = smoothstep(0.10, 0.52, abs(vUv.y - uFocus));
      vec4 c = texture2D(tDiffuse, vUv);
      if (band < 0.02) { gl_FragColor = c; return; }
      vec2 r = band * uMax / uRes;
      vec4 acc = c * 0.24;
      acc += texture2D(tDiffuse, vUv + vec2( 1.0,  0.3) * r) * 0.095;
      acc += texture2D(tDiffuse, vUv + vec2(-1.0, -0.3) * r) * 0.095;
      acc += texture2D(tDiffuse, vUv + vec2( 0.3, -1.0) * r) * 0.095;
      acc += texture2D(tDiffuse, vUv + vec2(-0.3,  1.0) * r) * 0.095;
      acc += texture2D(tDiffuse, vUv + vec2( 0.8, -0.8) * r) * 0.095;
      acc += texture2D(tDiffuse, vUv + vec2(-0.8,  0.8) * r) * 0.095;
      acc += texture2D(tDiffuse, vUv + vec2( 0.8,  0.8) * r) * 0.095;
      acc += texture2D(tDiffuse, vUv + vec2(-0.8, -0.8) * r) * 0.095;
      gl_FragColor = acc;
    }`,
};

// Pixelate + ordered dither — an "A Short Hike"-style low-fi pass at the very
// end of the chain. Snaps the frame to square blocks (chunky pixels), then
// quantises the colour with a 4x4 Bayer ordered dither so gradients (sky, soft
// shadow) break into a retro dot pattern instead of banding. Both off = a
// straight passthrough.
const PixelateShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uRes: { value: new THREE.Vector2(1280, 720) },
    uPixel: { value: 1.0 },    // block size in device px; ≤1 = no pixelation
    uScale: { value: 1.0 },    // render super-sample factor (to lock dither to display px)
    uBits: { value: 8.0 },     // colour depth per channel in bits; ≥8 = full (off)
    uDither: { value: 0.0 },   // 0 = hard bands … 1 = full ordered dither
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec2 uRes;
    uniform float uPixel;
    uniform float uScale;
    uniform float uBits;
    uniform float uDither;
    varying vec2 vUv;
    // Recursive Bayer 4x4 (array-free, driver-safe on GLSL ES 1.0) → [0,1).
    float bayer2(vec2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
    float bayer4(vec2 a) { return bayer2(a * 0.5) * 0.25 + bayer2(a); }
    void main() {
      bool px = uPixel > 1.001;
      vec2 blk = vec2(uPixel) / uRes;
      // sample the block CENTRE so each chunky pixel is one flat colour
      vec2 suv = px ? (floor(vUv / blk) + 0.5) * blk : vUv;
      vec3 c = texture2D(tDiffuse, suv).rgb;
      // Colour-depth crush with optional ordered dither. levels = 2^bits per
      // channel; at 8 bits it's a no-op (full colour), so watercolour etc. stay
      // clean unless you deliberately reduce the depth. The Bayer threshold is
      // what makes the crush read as a dither PATTERN instead of hard bands, and
      // uDither blends from "round to nearest" (0) to "full ordered dither" (1).
      if (uBits < 7.99) {
        float levels = pow(2.0, uBits);
        // Lock the Bayer grid to DISPLAY pixels (uRes/uScale), not backing pixels.
        // The pass runs at the super-sampled backing res; a backing-pixel dither
        // gets averaged away by the CSS downsample, re-introducing the bands it
        // was meant to hide (the horizontal stripe). One threshold per display
        // pixel (or per pixel-block) survives the downsample intact.
        vec2 dcoord = px ? floor(vUv / blk) : floor(vUv * uRes / uScale);
        float offset = mix(0.5, bayer4(dcoord), uDither);
        c = clamp(floor(c * (levels - 1.0) + offset) / (levels - 1.0), 0.0, 1.0);
      }
      gl_FragColor = vec4(c, 1.0);
    }`,
};

function lam(color: number): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ color, flatShading: true });
  smudgeNormals(m);          // painterly broken light on every flat-shaded prop/structure
  return m;
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
  const m = new THREE.MeshLambertMaterial({ color: jitter(color, seed, amt), flatShading: true });
  smudgeNormals(m);
  return m;
}

// Foliage-specific jitter: WIDE lightness + saturation (some trees bright & lush,
// some deep & dark) with only a modest hue drift — reads as a natural mixed
// stand rather than uniform clones, without straying into unnatural teal greens.
function jitterLeaf(color: number, seed: string): THREE.Color {
  const c = new THREE.Color(color);
  c.offsetHSL(
    (hashStr(seed + "h") - 0.5) * 0.10,
    (hashStr(seed + "s") - 0.5) * 0.28,
    (hashStr(seed + "l") - 0.5) * 0.24,
  );
  return c;
}
// ── painterly normal smudge ───────────────────────────────────────────────────
// Break the hard flat-shaded facet LIGHTING into an organic, hand-painted gradient
// by wobbling the fragment normal with a world-space noise BEFORE the lighting is
// computed. Silhouette (geometry) untouched, and the ink prepass renders its own
// clean normals, so outlines stay crisp — only the SHADING inside a surface breaks.
// The noise mixes SOFT value noise with HARD Voronoi cells, and a low-freq mask
// makes some areas soft-washed and others hard-facetted (not a uniform blend).
const SMUDGE_FN = `
  uniform float uSmudge;
  float smHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float smNoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(smHash(i), smHash(i + vec2(1.0, 0.0)), u.x),
               mix(smHash(i + vec2(0.0, 1.0)), smHash(i + vec2(1.0, 1.0)), u.x), u.y); }
  vec3 smHash3(vec2 p){ vec3 q = vec3(dot(p, vec2(127.1, 311.7)),
    dot(p, vec2(269.5, 183.3)), dot(p, vec2(419.2, 371.9))); return fract(sin(q) * 43758.5453); }
  vec3 smCell(vec2 x){ vec2 n = floor(x), f = fract(x); float md = 8.0; vec3 res = vec3(0.5);
    for (int j = -1; j <= 1; j++){ for (int i = -1; i <= 1; i++){
      vec2 g = vec2(float(i), float(j)); vec3 h = smHash3(n + g); vec2 r = g + h.xy - f;
      float d = dot(r, r); if (d < md){ md = d; res = smHash3(n + g + 17.3); } } }
    return res; }`;
const SMUDGE_APPLY = `
  {
    // HARD flat facets from Voronoi (fold Y into XZ so spherical forms aren't
    // sliced into vertical columns)…
    vec2 cellUv = vec2(vWSm.x + vWSm.y * 0.7, vWSm.z - vWSm.y * 0.5) * 3.0;
    vec3 hard = smCell(cellUv) - 0.5;
    // …and SOFT value-noise wobble.
    vec3 soft = vec3(smNoise(vWSm.xz * 6.0) - 0.5,
                     smNoise(vWSm.yz * 6.0 + 5.1) - 0.5,
                     smNoise(vWSm.xy * 6.0 + 9.3) - 0.5);
    // low-freq mask: 0 = this AREA stays a soft wash, 1 = this area breaks into
    // hard facets. So the character varies across the surface, not a flat blend.
    float region = smoothstep(0.34, 0.66, smNoise(vWSm.xz * 1.3 + 3.3));
    vec3 pert = mix(soft * 0.9, hard, region);
    normal = normalize(normal + pert * uSmudge);
  }`;

function smudgeNormals(m: THREE.Material, amt = 0.6): void {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uSmudge = { value: amt };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWSm;")
      .replace("#include <begin_vertex>",
        "#include <begin_vertex>\nvWSm = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWSm;\n" + SMUDGE_FN)
      .replace("#include <normal_fragment_begin>", "#include <normal_fragment_begin>\n" + SMUDGE_APPLY);
  };
  m.customProgramCacheKey = () => "smudge";
}

function lamJLeaf(color: number, seed: string): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ color: jitterLeaf(color, seed), flatShading: true });
  smudgeNormals(m);
  return m;
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

// ── time-of-day lighting: a day is a JOURNEY, not a two-point lerp ────────────
// Keyframes over the sim day (0..0.5 day half, 0.5..1 night half, matching the
// backend's is_night rule): rose dawn → clear noon → amber golden hour →
// violet dusk → blue moonlit night. The sun physically travels east→west, so
// shadows lengthen into the golden hour by themselves.
type LightKey = {
  t: number;
  sun: number; sunI: number; elev: number; azim: number;
  sky: number; gnd: number; hemiI: number;
  fog: number; top: number; hor: number; water: number;
  dark: number;                             // drives fires, fireflies, clouds
};
const LIGHT_KEYS: LightKey[] = [
  { t: 0.00, sun: 0xffb08a, sunI: 1.25, elev: 0.14, azim: -1.7,
    sky: 0xf3d2d8, gnd: 0x6a6a70, hemiI: 0.72,
    fog: 0xeed9d2, top: 0xc9b6d8, hor: 0xffd9b8, water: 0x8fb0c0, dark: 0.22 },
  // Daytime keys carry COLOURED SHADOWS (the A Short Hike signature): a warm
  // golden sun against a cool blue-violet ambient fill — lit faces glow warm,
  // shade falls cool, and the whole frame gains painterly depth for free.
  { t: 0.10, sun: 0xffdfae, sunI: 1.9, elev: 0.5, azim: -1.05,
    sky: 0xbfdeed, gnd: 0x7d86ab, hemiI: 0.95,
    fog: 0xd6e8df, top: 0x8fd0ea, hor: 0xf6f3e2, water: 0x7fb6ba, dark: 0 },
  { t: 0.24, sun: 0xffe8c0, sunI: 2.0, elev: 0.85, azim: 0.0,
    sky: 0xb9dcec, gnd: 0x8089ae, hemiI: 1.0,
    fog: 0xd6e8df, top: 0x8ecfe0, hor: 0xf4ead2, water: 0x7fb6ba, dark: 0 },
  { t: 0.38, sun: 0xffbe6e, sunI: 2.0, elev: 0.26, azim: 1.15,
    sky: 0xe4cfc0, gnd: 0x77689a, hemiI: 0.82,
    fog: 0xecd5ac, top: 0xa8c4d8, hor: 0xffcf8e, water: 0x87aeb2, dark: 0.05 },
  // sunset holds TWO keys (blaze, then violet dusk) so the evening is a scene
  // of its own rather than a single frame on the way to night
  { t: 0.46, sun: 0xff9468, sunI: 1.25, elev: 0.06, azim: 1.5,
    sky: 0xe5c3c3, gnd: 0x5e5a62, hemiI: 0.68,
    fog: 0xdbb3ae, top: 0x8492c0, hor: 0xffb37e, water: 0x7d9cae, dark: 0.2 },
  { t: 0.54, sun: 0xa9a2d8, sunI: 0.6, elev: 0.12, azim: 1.9,
    sky: 0x8a7ba8, gnd: 0x3c3a50, hemiI: 0.55,
    fog: 0x6f6488, top: 0x3c4470, hor: 0x9b7a96, water: 0x5a7390, dark: 0.6 },
  // moonlit, not pitch-black: the ISLAND itself stays readable — a bright
  // cool moon models the terrain and a lifted blue ambient fills the shadows
  { t: 0.64, sun: 0xc6d8f4, sunI: 1.15, elev: 0.42, azim: -0.9,
    sky: 0x5b76a4, gnd: 0x35404f, hemiI: 0.7,
    fog: 0x24374f, top: 0x1a2c46, hor: 0x40546e, water: 0x46647c, dark: 1 },
  { t: 0.90, sun: 0xc6d8f4, sunI: 1.15, elev: 0.32, azim: -1.4,
    sky: 0x5b76a4, gnd: 0x35404f, hemiI: 0.7,
    fog: 0x26384f, top: 0x1c2e47, hor: 0x445870, water: 0x46647c, dark: 1 },
];
// interpolated per frame into these (avoids per-frame allocations)
const LC = {
  sun: new THREE.Color(), sky: new THREE.Color(), gnd: new THREE.Color(),
  fog: new THREE.Color(), top: new THREE.Color(), hor: new THREE.Color(),
  water: new THREE.Color(),
  sunI: 1.9, elev: 0.85, azim: 0, hemiI: 0.9, dark: 0,
};
const lcA = new THREE.Color(), lcB = new THREE.Color();

function evalLight(frac: number): void {
  const keys = LIGHT_KEYS;
  let i = keys.length - 1;
  for (let k = 0; k < keys.length; k += 1) if (keys[k].t <= frac) i = k;
  const a = keys[i];
  const b = keys[(i + 1) % keys.length];
  const span = (b.t - a.t + 1) % 1 || 1;
  const s = Math.min(1, Math.max(0, ((frac - a.t + 1) % 1) / span));
  const lerpC = (out: THREE.Color, ca: number, cb: number) =>
    out.copy(lcA.setHex(ca)).lerp(lcB.setHex(cb), s);
  lerpC(LC.sun, a.sun, b.sun);
  lerpC(LC.sky, a.sky, b.sky);
  lerpC(LC.gnd, a.gnd, b.gnd);
  lerpC(LC.fog, a.fog, b.fog);
  lerpC(LC.top, a.top, b.top);
  lerpC(LC.hor, a.hor, b.hor);
  lerpC(LC.water, a.water, b.water);
  LC.sunI = a.sunI + (b.sunI - a.sunI) * s;
  LC.elev = a.elev + (b.elev - a.elev) * s;
  LC.azim = a.azim + (b.azim - a.azim) * s;
  LC.hemiI = a.hemiI + (b.hemiI - a.hemiI) * s;
  LC.dark = a.dark + (b.dark - a.dark) * s;
}

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
let cloudMats: THREE.MeshBasicMaterial[] = [];   // per cluster: occlusion fade
let lumSprite: THREE.Sprite | null = null;       // sun by day, moon by night
let cirrusMat: THREE.SpriteMaterial | null = null;
let moonPath: THREE.Mesh | null = null;          // glimmering strip on the sea
let rainMesh: THREE.LineSegments | null = null;
let rainBase: Float32Array | null = null;        // (x, y0, z, speed) per drop
let composer: EffectComposer;
let gradePass: ShaderPass;
let kuwaharaPass: ShaderPass;
let tiltPass: ShaderPass;
let fxaaPass: ShaderPass;
let pixelPass: ShaderPass;
let bloomPass: UnrealBloomPass;
let terrainGroup: THREE.Group | null = null;
let propsGroup: THREE.Group | null = null;
let structsGroup: THREE.Group | null = null;
let foamGroup: THREE.Group | null = null;
let cloudsGroup: THREE.Group | null = null;
let floraGroup: THREE.Group | null = null;
let fogGroup: THREE.Group | null = null;
let fogSprites: THREE.Sprite[] = [];
let skyMesh: THREE.Mesh | null = null;
let skyMat: THREE.ShaderMaterial | null = null;
let fireLights: THREE.PointLight[] = [];
let inkTarget: THREE.WebGLRenderTarget | null = null;
let inkMat: THREE.ShaderMaterial | null = null;
let lastRenderPr = 0;   // so a renderScale change re-applies even without a resize
type Swayer = { m: THREE.Object3D; phase: number; amp: number; base: number };
let swayers: Swayer[] = [];
let breathers: Swayer[] = [];               // canopy blobs pulsing in the wind
let waveGroup: THREE.Group | null = null;
// ambient life registries (smoke + fireflies rebuilt with structures; birds +
// butterflies rebuilt with the terrain)
let smokes: { base: THREE.Vector3; puffs: THREE.Mesh[]; seed: number }[] = [];
let fireflies: { m: THREE.Mesh; base: THREE.Vector3; seed: number }[] = [];
let lifeGroup: THREE.Group | null = null;   // holds smoke/firefly meshes
type Bird = { g: THREE.Group; wings: THREE.Mesh[]; cx: number; cz: number;
  r: number; h: number; speed: number; phase: number };
let birds: Bird[] = [];
type Butterfly = { g: THREE.Group; wings: THREE.Mesh[]; base: THREE.Vector3; seed: number };
let butterflies: Butterfly[] = [];
let skyLifeGroup: THREE.Group | null = null;
let active = false;
let rafId = 0;
let builtMapKey = "";
let heightGrid: number[][] = [];          // smoothed corner heights (n+1)^2
let mapN = 0;
let state: WorldState | null = null;
let shadowTick = 0;                        // throttles the shadow-map refresh
let nightMix = 0;                          // darkness 0..1 (from the light keys)
let stormMix = 0;                          // 0 = clear, 1 = storm (lerped)
let dayFrac = 0.25;                        // displayed time of day (0..1, smoothed)
let dayFracTarget = 0.25;
let dayFracOverride: number | null = null; // debug: freeze the hour for screenshots
let stormOverride: number | null = null;   // debug: force the storm 0..1
let dayLenTicks = 0;                       // from the snapshot (0 = unknown)
let estTickSec = 0;                        // measured seconds per sim tick (EMA)
let lastSimTick = -1;
let lastTickMs = 0;
let waterMat: THREE.MeshPhongMaterial | null = null;
let islandCX = 30, islandCZ = 30;          // sun orbits this
let followId: string | null = null;        // camera-follow state
let followDollyT = 1e9;                    // seconds since the follow started
let nextFlash = 0;                         // lightning scheduler (storm only)
let flashStart = -10;
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
  lighthouse: { url: "models/lighthouse.glb", size: 4.65, axis: "y", sink: 0.02 },
  bunker: { url: "models/bunker2.glb", size: 1.1, axis: "xz", sink: 0.05 },
  // hand-modelled by the user (near-arbitrary source scale → normalised to these
  // world sizes; tweak the `size` here to nudge each to fit the island)
  cave: { url: "models/cave.glb", size: 2.1, axis: "xz", sink: 0.06 },
  // its water sits at the model's foot, so a hair of LIFT keeps the pool from
  // z-fighting under the ground while the stone rim still reads as grounded
  hotspring: { url: "models/hotspring.glb", size: 2.1, axis: "xz", sink: -0.06 },
  plane: { url: "models/plane_updated.glb", size: 7.5, axis: "xz", sink: 0.08 },
  radiotower: { url: "models/radiotower.glb", size: 5.7, axis: "y", sink: 0.03 },
  tent: { url: "models/tent.glb", size: 1.5, axis: "xz", sink: 0.05 },
  tent_unfinished: { url: "models/tent_unfinished.glb", size: 1.5, axis: "xz", sink: 0.05 },
  // inland ponds (two hand-modelled variants) — foot sits on the ground, a hair
  // embedded so there's no floating gap
  water: { url: "models/water.glb", size: 1.6, axis: "xz", sink: 0.04 },
  water2: { url: "models/water2.glb", size: 1.6, axis: "xz", sink: 0.04 },
  // user-authored buildables — normalised to each footprint's world size
  well: { url: "models/homemade_stone_well.glb", size: 1.7, axis: "xz", sink: 0.05 },
  workbench: { url: "models/island_workbench.glb", size: 1.7, axis: "xz", sink: 0.05 },
  store: { url: "models/makeshift_storage_shed.glb", size: 2.5, axis: "xz", sink: 0.05 },
  water_still: { url: "models/rainwater_collector.glb", size: 1.7, axis: "xz", sink: 0.05 },
  garden: { url: "models/raised_garden_bed.glb", size: 2.6, axis: "xz", sink: 0.05 },
  smokehouse: { url: "models/smokehouse_drying_rack.glb", size: 1.9, axis: "xz", sink: 0.05 },
  fishing_rig: { url: "models/fishing_lever_rig.glb", size: 1.4, axis: "xz", sink: 0.05 },
  // user-authored nature props (replace the primitive rocks/bush on the nodes)
  boulder: { url: "models/beach_boulder_cluster.glb", size: 1.0, axis: "xz", sink: 0.06 },
  basalt: { url: "models/volcanic_basalt.glb", size: 0.95, axis: "xz", sink: 0.06 },
  coral: { url: "models/coral_limestone.glb", size: 1.0, axis: "xz", sink: 0.05 },
  amber_ore: { url: "models/amber_ore_pile.glb", size: 1.05, axis: "xz", sink: 0.05 },
  saltbush: { url: "models/silver_saltbush.glb", size: 0.95, axis: "xz", sink: 0.04 },
};
const models = new Map<string, THREE.Group>();

function loadModels(): void {
  const loader = new GLTFLoader();
  for (const [key, def] of Object.entries(MODEL_DEFS)) {
    loader.load(def.url, (gltf) => {
      const root = gltf.scene;
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.castShadow = true; mesh.receiveShadow = true;
          // structures/props are GLB models with their own materials — give them
          // the same painterly broken light as the code-built props.
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const mat of mats) if (mat) smudgeNormals(mat);
        }
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
      // swap the model in live: structures AND props (water ponds) both use GLBs.
      // force=true — the signature didn't change, only the model became available.
      if (state && heightGrid.length) { buildStructs(state, true); buildProps(state, true); }
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
    // A STEEPER cone with lower plate cuts (below): terraces appear all over
    // the island instead of only at the rocky core — the tiered, layered
    // silhouette is the whole drama of the diorama.
    let h = 0.12 + Math.min(1, d / 5.5) ** 0.95 * 3.0;
    if (t.includes("rock")) h += PEAK_ROCK * Math.min(1, d / 9 + 0.35);
    else if (t.includes("foliage")) h += 0.6;
    // bolder noise — bends terrace outlines into bays and promontories
    h += (vnoise(x, y, 9, 31) - 0.5) * 1.15 + (vnoise(x, y, 4, 57) - 0.5) * 0.35;
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
  // two passes, not three: crisper steps mean more distinct terrace levels
  for (let pass = 0; pass < 2; pass += 1) {
    const out = g.map((r) => r.slice());
    for (let y = 1; y < n; y += 1)
      for (let x = 1; x < n; x += 1)
        out[y][x] = (g[y][x] * 2 + g[y - 1][x] + g[y + 1][x] + g[y][x - 1] + g[y][x + 1]) / 6;
    g = out;
  }
  // LOGICAL LAND MUST NEVER RENDER AS SEA. Corner-averaging with SEA_FLOOR and
  // the smoothing passes sink narrow (1-2 tile) coastal strips below the
  // coastline threshold — the backend then places palms, nodes, the plane and
  // even agent spawns on tiles the sculpture shows as open water (measured: 113
  // such tiles on one seed). Clamp every corner touching a land tile above the
  // level-0 cut: the silhouette stays smooth, but the world's truth wins.
  for (let y = 0; y < n; y += 1)
    for (let x = 0; x < n; x += 1) {
      if (isWater(x, y)) continue;
      for (const [cx, cy] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]] as const)
        g[cy][cx] = Math.max(g[cy][cx], PLATE_THRESH[0] + 0.06);
    }
  heightGrid = g;    // SMOOTH field — the plates quantise it, not the grid
}

// ── the island as SCULPTURE: stacked extruded plates ─────────────────────────
// Bad North islands are not displaced planes — they are clean 2D outlines
// extruded into vertical-walled plates. We cut the smooth height field at
// fixed thresholds, smooth each cut with Chaikin, and extrude. Flat tops,
// smooth curved walls, an authored silhouette — out of pure generation.
// Lower, tighter cuts + the steeper cone in tileH: mid terraces now appear a
// couple of tiles inland everywhere, so the whole island is layered — and lips
// tall enough for waterfalls exist outside the rocky core too.
const PLATE_THRESH = [0.05, 0.9, 1.9, 3.0, 4.4];  // raw-height cuts (0 = coastline)
// world-space top of each plate — the gaps WIDEN with height, so the island
// rises into a dramatic tiered massif with tall cliffs, not a gentle mound
const PLATE_TOP = [0.26, 1.05, 2.05, 3.25, 4.7];

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

// ── seatOnMesh: THE one placement law ─────────────────────────────────────────
// Sample the REAL rendered mesh in a ring of the object's visual radius. If the
// footprint straddles a cliff, SLIDE the object away from the lip (inward) until
// it stands on one level; if no flat spot is reachable, seat on the LOWEST
// sampled ground — so nothing ever hangs in the air. This exists because every
// float/sink bug came from trusting the analytic height field (groundY et al.),
// which diverges from the Chaikin-smoothed sculpture near walls. The mesh is
// the only truth; everything that stands on the island seats through here.
function seatOnMesh(x: number, z: number, r: number, maxSlide = 1.6):
    { x: number; z: number; y: number; flat: boolean } {
  let cx = x, cz = z;
  const ring = (px: number, pz: number): number[] => {
    const hs: number[] = [surfaceY(px, pz)];
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2;
      hs.push(surfaceY(px + Math.cos(a) * r, pz + Math.sin(a) * r));
    }
    return hs;
  };
  for (let step = 0; step < 7; step += 1) {
    const hs = ring(cx, cz);
    const top = Math.max(...hs);
    if (!hs.some((h) => top - h > 0.3)) {
      return { x: cx, z: cz, y: Math.min(...hs), flat: true };
    }
    // push away from every low (over-the-edge) direction, gently toward solid
    let dx = 0, dz = 0;
    for (let i = 1; i < hs.length; i += 1) {
      const a = ((i - 1) / 8) * Math.PI * 2;
      const w = top - hs[i] > 0.3 ? -1 : 0.35;
      dx += Math.cos(a) * w; dz += Math.sin(a) * w;
    }
    const len = Math.hypot(dx, dz) || 1;
    cx += (dx / len) * 0.28; cz += (dz / len) * 0.28;
    if (Math.hypot(cx - x, cz - z) > maxSlide) break;
  }
  const hs = ring(cx, cz);
  return { x: cx, z: cz, y: Math.min(...hs), flat: false };
}

// Placement height: near a plate rim the bevel dips below PLATE_TOP, so a
// single-point sample let props and meeples sink into the lip. Take the max
// over a small footprint instead — standing slightly proud beats being buried.
function groundY(wx: number, wz: number): number {
  return Math.max(
    heightAt(wx, wz),
    heightAt(wx + 0.16, wz), heightAt(wx - 0.16, wz),
    heightAt(wx, wz + 0.16), heightAt(wx, wz - 0.16),
  );
}

// True surface height by raycasting straight DOWN onto the rendered terrain.
// The plate meshes (Chaikin-smoothed outlines) don't line up exactly with the
// per-tile plate classification groundY() uses, so on hills the analytic height
// could sit BELOW the visible mesh and agents/props sank into it. The ray reads
// the actual mesh top; groundY() stays the fallback before the terrain exists.
const _downRay = new THREE.Raycaster();
const _downFrom = new THREE.Vector3();
const _downDir = new THREE.Vector3(0, -1, 0);
function surfaceY(wx: number, wz: number): number {
  const gy = groundY(wx, wz);
  if (!terrainGroup) return gy;
  _downFrom.set(wx, 30, wz);
  _downRay.set(_downFrom, _downDir);
  const hits = _downRay.intersectObject(terrainGroup, true);
  // first hit = the highest surface (the mirrored reflection sits below ground);
  // never return below the analytic floor
  return hits.length ? Math.max(gy, hits[0].point.y) : gy;
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

  // one luminary: a soft disc riding the light direction — warm and wide by
  // day (the sun), small and silver at night (the moon); bloom halos it
  const disc = (() => {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 128;
    const ctx = cv.getContext("2d")!;
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.42, "rgba(255,255,255,0.92)");
    g.addColorStop(0.55, "rgba(255,255,255,0.25)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(cv);
  })();
  lumSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: disc, transparent: true, depthWrite: false, fog: false,
  }));
  lumSprite.scale.setScalar(26);
  markDecor(lumSprite);
  scene.add(lumSprite);

  // moon path: sparse bright dashes on a BLACK sheet (additive: black adds
  // nothing) with brightness dying toward every edge — a broken glimmer, not
  // the solid glowing rectangle the first attempt produced
  const glimmer = (() => {
    const w = 512, h = 128;
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, w, h);
    let s = 60217;
    const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647);
    ctx.lineCap = "round";
    for (let i = 0; i < 90; i += 1) {
      const x = rnd() * w, y = h * 0.5 + (rnd() - 0.5) * h * 0.72;
      // edge falloff along both axes keeps the sheet border invisible
      const fade = Math.sin((x / w) * Math.PI) * (1 - Math.abs(y / h - 0.5) * 2);
      const a = (0.10 + rnd() * 0.30) * Math.max(0, fade) ** 1.5;
      const len = 6 + rnd() * 26;
      ctx.strokeStyle = `rgba(215, 232, 255, ${a})`;
      ctx.lineWidth = 1.5 + rnd() * 2.5;
      ctx.beginPath();
      ctx.moveTo(x - len / 2, y);
      ctx.lineTo(x + len / 2, y + (rnd() - 0.5) * 3);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = THREE.RepeatWrapping;
    return tex;
  })();
  const mpGeo = new THREE.PlaneGeometry(38, 2.4);
  mpGeo.rotateX(-Math.PI / 2);
  moonPath = new THREE.Mesh(mpGeo, new THREE.MeshBasicMaterial({
    map: glimmer, color: 0xaac8e8, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  moonPath.position.y = 0.03;
  markDecor(moonPath);
  scene.add(moonPath);

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
    // DoubleSide so thin two-sided blades (palm fronds, reeds) write depth+normal
    // whichever way they face — otherwise back-facing fronds are culled from the
    // prepass and get no silhouette outline.
    side: THREE.DoubleSide,
  });
  inkTarget = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  loadModels();

  sun = new THREE.DirectionalLight(0xfff2dd, 1.9);
  sun.castShadow = true;
  // 4096 over the island frustum: 2x the linear texel density of the old 2048,
  // so small props (rocks, reeds) cast a shadow with actual shape instead of a
  // few blocky texels.
  sun.shadow.mapSize.set(4096, 4096);
  // normalBias offsets the shadow lookup along the surface normal — the correct
  // cure for peter-panning (shadows detaching / "sliding off" their caster).
  // With it doing the anti-acne work, the constant bias can be tiny, which stops
  // the detachment the old heavy -0.0005 constant bias caused.
  sun.shadow.bias = -0.00015;
  sun.shadow.normalBias = 0.035;
  scene.add(sun);
  scene.add(sun.target);

  // Ambient dominates (soft, near-shadowless reference look); the sun only adds
  // gentle modelling and long soft shadows.
  ambient = new THREE.HemisphereLight(0xd8ecec, 0x6a7a5e, 0.85);
  scene.add(ambient);

  // Sea: a segmented surface plane with GPU waves + an opaque deep floor.
  // Painted ripples scroll slowly across it (map), with a counter-scrolling
  // shimmer layer above for parallax — texture and volume instead of a void.
  const waterTexA = rippleTexture(1);
  waterTexA.repeat.set(26, 26);                // ~18 world units per tile
  const waterMatl = new THREE.MeshPhongMaterial({
    color: 0x7fb6ba, transparent: true, opacity: 0.5,
    shininess: 14, specular: 0x1e3a44,   // sky-toned matte water (Bad North void);
    map: waterTexA,
  });                                    // the shelf plate supplies the turquoise
  waterMat = waterMatl;                  // tinted per time-of-day in tick()
  // The water ANIMATION is a breath, not a slide: two samples of the ripple
  // sheet at different scales cross-fade with a spatially-varying weight, so
  // strokes shimmer in place. (The old scrolling offset + a counter-scrolling
  // second layer read as twitchy drifting blotches.) Vertex waves are near
  // zero in calm weather — the surf shader owns the coastal motion now.
  waterMatl.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uAmp = { value: 0.004 };
    shader.uniforms.uIsland = { value: new THREE.Vector2(islandCX, islandCZ) };
    shader.uniforms.uShoreR = { value: 24 };
    shader.vertexShader = "uniform float uTime;\nuniform float uAmp;\nvarying vec2 vWXZ;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         vWXZ = (modelMatrix * vec4(position, 1.0)).xz;
         transformed.z += sin(position.x * 0.55 + uTime * 1.1) * uAmp
                        + cos(position.y * 0.45 + uTime * 0.8) * uAmp
                        + sin((position.x + position.y) * 0.22 + uTime * 0.5) * uAmp * 1.4;`,
      );
    shader.fragmentShader = "uniform float uTime;\nuniform vec2 uIsland;\nuniform float uShoreR;\nvarying vec2 vWXZ;\n" +
      shader.fragmentShader.replace(
        "#include <map_fragment>",
        `vec4 tA = texture2D(map, vMapUv);
         vec4 tB = texture2D(map, vMapUv * 1.43 + vec2(0.37, 0.11));
         float tw = 0.5 + 0.5 * sin(uTime * 0.55 + (tA.g - tB.g) * 7.0);
         diffuseColor *= mix(tA, tB, tw);
         // DEPTH GRADIENT: turquoise shallows hugging the coast fade to deep blue
         // out to sea — the tropical-postcard read, stylised (radial to island).
         float shoreD = distance(vWXZ, uIsland);
         float shallow = smoothstep(uShoreR * 1.7, uShoreR * 0.82, shoreD);
         diffuseColor.rgb = mix(diffuseColor.rgb * vec3(0.5, 0.64, 0.92),
                                diffuseColor.rgb * vec3(0.82, 1.14, 1.12), shallow);`,
      );
    waterShader = shader as unknown as { uniforms: Record<string, { value: number }> };
  };
  waterMesh = new THREE.Mesh(new THREE.PlaneGeometry(480, 480, 110, 110), waterMatl);
  waterMesh.rotation.x = -Math.PI / 2;
  waterMesh.position.y = 0;
  // no receiveShadow: cloud shadows on open water read as random dark
  // blotches sliding around — the single ugliest thing in the old sea
  markDecor(waterMesh);
  scene.add(waterMesh);
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
  // Free "fly over the island" scheme (MapControls-style): LEFT-drag trucks the
  // camera across the sea/land, RIGHT-drag orbits & tilts, wheel dollies, arrow
  // keys pan. No more being pinned to one centre point that everything spins
  // around — you go where you look.
  controls.screenSpacePanning = false;        // pan parallel to the water, not the screen
  controls.enablePan = true;
  controls.panSpeed = 0.9;
  controls.keyPanSpeed = 26;
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
  controls.listenToKeyEvents(window);         // arrow keys fly the camera
  controls.maxPolarAngle = Math.PI * 0.47;    // never quite below the horizon
  controls.minPolarAngle = Math.PI * 0.10;
  controls.minDistance = 5;
  controls.maxDistance = 190;

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
  bloomPass = new UnrealBloomPass(new THREE.Vector2(1280, 720), 0.22, 0.6, 0.92);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
  gradePass = new ShaderPass(GradeShader);
  gradePass.uniforms.uPaper.value = paperTexture();
  gradePass.uniforms.uInk.value = inkTarget.texture;
  composer.addPass(gradePass);
  tiltPass = new ShaderPass(TiltShiftShader);
  composer.addPass(tiltPass);
  fxaaPass = new ShaderPass(FXAAShader);
  composer.addPass(fxaaPass);
  // low-fi pass last, so it pixelates/dithers the finished painterly frame
  pixelPass = new ShaderPass(PixelateShader);
  composer.addPass(pixelPass);

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
    time(frac: number | null): void {      // freeze the hour (0.25 noon, 0.42 golden…)
      dayFracOverride = frac;
      if (frac !== null) dayFrac = frac;
    },
    storm(v: number | null): void { stormOverride = v; },   // freeze storm 0..1
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

// Per-PIXEL tone patches keyed to world XZ, injected into a Lambert material.
// The plate tops are low-poly, so vertex-colour patches just smear across big
// triangles and vanish — a fragment-space noise shows the patches regardless of
// mesh density: broad regions of yellow-green (dry) ↔ blue-green (lush) grass,
// biome-safe (on sand/rock it just reads warmer/cooler).
function patchTint(m: THREE.Material): void {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;")
      .replace("#include <begin_vertex>",
        "#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        varying vec3 vWPos;
        float ptHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float ptNoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(ptHash(i), ptHash(i + vec2(1.0, 0.0)), u.x),
                     mix(ptHash(i + vec2(0.0, 1.0)), ptHash(i + vec2(1.0, 1.0)), u.x), u.y); }`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        {
          float pn = (ptNoise(vWPos.xz / 7.0) - 0.5)
                   + (ptNoise(vWPos.xz / 3.0 + 11.3) - 0.5) * 0.5;   // big regions + break-up
          // Amplitude has to clear the colour-crush step (colorBits): a subtle
          // shift just rounds back to the same level and reads as flat, so the
          // patches are bold enough to land on DIFFERENT quantised greens.
          float tone = pn * 0.55;
          diffuseColor.rgb *= vec3(1.0 + tone, 1.0 + tone * 0.15, 1.0 - tone);
        }`);
  };
  m.customProgramCacheKey = () => "patchTint";
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

// ── waterfalls: high terraces spill over their cliffs (A Short Hike layering) ──
// Deterministic from the height field: find lips where a high plate drops 2+
// levels, pick a couple of well-separated ones, and hang an animated ribbon of
// falling water down the wall with mist and a foam pool at its foot. Pure
// decoration — but it makes the tiered massif read as one living watershed.
let waterfallGroup: THREE.Group | null = null;
let waterfallMats: THREE.MeshBasicMaterial[] = [];

function streakTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64; c.height = 256;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, 64, 256);
  // long soft vertical streaks, varying alpha — reads as rushing water when scrolled
  for (let i = 0; i < 26; i += 1) {
    const x = Math.random() * 64, w = 1.5 + Math.random() * 3.5;
    const a = 0.25 + Math.random() * 0.5;
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, `rgba(255,255,255,0)`);
    g.addColorStop(0.3, `rgba(255,255,255,${a})`);
    g.addColorStop(0.7, `rgba(235,250,250,${a * 0.8})`);
    g.addColorStop(1, `rgba(255,255,255,0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, w, 256);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function buildWaterfalls(n: number): void {
  waterfallGroup?.removeFromParent();
  waterfallGroup = new THREE.Group();
  waterfallMats = [];
  // candidate lips: ANY terrace edge — a cell whose near neighbour sits at
  // least one plate lower (or is open sea: a fall straight into the shallows).
  // Requiring 2-level drops found nothing on gentler seeds — invisible feature.
  type Lip = { x: number; z: number; dx: number; dz: number; top: number; bot: number; drop: number };
  const lips: Lip[] = [];
  for (let z = 2; z < n - 2; z += 1) {
    for (let x = 2; x < n - 2; x += 1) {
      const lv = plateLevelAt(x + 0.5, z + 0.5);
      if (lv < 1) continue;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nl = plateLevelAt(x + 0.5 + dx * 1.7, z + 0.5 + dz * 1.7);
        if (nl <= lv - 1) {
          const bot = nl < 0 ? 0.02 : PLATE_TOP[nl];   // sea-surface for coast falls
          lips.push({ x: x + 0.5 + dx * 0.9, z: z + 0.5 + dz * 0.9, dx, dz,
                      top: PLATE_TOP[lv], bot, drop: lv - Math.max(nl, -1) });
        }
      }
    }
  }
  // favour the tallest drops; keep them far apart so each reads as a landmark
  lips.sort((a, b) => b.drop - a.drop
    || hashStr(`wf${a.x},${a.z}`) - hashStr(`wf${b.x},${b.z}`));
  // gather extra candidates — the real-wall probe below may reject some
  const picked: Lip[] = [];
  for (const l of lips) {
    if (picked.every((p) => Math.hypot(p.x - l.x, p.z - l.z) > 11)) picked.push(l);
    if (picked.length >= 8) break;
  }
  // The analytic lips above are only a cheap PREFILTER. The ribbon itself is
  // pinned to the REAL rendered wall: probe the mesh along the fall direction
  // in small steps until the actual cliff face is found (a sharp real-height
  // drop). No real wall within reach → no waterfall — a ribbon hanging in the
  // air (the screenshot bug) is forbidden by construction.
  terrainGroup?.updateMatrixWorld(true);
  let placed = 0;
  for (const l of picked) {
    const x0 = l.x - l.dx * 0.9, z0 = l.z - l.dz * 0.9;
    let prevH = surfaceY(x0, z0);
    let wall: { x: number; z: number; top: number; bot: number } | null = null;
    for (let t = 0.1; t <= 3.0; t += 0.1) {
      const px = x0 + l.dx * t, pz = z0 + l.dz * t;
      const h = surfaceY(px, pz);
      if (prevH - h > 0.6) {
        wall = { x: px - l.dx * 0.05, z: pz - l.dz * 0.05, top: prevH, bot: h };
        break;
      }
      prevH = h;
    }
    if (!wall || wall.top < 0.5) continue;
    placed += 1;
    const h = wall.top - wall.bot + 0.1;
    const yaw = Math.atan2(l.dx, l.dz);
    const cy = wall.bot + h / 2 - 0.03;
    // back sheet: deep glassy teal; front sheet: scrolling white streaks
    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(1.05, h),
      new THREE.MeshBasicMaterial({ color: 0x9fd9d2, transparent: true, opacity: 0.42,
                                    depthWrite: false, side: THREE.DoubleSide }));
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true,
      opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, map: streakTexture() });
    mat.map!.repeat.set(1, Math.max(1, h * 0.6));
    const front = new THREE.Mesh(new THREE.PlaneGeometry(0.9, h), mat);
    waterfallMats.push(mat);
    for (const [m, off] of [[back, 0.03], [front, 0.09]] as const) {
      m.position.set(wall.x + l.dx * off, cy, wall.z + l.dz * off);
      m.rotation.y = yaw;
      waterfallGroup.add(m);
    }
    // lip curl exactly at the REAL top edge
    const curl = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.9, 6),
      new THREE.MeshBasicMaterial({ color: 0xeafaf7, transparent: true, opacity: 0.9 }));
    curl.rotation.z = Math.PI / 2;
    curl.rotation.y = yaw;
    curl.position.set(wall.x - l.dx * 0.04, wall.top + 0.04, wall.z - l.dz * 0.04);
    waterfallGroup.add(curl);
    // foam pool + mist seated on the REAL lower surface
    const footX = wall.x + l.dx * 0.55, footZ = wall.z + l.dz * 0.55;
    const footY = surfaceY(footX, footZ);
    const foam = new THREE.Mesh(new THREE.CircleGeometry(0.58, 14),
      new THREE.MeshBasicMaterial({ color: 0xf2fbfa, transparent: true, opacity: 0.75,
                                    depthWrite: false }));
    foam.rotation.x = -Math.PI / 2;
    foam.position.set(footX, footY + 0.045, footZ);
    waterfallGroup.add(foam);
    const mist = new THREE.Mesh(new THREE.SphereGeometry(0.32, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16,
                                    depthWrite: false }));
    mist.scale.set(1.6, 0.7, 1.6);
    mist.position.set(footX - l.dx * 0.1, footY + 0.2, footZ - l.dz * 0.1);
    waterfallGroup.add(mist);
    if (placed >= 3) break;
  }
  terrainGroup?.add(waterfallGroup);
}

// Sea stacks (phase 3): a few weathered rock islets standing off the coast —
// the single cheapest way to make the lagoon read as a real place with depth
// and a broken, layered silhouette instead of an empty pool.
let seaStackGroup: THREE.Group | null = null;
function buildSeaStacks(st: WorldState, n: number): void {
  seaStackGroup?.removeFromParent();
  seaStackGroup = new THREE.Group();
  const grid = st.map.grid;
  const isWater = (x: number, y: number) =>
    x < 0 || y < 0 || x >= n || y >= n || grid[y][x].includes("water");
  // candidate open-sea tiles 2-4 tiles off the shore
  const cands: [number, number][] = [];
  for (let y = 2; y < n - 2; y += 2) {
    for (let x = 2; x < n - 2; x += 2) {
      if (!isWater(x, y)) continue;
      let nearLand = false, tooClose = false;
      for (let r = 1; r <= 4; r += 1)
        for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]] as const)
          if (!isWater(x + dx, y + dz)) { nearLand = true; if (r <= 1) tooClose = true; }
      if (nearLand && !tooClose) cands.push([x, y]);
    }
  }
  cands.sort((a, b) => hash01(a[0], a[1], 900) - hash01(b[0], b[1], 900));
  const picked: [number, number][] = [];
  for (const c of cands) {
    if (picked.every((p) => Math.hypot(p[0] - c[0], p[1] - c[1]) > 9)) picked.push(c);
    if (picked.length >= 4) break;
  }
  const rockMat = lamS(pal().wallHigh), capMat = lamS(pal().tuft);
  for (const [x, y] of picked) {
    const wx = x + 0.5, wz = y + 0.5;
    const g = new THREE.Group();
    const H = 0.9 + hash01(x, y, 901) * 1.1;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.6, H, 6, 1), rockMat);
    base.position.y = H / 2 - 0.5;                 // foot below the waterline
    base.castShadow = true;
    // tilt + a smaller stacked block for a broken, weathered read
    base.rotation.z = (hash01(x, y, 902) - 0.5) * 0.24;
    g.add(base);
    const cap = new THREE.Mesh(new THREE.DodecahedronGeometry(0.3, 0), rockMat);
    cap.position.y = H - 0.5; cap.scale.set(1, 0.7, 1);
    cap.rotation.set(hash01(x, y, 903) * 6, hash01(x, y, 904) * 6, 0);
    cap.castShadow = true;
    g.add(cap);
    if (hash01(x, y, 905) < 0.6) {                 // a tuft of green clings to the top
      const grass = new THREE.Mesh(new THREE.SphereGeometry(0.16, 6, 4), capMat);
      grass.position.y = H - 0.5 + 0.16; grass.scale.set(1, 0.5, 1);
      g.add(grass);
    }
    g.position.set(wx, 0, wz);
    g.rotation.y = hash01(x, y, 906) * 6.28;
    seaStackGroup.add(g);
  }
  terrainGroup?.add(seaStackGroup);
}

// Streams (phase 1): each inland spring feeds a creek that runs downhill along
// the REAL mesh (steepest descent) to the sea, threading the terraces into one
// watershed — the reference's signature. A hand-built ribbon of water quads
// seated on the surface, UV-scrolled so it flows.
let streamGroup: THREE.Group | null = null;
let streamMats: THREE.MeshBasicMaterial[] = [];
function buildStreams(st: WorldState, n: number): void {
  streamGroup?.removeFromParent();
  streamGroup = new THREE.Group();
  streamMats = [];
  terrainGroup?.updateMatrixWorld(true);
  for (const node of st.resources) {
    if (node.quantity <= 0 || node.kind !== "spring") continue;
    const tile = st.map.grid[node.y]?.[node.x] ?? "";
    if (tile.includes("sand") || tile.includes("water")) continue;   // coast springs skip
    // steepest-descent path from the spring to the shore
    const path: THREE.Vector3[] = [];
    let px = node.x + 0.5, pz = node.y + 0.5;
    let py = surfaceY(px, pz);
    for (let step = 0; step < 90; step += 1) {
      path.push(new THREE.Vector3(px, py + 0.04, pz));
      if (py < 0.12) break;                       // reached sea level
      let bx = px, bz = pz, by = py;
      for (let a = 0; a < 12; a += 1) {           // sample a ring, take the lowest
        const ang = (a / 12) * Math.PI * 2;
        const sx = px + Math.cos(ang) * 0.5, sz = pz + Math.sin(ang) * 0.5;
        const sy = surfaceY(sx, sz);
        if (sy < by - 0.002) { bx = sx; bz = sz; by = sy; }
      }
      if (bx === px && bz === pz) break;          // local minimum — pooled, stop
      px = bx; pz = bz; py = by;
    }
    if (path.length < 3) continue;
    // build a ribbon: perpendicular offsets at each point, triangle strip
    const pos: number[] = [], uv: number[] = [];
    let run = 0;
    for (let i = 0; i < path.length; i += 1) {
      const prev = path[Math.max(0, i - 1)], next = path[Math.min(path.length - 1, i + 1)];
      let dx = next.x - prev.x, dz = next.z - prev.z;
      const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      if (i > 0) run += path[i].distanceTo(path[i - 1]);
      const half = 0.16 + Math.min(0.22, i * 0.01);   // widens downstream
      const lx = path[i].x - dz * half, lz = path[i].z + dx * half;
      const rx = path[i].x + dz * half, rz = path[i].z - dx * half;
      pos.push(lx, path[i].y, lz, rx, path[i].y, rz);
      uv.push(run, 0, run, 1);
    }
    const idx: number[] = [];
    for (let i = 0; i < path.length - 1; i += 1) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({
      color: 0x8fd0ce, transparent: true, opacity: 0.62, depthWrite: false,
      side: THREE.DoubleSide, map: streakTexture(),
    });
    mat.map!.wrapS = mat.map!.wrapT = THREE.RepeatWrapping;
    mat.map!.repeat.set(0.5, 1);
    streamMats.push(mat);
    streamGroup.add(new THREE.Mesh(geo, mat));
  }
  terrainGroup?.add(streamGroup);
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
      const mesh = new THREE.Mesh(geo, [lamS(pal().shelf[0]), lamS(pal().shelf[1])]);
      mesh.receiveShadow = true;
      terrainGroup.add(mesh);
    }
  }

  // One plate per level: smooth contour -> Shape (with holes) -> extrusion with
  // a soft bevel lip. Flat tops, smooth vertical walls, authored silhouette.
  // Colours come from the active world palette (toggleable looks, not one stock).
  const topColors = [pal().beach, ...pal().tops];
  // every terrain surface shares the brush wash + per-vertex macro tint
  const washed = (color: number): THREE.MeshLambertMaterial => {
    const m = lamS(color);
    m.map = brushTexture();
    m.vertexColors = true;
    patchTint(m);          // per-pixel yellow↔blue tone patches over the surface
    return m;
  };
  const wallLow = washed(pal().wallLow);       // wet-sand base walls
  const wallHigh = washed(pal().wallHigh);     // rock walls above
  const BEV = 0.12;
  const dress = new THREE.Group();             // rim grass + wall-foot rocks
  const tuftMat = lamS(pal().tuft);
  const rockMat = lam(pal().dressRock);
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

  // Sun geometry sized to the island; its position now travels with the time
  // of day (see tick()), only the shadow frustum is fixed here.
  const cx = n / 2, cz = n / 2;
  islandCX = cx; islandCZ = cz;
  sun.position.set(cx - 52, 44, cz - 26);
  sun.target.position.set(cx, 0, cz);
  const s = n * 0.75;
  const shCam = sun.shadow.camera as THREE.OrthographicCamera;
  shCam.left = -s; shCam.right = s; shCam.top = s; shCam.bottom = -s;
  shCam.near = 10; shCam.far = 160;
  shCam.updateProjectionMatrix();

  // Sea + sky furniture follows the island.
  waterMesh.position.set(cx, 0, cz);
  if (skyMesh) skyMesh.position.set(cx, 0, cz);
  buildSurf(st);
  buildWaterfalls(n);
  buildStreams(st, n);
  buildSeaStacks(st, n);
  buildWaves(cx, cz, n);
  buildClouds(cx, cz, n);
  buildFog(cx, cz, n);
  buildSkyLife(cx, cz, n);
  buildGrass(st);
  buildFlora(st);

  // First-time camera framing: pulled back so the island floats in open sea.
  camera.position.set(cx + n * 0.12, n * 1.1, cz + n * 1.25);
  controls.target.set(cx, 0, cz);
  controls.update();
}

// SURF: the shoreline redesigned as a living painted swash zone. A single band
// mesh follows the true waterline (y=0 iso-contour of the smoothed heights),
// with UVs storing (arclength along the coast, signed distance from the
// shoreline). A shader rolls wave SETS toward the beach — phase-offset along
// the coast so they arrive in patches, never the whole ring at once — each
// crest breaking into brush-ragged foam, a thin lace holding at the waterline,
// and a wet-sand band on the land side that darkens after a wave and dries.
const SurfShader = {
  uniforms: {
    uTime: { value: 0 },
    uStorm: { value: 0 },
    uBrush: { value: null as THREE.Texture | null },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform float uTime;
    uniform float uStorm;
    uniform sampler2D uBrush;
    varying vec2 vUv;   // x: coast arclength, y: distance from shoreline (+sea)
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vn(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                 mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    void main() {
      float u = vUv.x;
      float d = vUv.y;
      float rate = 0.12 + uStorm * 0.10;
      float ph = vn(vec2(u * 0.09, 3.7));            // patches along the coast
      float cyc = uTime * rate + ph;
      float prog = fract(cyc);                       // one incoming wave cycle
      // every set has its own strength; some barely arrive
      float setA = 0.45 + 0.55 * vn(vec2(u * 0.05, floor(cyc) * 7.31));
      setA = mix(setA, 1.0, uStorm * 0.6);
      // crest travels from open water to the beach, tightening as it comes
      float crestD = mix(1.55, 0.02, prog);
      float w = 0.30 - 0.16 * prog;
      float crest = exp(-pow((d - crestD) / w, 2.0));
      float amp = 0.30 + 0.70 * smoothstep(0.1, 0.85, prog);
      float foam = crest * amp * setA;
      // thin standing lace right at the waterline, gently alive
      foam += exp(-pow(d / 0.09, 2.0)) * (0.45 + 0.25 * vn(vec2(u * 0.8, uTime * 0.3)));
      // brushy raggedness so the foam is paint, not a vector band
      float rag = texture2D(uBrush, vec2(u * 0.12 + ph, d * 0.35 + prog * 0.2)).r;
      foam *= 0.45 + 0.9 * rag;
      foam *= 1.0 - smoothstep(1.25, 1.6, d);        // dissolve seaward
      vec3 col = vec3(0.96, 0.99, 0.97);
      float alpha = clamp(foam, 0.0, 1.0) * 0.85 * step(0.0, d);
      // land side: wet sand right after the wave lands, drying until the next
      float wet = (0.16 + 0.5 * exp(-prog * 2.4) * setA)
                * smoothstep(0.02, -0.06, d) * (1.0 - smoothstep(0.18, 0.42, -d));
      col = mix(vec3(0.42, 0.38, 0.30), col, step(0.0, d));
      alpha += wet * (1.0 - step(0.0, d));
      gl_FragColor = vec4(col, alpha);
    }`,
};
let surfMat: THREE.ShaderMaterial | null = null;

function buildSurf(st: WorldState): void {
  foamGroup?.removeFromParent();
  foamGroup = new THREE.Group();
  const n = st.map.size;
  const land = (x: number, y: number) =>
    x >= 0 && y >= 0 && x <= n && y <= n && heightGrid[y][x] > 0.03;
  surfMat = new THREE.ShaderMaterial({
    ...SurfShader,
    uniforms: THREE.UniformsUtils.clone(SurfShader.uniforms),
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  surfMat.uniforms.uBrush.value = brushTexture();
  const ROWS = [-0.42, 0, 0.55, 1.6];        // land … shoreline … open water
  for (let loop of maskLoops(n + 1, land).map((l) => chaikin(l, 2))) {
    if (Math.abs(polyArea(loop)) < 3) continue;
    // outward = toward water: probe the smoothed height on each side
    const pos: number[] = [];
    const uvs: number[] = [];
    const m = loop.length;
    let arc = 0;
    for (let i = 0; i <= m; i += 1) {          // wrap: last ring repeats first
      const [px, pz] = loop[i % m];
      const [qx, qz] = loop[(i + 1) % m];
      const [ox, oz] = loop[(i - 1 + m) % m];
      if (i > 0) arc += Math.hypot(px - ox, pz - oz);
      const tx = qx - ox, tz = qz - oz;
      const tl = Math.hypot(tx, tz) || 1;
      let nx = -tz / tl, nz = tx / tl;
      if (rawHeightAt(px + nx * 0.7, pz + nz * 0.7) > 0.03) { nx = -nx; nz = -nz; }
      for (const r of ROWS) {
        pos.push(px + nx * r, 0.045, pz + nz * r);
        uvs.push(arc, r);
      }
    }
    const idx: number[] = [];
    const cols = ROWS.length;
    for (let i = 0; i < m; i += 1) {
      for (let c = 0; c < cols - 1; c += 1) {
        const a = i * cols + c, b = (i + 1) * cols + c;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
    geo.setIndex(idx);
    foamGroup.add(new THREE.Mesh(geo, surfMat));
  }
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
  rainMesh?.removeFromParent();
  cloudsGroup = new THREE.Group();
  // just below pure white: unlit slabs at 1.0 fed the bloom pass and glowed.
  // One material per cluster: tick() night-tints them AND fades any cloud
  // that drifts between the camera and the island (no more view-blocking).
  cloudMats = [];
  for (let i = 0; i < 7; i += 1) {
    const cluster = new THREE.Group();
    const r = hashStr(`cloud${i}`);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xdfe6e2, transparent: true, opacity: 0.92,
    });
    cloudMats.push(mat);
    const slabs = 2 + Math.floor(hashStr(`cs${i}`) * 3);
    for (let b = 0; b < slabs; b += 1) {
      const rb = hashStr(`cloud${i}b${b}`);
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(2.2 + rb * 3.2, 0.45 + rb * 0.35, 1.3 + rb * 1.3), mat);
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
  // cirrus: three flat painted streaks very high up — they fill the empty top
  // third of the frame without competing with the slab clouds
  const streak = (() => {
    const cv = document.createElement("canvas");
    cv.width = 256; cv.height = 64;
    const ctx = cv.getContext("2d")!;
    for (const [sx, sy, r, a] of [[70, 34, 60, 0.5], [140, 28, 80, 0.6], [200, 36, 50, 0.45]] as const) {
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
      g.addColorStop(0, `rgba(255,255,255,${a})`);
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.save();
      ctx.translate(sx, sy);
      ctx.scale(1, 0.22);
      ctx.translate(-sx, -sy);
      ctx.fillStyle = g;
      ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
      ctx.restore();
    }
    return new THREE.CanvasTexture(cv);
  })();
  cirrusMat = new THREE.SpriteMaterial({
    map: streak, transparent: true, opacity: 0.3, depthWrite: false, fog: false,
  });
  for (let i = 0; i < 3; i += 1) {
    const c = new THREE.Sprite(cirrusMat);
    const a = i * 2.4 + 0.8;
    c.position.set(cx + Math.cos(a) * n * (0.8 + i * 0.2), 27 + i * 5,
      cz + Math.sin(a) * n * 0.9);
    c.scale.set(30 + i * 9, 4 + i, 1);
    cloudsGroup.add(c);
  }
  markDecor(cloudsGroup);
  scene.add(cloudsGroup);

  // rain: slanted streaks over the island, alive only while a storm blows
  const DROPS = 560;
  rainBase = new Float32Array(DROPS * 4);
  const rp = new Float32Array(DROPS * 6);
  for (let i = 0; i < DROPS; i += 1) {
    rainBase[i * 4] = cx + (hashStr(`rx${i}`) - 0.5) * n * 1.25;
    rainBase[i * 4 + 1] = hashStr(`ry${i}`) * 14;
    rainBase[i * 4 + 2] = cz + (hashStr(`rz${i}`) - 0.5) * n * 1.25;
    rainBase[i * 4 + 3] = 9 + hashStr(`rv${i}`) * 5;
  }
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute("position", new THREE.BufferAttribute(rp, 3));
  rainMesh = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({
    color: 0xd4e2ec, transparent: true, opacity: 0, depthWrite: false,
  }));
  rainMesh.frustumCulled = false;
  markDecor(rainMesh);
  scene.add(rainMesh);
}

// GRASS: one InstancedMesh of small blade fans scattered over every meadow
// tile — the plains stop being flat green felt. The wind lives in the vertex
// shader (tips bend by height, phase from the instance's world position), so
// thousands of tufts sway for the cost of one draw call.
let grassMesh: THREE.InstancedMesh | null = null;
let grassShader: { uniforms: Record<string, { value: number }> } | null = null;
let grassStructCount = -1;                 // regrow when the camp changes
let grassDay = -1;                         // …and morph with every sim day

function bladeGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const BLADES = 7;
  for (let i = 0; i < BLADES; i += 1) {
    const a = (i / BLADES) * Math.PI * 2 + i * 0.7;
    const bx = Math.cos(a) * 0.035, bz = Math.sin(a) * 0.035;
    const h = 0.14 + (i % 3) * 0.05;
    const lean = 0.05 + (i % 2) * 0.04;
    const tx = bx + Math.cos(a) * lean, tz = bz + Math.sin(a) * lean;
    const wx = -Math.sin(a) * 0.016, wz = Math.cos(a) * 0.016;
    pos.push(bx - wx, 0, bz - wz, bx + wx, 0, bz + wz, tx, h, tz);
    // dark at the root, light at the tip — blades read as grass, not specks
    col.push(0.58, 0.58, 0.58, 0.58, 0.58, 0.58, 1.14, 1.14, 1.14);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(col), 3));
  geo.computeVertexNormals();
  return geo;
}

// The meadow GROWS instead of being sprinkled: a low-frequency lushness field
// gates and scales every tuft (dense tall hearts of green fading to bare
// ground), undergrowth hugs the tree trunks, springs grow lush rings, flowers
// drift in their own patches — and the ground around every structure is
// trampled bare, so the camp visibly lives in a clearing.
function buildGrass(st: WorldState): void {
  grassMesh?.removeFromParent();
  grassMesh = null;
  grassStructCount = st.structures.length;
  grassDay = st.day;
  const n = st.map.size;
  const day = st.day || 0;
  // seasons: the noise domain drifts a little every sim day (patches migrate,
  // thicken, die back) and a slow global wave makes lush days and lean days
  const gLush = 0.86 + 0.22 * Math.sin(day * 0.55 + 2.0);
  const spots: { x: number; y: number; z: number; sx: number; sy: number; c: THREE.Color }[] = [];
  const base = new THREE.Color(0x7fb35c);
  const sstep = (a: number, b: number, x: number): number => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const clearings = st.structures.map((s) => ({
    x: s.x + (s.w || 1) / 2, z: s.y + (s.h || 1) / 2,
    r: Math.max(s.w || 1, s.h || 1) / 2 + 1.0,
  }));
  const trampled = (x: number, z: number) =>
    clearings.some((c) => (x - c.x) ** 2 + (z - c.z) ** 2 < c.r * c.r);
  const put = (wx: number, wz: number, lush: number, sA: number, sB: number,
               forceTall = false): void => {
    const gy = heightAt(wx, wz);
    if (gy < 0.6 || trampled(wx, wz)) return;
    const c = base.clone();
    // deep hearts of a patch grow TALL grass — reeds you could hide in
    const tall = forceTall || (lush > 0.85 && sB > 0.7);
    // flowers drift in their own patches inside the lush zones
    if (!tall && vnoise(wx, wz, 4, 207) > 0.72 && sB < 0.4 && lush > 0.45) {
      c.setHex(sA < 0.5 ? 0xf2e2b8 : 0xe8b8c8);
    } else if (tall) {
      c.offsetHSL(-0.025 + (sA - 0.5) * 0.04, 0.05, -0.05 + (sB - 0.5) * 0.06);
    } else {
      c.offsetHSL((sA - 0.5) * 0.07, lush * 0.06,
        (sB - 0.5) * 0.10 + lush * 0.06 - 0.04);
    }
    const s = (0.6 + lush * 0.82) * (0.75 + sB * 0.45);
    spots.push({
      x: wx, y: gy, z: wz,
      sx: tall ? s * 1.2 : s, sy: tall ? s * 2.05 : s, c,
    });
  };
  for (let ty = 0; ty < n; ty += 1) {
    for (let tx = 0; tx < n; tx += 1) {
      const t = st.map.grid[ty][tx];
      const isGrass = t.includes("grass") && !t.includes("water");
      const isFol = t.includes("foliage");
      if (!isGrass && !isFol) continue;
      for (let k = 0; k < 7; k += 1) {
        const wx = tx + hash01(tx, ty, 140 + k);
        const wz = ty + hash01(tx, ty, 150 + k);
        // lushness: two noise octaves shape MEADOW PATCHES, not uniform noise;
        // the domain drifts with the sim day, so patches live their own lives
        const field = vnoise(wx + day * 1.9, wz - day * 1.3, 8, 201) * 0.65
          + vnoise(wx - day * 0.8, wz + day * 1.1, 3.5, 203) * 0.35;
        const lush = sstep(0.4, 0.77, field);
        // MOISTURE by elevation: valleys and coastal flats stay green, high dry
        // ridges thin out toward bare rock — an ecological gradient, not a lawn
        const moist = 1 - sstep(1.4, 3.8, heightAt(wx, wz)) * 0.6;
        const keep = lush * gLush * (isFol ? 0.62 : 1.0) * moist;
        if (hash01(tx, ty, 130 + k) > keep) continue;
        put(wx, wz, lush, hash01(tx, ty, 172 + k), hash01(tx, ty, 184 + k));
      }
    }
  }
  // growth follows the features: undergrowth at tree feet, lush spring rings
  for (const node of st.resources) {
    if (node.quantity <= 0) continue;
    const cx = node.x + 0.5, cz = node.y + 0.5;
    if (node.kind === "spring") {
      for (let i = 0; i < 12; i += 1) {
        const a = hashStr(`${node.id}sa${i}`) * Math.PI * 2;
        const r = 0.65 + hashStr(`${node.id}sr${i}`) * 0.8;
        put(cx + Math.cos(a) * r, cz + Math.sin(a) * r, 0.95,
          hashStr(`${node.id}sc${i}`), hashStr(`${node.id}sd${i}`));
      }
    } else if (node.kind === "wood" || node.kind === "fruit_tree") {
      for (let i = 0; i < 3; i += 1) {
        const a = hashStr(`${node.id}ta${i}`) * Math.PI * 2;
        const r = 0.4 + hashStr(`${node.id}tr${i}`) * 0.45;
        put(cx + Math.cos(a) * r, cz + Math.sin(a) * r, 0.7,
          hashStr(`${node.id}tc${i}`), hashStr(`${node.id}td${i}`));
      }
    } else if (node.kind === "thicket") {
      // fiber thickets read as actual TALL-GRASS stands
      for (let i = 0; i < 6; i += 1) {
        const a = hashStr(`${node.id}ka${i}`) * Math.PI * 2;
        const r = 0.3 + hashStr(`${node.id}kr${i}`) * 0.45;
        put(cx + Math.cos(a) * r, cz + Math.sin(a) * r, 0.9,
          hashStr(`${node.id}kc${i}`), hashStr(`${node.id}kd${i}`), true);
      }
    }
  }
  if (!spots.length) return;
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uWind = { value: 0.4 };
    shader.vertexShader = "uniform float uTime;\nuniform float uWind;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         #ifdef USE_INSTANCING
         float iph = instanceMatrix[3][0] * 0.9 + instanceMatrix[3][2] * 0.7;
         transformed.x += sin(uTime * 1.7 + iph) * transformed.y * uWind;
         transformed.z += cos(uTime * 1.3 + iph * 1.4) * transformed.y * uWind * 0.6;
         #endif`,
      );
    grassShader = shader as unknown as { uniforms: Record<string, { value: number }> };
  };
  grassMesh = new THREE.InstancedMesh(bladeGeometry(), mat, spots.length);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const sc = new THREE.Vector3();
  for (let i = 0; i < spots.length; i += 1) {
    const sp = spots[i];
    q.setFromAxisAngle(up, hashStr(`ga${i}`) * Math.PI * 2);
    sc.set(sp.sx, sp.sy, sp.sx);
    m4.compose(new THREE.Vector3(sp.x, sp.y, sp.z), q, sc);
    grassMesh.setMatrixAt(i, m4);
    grassMesh.setColorAt(i, sp.c);
  }
  grassMesh.receiveShadow = true;
  grassMesh.frustumCulled = false;           // geometry bounds ≠ instance bounds
  markDecor(grassMesh);                      // no ink outlines on 1000 tufts
  scene.add(grassMesh);
}

// Sky life: gulls circling the island by day, butterflies over the meadows.
// Tiny primitive assemblies animated in tick(); they retire at night.
// One soft round wisp — the mist banks are made of many of these, so their
// edges are always feathered (never the hard white slab a clipped ground plane
// produced).
function fogSpriteTexture(): THREE.Texture {
  const s = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d")!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,255,0.55)");
  g.addColorStop(0.45, "rgba(255,255,255,0.22)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(cv);
}

// Volumetric ground fog: a low band of wide, soft, camera-facing wisps hugging
// the shore and lowlands. Feathered on every side (soft sprites), faint, and
// drifting — densest at dawn and dusk (opacity driven in tick()).
function buildFog(cx: number, cz: number, n: number): void {
  fogGroup?.removeFromParent();
  fogGroup = new THREE.Group();
  fogSprites = [];
  const tex = fogSpriteTexture();
  const COUNT = 16;
  for (let i = 0; i < COUNT; i += 1) {
    const r0 = hashStr(`fog${i}`), r1 = hashStr(`fg${i}b`), r2 = hashStr(`fg${i}c`);
    const mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, opacity: 0, depthWrite: false, fog: false,
    });
    const spr = new THREE.Sprite(mat);
    const a = i * 2.39996 + r0 * 0.8;
    // bias to the coast/water ring rather than the central basin, so the mist
    // haloes the shoreline instead of pooling into an opaque white patch inland
    const rad = n * (0.26 + 0.5 * Math.sqrt((i + r1) / COUNT));
    const w = 10 + r2 * 12;
    spr.scale.set(w, w * 0.36, 1);                 // wide + low → a mist band
    spr.position.set(cx + Math.cos(a) * rad, 0.45 + r0 * 1.0, cz + Math.sin(a) * rad * 0.9);
    spr.userData = { speed: 0.12 + r1 * 0.22, baseA: 0.05 + r2 * 0.045,
                     y: spr.position.y, phase: r0 * 6.28 };
    fogGroup.add(spr);
    fogSprites.push(spr);
  }
  markDecor(fogGroup);
  scene.add(fogGroup);
}

function buildSkyLife(cx: number, cz: number, n: number): void {
  skyLifeGroup?.removeFromParent();
  skyLifeGroup = new THREE.Group();
  birds = [];
  butterflies = [];
  const birdMat = new THREE.MeshLambertMaterial({ color: 0x37424a, side: THREE.DoubleSide });
  for (let f = 0; f < 2; f += 1) {
    const flockCx = cx + (hashStr(`fx${f}`) - 0.5) * n * 0.5;
    const flockCz = cz + (hashStr(`fz${f}`) - 0.5) * n * 0.5;
    const count = 3 + Math.floor(hashStr(`fc${f}`) * 2);
    for (let i = 0; i < count; i += 1) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.03, 0.1, 2, 5), birdMat);
      body.rotation.x = Math.PI / 2;
      g.add(body);
      const wings: THREE.Mesh[] = [];
      for (const sx of [-1, 1]) {
        const wing = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.07), birdMat);
        wing.geometry.translate(sx * 0.11, 0, 0);        // pivot at the body
        wing.rotation.x = -Math.PI / 2;
        wings.push(wing);
        g.add(wing);
      }
      skyLifeGroup.add(g);
      birds.push({
        g, wings, cx: flockCx, cz: flockCz,
        r: 4.5 + hashStr(`fr${f}${i}`) * 4,
        h: 7 + hashStr(`fh${f}${i}`) * 3.5,
        speed: 0.28 + hashStr(`fs${f}${i}`) * 0.1,
        phase: (i / count) * Math.PI * 2 + hashStr(`fp${f}`) * 6.28,
      });
    }
  }
  const wingCols = [0xf2e3c0, 0xe8a45c, 0xd9788a, 0xcfe0f0];
  for (let i = 0; i < 5; i += 1) {
    // anchor over a meadow: rejection-sample land above the beach
    let bx = cx, bz = cz, ok = false;
    for (let t = 0; t < 14 && !ok; t += 1) {
      bx = cx + (hashStr(`bx${i}t${t}`) - 0.5) * n * 0.7;
      bz = cz + (hashStr(`bz${i}t${t}`) - 0.5) * n * 0.7;
      ok = heightAt(bx, bz) > 0.5;
    }
    if (!ok) continue;
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({
      color: wingCols[i % wingCols.length], side: THREE.DoubleSide,
    });
    const wings: THREE.Mesh[] = [];
    for (const sx of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.07), mat);
      wing.geometry.translate(sx * 0.045, 0, 0);
      wing.rotation.x = -Math.PI / 2;
      wings.push(wing);
      g.add(wing);
    }
    skyLifeGroup.add(g);
    butterflies.push({
      g, wings, seed: hashStr(`bs${i}`) * 20,
      base: new THREE.Vector3(bx, heightAt(bx, bz) + 0.5, bz),
    });
  }
  markDecor(skyLifeGroup);
  scene.add(skyLifeGroup);
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
    const frondMat = new THREE.MeshLambertMaterial({
      color: jitterLeaf(i % 2 ? C.leaf : C.leafDark, id + "fc" + i),
      flatShading: true, side: THREE.DoubleSide,
    });
    smudgeNormals(frondMat);
    const blade = new THREE.Mesh(
      frondGeometry(0.72 + fr * 0.25, 0.2 + fr * 0.06, 0.5 + fr * 0.25),
      frondMat,
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
  const mat = lamJLeaf(C.leaf, id);
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
  const R = 0.2 + r * 0.16;
  const rock = new THREE.Mesh(
    new THREE.DodecahedronGeometry(R, 0),
    new THREE.MeshLambertMaterial({ color: tint, flatShading: true }),
  );
  rock.position.y = 0.12;
  rock.rotation.set(r * 3, r * 7, r * 5);
  rock.scale.y = 0.7;
  rock.castShadow = true;
  g.add(rock);
  // damp island → moss creeps over the crown of most stones (flattened crusts
  // of dark green hugging the top). Ore rock (grey-brown) stays barer.
  const mv = hashStr(id + "moss");
  if (mv > 0.4) {
    const mossMat = new THREE.MeshLambertMaterial({ color: 0x50663a, flatShading: true });
    const patches = 2 + Math.floor(mv * 3);
    for (let i = 0; i < patches; i += 1) {
      const a = mv * 17 + i * 2.2;
      const rad = R * (0.15 + hashStr(id + "mr" + i) * 0.5);
      const patch = new THREE.Mesh(
        new THREE.IcosahedronGeometry(R * (0.24 + hashStr(id + "ms" + i) * 0.18), 0), mossMat);
      patch.position.set(Math.cos(a) * rad, 0.12 + R * (0.32 + hashStr(id + "mh" + i) * 0.18), Math.sin(a) * rad);
      patch.scale.set(1, 0.32, 1);   // crust, not a blob
      patch.rotation.y = a;
      g.add(patch);
    }
  }
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
      breathers.push({ m: blob, phase: ri * 21, amp: 0.015, base: 1 });
    }
  } else {
    const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22 + r * 0.08, 0), mat);
    bush.position.y = 0.14;
    bush.scale.y = 0.75;
    bush.castShadow = true;
    g.add(bush);
    breathers.push({ m: bush, phase: r * 19, amp: 0.015, base: 1 });
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

// ── ground flora ──────────────────────────────────────────────────────────────
// Wildflowers, ferns, mushrooms and beach driftwood scattered over the island so
// the meadow reads as ALIVE (colour!) and the jungle floor and beaches have
// detail — not one flat green. Everything of a kind is MERGED into a single
// vertex-coloured mesh (≈3 draw calls total), so the variety is nearly free.
const FLOWER_HUES = [0xf3f0e6, 0xf5d24b, 0xe8749a, 0xe06a4a, 0xb98cd6, 0xff9e57];

// Give a small part geometry a flat vertex colour and normalise its attributes
// so a batch of them can be merged into one mesh.
function bakeColor(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  // Force NON-indexed everywhere: primitives mix indexed (cylinder/sphere) and
  // non-indexed (icosahedron), and mergeGeometries refuses a mix.
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute("uv");
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  const c = new THREE.Color(hex);
  const cnt = g.getAttribute("position").count;
  const col = new Float32Array(cnt * 3);
  for (let i = 0; i < cnt; i += 1) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return g;
}

function buildFlora(st: WorldState): void {
  floraGroup?.removeFromParent();
  floraGroup = new THREE.Group();
  const n = st.map.size;
  const flowers: THREE.BufferGeometry[] = [];
  const ferns: THREE.BufferGeometry[] = [];
  const shrooms: THREE.BufferGeometry[] = [];
  const drift: THREE.BufferGeometry[] = [];
  const tufts: THREE.BufferGeometry[] = [];   // grass tufts + pebbles (merged undergrowth)
  const tuftHi = new THREE.Color(pal().meadow), tuftLo = new THREE.Color(pal().tuft);
  const pebbleHex = pal().dressRock;
  const canopy: THREE.BufferGeometry[] = [];  // jungle canopy blobs (was 100s of meshes)
  const trunks: THREE.BufferGeometry[] = [];  // their stems + dead snags
  const SNAG = pal().canopySnag;
  // rotate about the item's base, then drop it onto its world spot
  const at = (geo: THREE.BufferGeometry, wx: number, wz: number, gy: number, rot: number) => {
    if (rot) geo.rotateY(rot);
    geo.translate(wx, gy, wz);
    return geo;
  };
  for (let ty = 0; ty < n; ty += 1) {
    for (let tx = 0; tx < n; tx += 1) {
      const tile = st.map.grid[ty][tx];
      const grass = tile.includes("grass"), fol = tile.includes("foliage");
      const sand = tile.includes("sand") && !tile.includes("water");

      if (grass && hash01(tx, ty, 700) < 0.5) {           // undergrowth: tufts + pebbles
        const cnt = 1 + Math.floor(hash01(tx, ty, 701) * 2);
        for (let i = 0; i < cnt; i += 1) {
          const wx = tx + hash01(tx, ty, 710 + i) * 0.85 + 0.08;
          const wz = ty + hash01(tx, ty, 720 + i) * 0.85 + 0.08;
          const gy = groundY(wx, wz); if (gy < 0.18) continue;
          const rr = hash01(tx, ty, 730 + i);
          if (rr < 0.24) {                                  // a pebble
            const pr = 0.03 + hash01(tx, ty, 740 + i) * 0.04;
            const peb = new THREE.IcosahedronGeometry(pr, 0);
            peb.scale(1, 0.7, 1); peb.translate(0, pr * 0.35, 0);
            tufts.push(at(bakeColor(peb, pebbleHex), wx, wz, gy, rr * 6));
          } else {                                          // a fan of 3 grass blades
            const blades = 3;
            const tint = tuftLo.clone().lerp(tuftHi, hash01(tx, ty, 745 + i));
            for (let b = 0; b < blades; b += 1) {
              const bh = 0.1 + hash01(tx, ty, 750 + i * 3 + b) * 0.14;
              const bl = new THREE.CylinderGeometry(0.004, 0.016, bh, 3); bl.translate(0, bh / 2, 0);
              bl.rotateZ((b - 1) * 0.32 + (hash01(tx, ty, 760 + b) - 0.5) * 0.2);
              tufts.push(at(bakeColor(bl, tint.getHex()), wx, wz, gy, (b / blades) * 6.28 + rr * 3));
            }
          }
        }
      }
      if (grass && hash01(tx, ty, 410) < 0.17) {          // wildflowers in the meadow
        const cnt = 1 + Math.floor(hash01(tx, ty, 411) * 3);
        for (let i = 0; i < cnt; i += 1) {
          const wx = tx + hash01(tx, ty, 420 + i) * 0.8 + 0.1;
          const wz = ty + hash01(tx, ty, 430 + i) * 0.8 + 0.1;
          const gy = groundY(wx, wz); if (gy < 0.2) continue;
          const rr = hash01(tx, ty, 440 + i);
          const hue = FLOWER_HUES[Math.floor(hash01(tx, ty, 450 + i) * FLOWER_HUES.length)];
          const h = 0.12 + rr * 0.07;
          const stem = new THREE.CylinderGeometry(0.007, 0.01, h, 3); stem.translate(0, h / 2, 0);
          const bloom = new THREE.IcosahedronGeometry(0.045 + rr * 0.025, 0); bloom.scale(1, 0.5, 1); bloom.translate(0, h + 0.01, 0);
          const ctr = new THREE.SphereGeometry(0.016, 4, 3); ctr.translate(0, h + 0.02, 0);
          flowers.push(at(bakeColor(stem, 0x5f7a3a), wx, wz, gy, 0));
          flowers.push(at(bakeColor(bloom, hue), wx, wz, gy, rr * 6));
          flowers.push(at(bakeColor(ctr, 0xf6e27a), wx, wz, gy, 0));
        }
      }
      if (fol && hash01(tx, ty, 460) < 0.16) {            // ferns on the jungle floor
        const wx = tx + hash01(tx, ty, 461) * 0.8 + 0.1;
        const wz = ty + hash01(tx, ty, 462) * 0.8 + 0.1;
        const gy = groundY(wx, wz); if (gy < 0.2) continue;
        for (let i = 0; i < 5; i += 1) {
          const L = 0.16 + hash01(tx, ty, 470 + i) * 0.1;
          const fr = new THREE.CylinderGeometry(0.003, 0.013, L, 3); fr.translate(0, L / 2, 0);
          fr.rotateZ(0.5 + hash01(tx, ty, 480 + i) * 0.35);
          ferns.push(at(bakeColor(fr, 0x3f6b30), wx, wz, gy, (i / 5) * 6.28 + hash01(tx, ty, 490) * 3));
        }
      }
      if (fol && hash01(tx, ty, 500) < 0.05) {            // mushroom clusters in shade
        const wx = tx + hash01(tx, ty, 501) * 0.7 + 0.15;
        const wz = ty + hash01(tx, ty, 502) * 0.7 + 0.15;
        const gy = groundY(wx, wz); if (gy < 0.2) continue;
        const cnt = 1 + Math.floor(hash01(tx, ty, 503) * 2);
        const cap = hash01(tx, ty, 504) < 0.5 ? 0xb5472e : 0xc98a4a;
        for (let i = 0; i < cnt; i += 1) {
          const ox = (hash01(tx, ty, 510 + i) - 0.5) * 0.16, oz = (hash01(tx, ty, 520 + i) - 0.5) * 0.16;
          const sh = 0.05 + hash01(tx, ty, 530 + i) * 0.03;
          const stem = new THREE.CylinderGeometry(0.012, 0.016, sh, 4); stem.translate(ox, sh / 2, oz);
          const head = new THREE.SphereGeometry(0.03, 5, 3, 0, 6.283, 0, 1.57); head.scale(1, 0.7, 1); head.translate(ox, sh, oz);
          shrooms.push(at(bakeColor(stem, 0xe8ddc4), wx, wz, gy, 0));
          shrooms.push(at(bakeColor(head, cap), wx, wz, gy, 0));
        }
      }
      if (fol && hash01(tx, ty, 91) < 0.47) {             // jungle canopy (merged masses)
        const cnt = hash01(tx, ty, 91) < 0.16 ? 2 : 1;
        for (let k = 0; k < cnt; k += 1) {
          const wx = tx + hash01(tx, ty, 92 + k) * 0.8 + 0.1;
          const wz = ty + hash01(tx, ty, 95 + k) * 0.8 + 0.1;
          const gy = groundY(wx, wz); if (gy < 0.15) continue;
          if (hash01(tx, ty, 106 + k) < 0.07) {            // rare dead snag
            const sh = 0.5 + hash01(tx, ty, 107 + k) * 0.5;
            const tr = new THREE.CylinderGeometry(0.03, 0.06, sh, 5); tr.translate(0, sh / 2, 0);
            tr.rotateZ((hash01(tx, ty, 108 + k) - 0.5) * 0.22);
            trunks.push(at(bakeColor(tr, SNAG), wx, wz, gy, 0));
            for (let b = 0; b < 3; b += 1) {
              const ba = hash01(tx, ty, 116 + b) * 6.28;
              const bl = new THREE.CylinderGeometry(0.012, 0.02, 0.16 + hash01(tx, ty, 114 + b) * 0.12, 4);
              bl.translate(0, sh * (0.55 + b * 0.15), 0);
              bl.rotateZ(0.9 + hash01(tx, ty, 119 + b) * 0.4);
              trunks.push(at(bakeColor(bl, SNAG), wx + Math.cos(ba) * 0.05, wz + Math.sin(ba) * 0.05, gy, ba));
            }
            continue;
          }
          // Phase 2 — biome by elevation: low jungle is broad + warm green; the
          // higher the plate, the darker, cooler and more spire-like the crown
          // (a conifer-belt read), so the tiers each have their own silhouette.
          const lvl = plateLevelAt(wx, wz);
          const highland = lvl >= 3;
          const s = 0.3 + hash01(tx, ty, 98 + k) * 0.3;
          const tall = highland || hash01(tx, ty, 102 + k) < 0.22;
          const stemH = tall ? s * 1.7 : s;
          const baseGreen = new THREE.Color(pal().canopy);
          if (highland) baseGreen.offsetHSL(-0.03, -0.06, -0.12);   // darker, cooler
          const green = jitter(baseGreen.getHex(), `can${tx},${ty},${k}`, 0.12).getHex();
          const blob = new THREE.IcosahedronGeometry(s, 0);
          blob.scale(highland ? 0.78 : 1, highland ? 1.35 : 0.8, highland ? 0.78 : 1);
          blob.translate(wx, gy + stemH + s * 0.35, wz);
          canopy.push(bakeColor(blob, green));
          const stem = new THREE.CylinderGeometry(0.04, 0.05, stemH, 4); stem.translate(wx, gy + stemH * 0.5, wz);
          trunks.push(bakeColor(stem, C.trunk));
          if (tall) {
            const top = new THREE.IcosahedronGeometry(s * 0.55, 0);
            if (highland) top.scale(0.7, 1.4, 0.7);
            top.translate(wx + (highland ? 0 : 0.08), gy + stemH + s * (highland ? 1.15 : 0.95), wz);
            canopy.push(bakeColor(top, green));
          }
        }
      }
      if (sand && hash01(tx, ty, 540) < 0.045) {          // driftwood on the beach
        const wx = tx + hash01(tx, ty, 541) * 0.7 + 0.15;
        const wz = ty + hash01(tx, ty, 542) * 0.7 + 0.15;
        const gy = groundY(wx, wz); if (gy < 0.05 || gy > 0.5) continue;
        const rot = hash01(tx, ty, 543) * 6.28;
        const L = 0.3 + hash01(tx, ty, 544) * 0.22;
        const a = new THREE.CylinderGeometry(0.025, 0.032, L, 5); a.rotateZ(1.45); a.translate(0, 0.03, 0);
        const b = new THREE.CylinderGeometry(0.018, 0.024, L * 0.55, 5); b.rotateZ(1.1); b.translate(L * 0.34, 0.05, 0.03);
        drift.push(at(bakeColor(a, 0xb8ab96), wx, wz, gy, rot));
        drift.push(at(bakeColor(b, 0xa89880), wx, wz, gy, rot));
      }
    }
  }
  // Wetland reeds ringing the inland ponds — tall, thin, olive; vegetation
  // follows the water, as it should.
  for (const node of st.resources) {
    if (node.quantity <= 0 || node.kind !== "spring") continue;
    const cx = node.x + 0.5, cz = node.y + 0.5;
    const reeds = 11 + Math.floor(hash01(node.x, node.y, 600) * 9);
    for (let i = 0; i < reeds; i += 1) {
      const a = hash01(node.x, node.y, 610 + i) * 6.283;
      const rad = 0.68 + hash01(node.x, node.y, 630 + i) * 0.55;
      const wx = cx + Math.cos(a) * rad, wz = cz + Math.sin(a) * rad;
      const gy = groundY(wx, wz); if (gy < 0.2) continue;
      const L = 0.32 + hash01(node.x, node.y, 650 + i) * 0.28;
      const reed = new THREE.CylinderGeometry(0.004, 0.014, L, 3); reed.translate(0, L / 2, 0);
      reed.rotateZ((hash01(node.x, node.y, 670 + i) - 0.5) * 0.3);
      ferns.push(at(bakeColor(reed, 0x6f9a3e), wx, wz, gy, a));
    }
  }

  // Cliff dressing (phase 3): scree at the FOOT of tall walls. A tile that sits
  // 2+ plates below a near neighbour is a cliff base — pile weathered boulders
  // there so walls meet the ground in rubble, not a clean seam. Merged, so a few
  // hundred boulders cost one draw call.
  const scree: THREE.BufferGeometry[] = [];
  const screeLo = new THREE.Color(pal().dressRock), screeHi = new THREE.Color(pal().wallHigh);
  for (let ty = 1; ty < n - 1; ty += 1) {
    for (let tx = 1; tx < n - 1; tx += 1) {
      if (st.map.grid[ty][tx].includes("water")) continue;
      const lv = plateLevelAt(tx + 0.5, ty + 0.5);
      let hi = false;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const)
        if (plateLevelAt(tx + 0.5 + dx * 1.6, ty + 0.5 + dz * 1.6) >= lv + 2) hi = true;
      if (!hi || hash01(tx, ty, 800) > 0.7) continue;
      const cnt = 2 + Math.floor(hash01(tx, ty, 801) * 3);
      for (let i = 0; i < cnt; i += 1) {
        const wx = tx + hash01(tx, ty, 810 + i) * 0.9 + 0.05;
        const wz = ty + hash01(tx, ty, 820 + i) * 0.9 + 0.05;
        const gy = groundY(wx, wz); if (gy < 0.12) continue;
        const rr = hash01(tx, ty, 830 + i);
        const br = 0.06 + rr * 0.13;
        const rock = new THREE.DodecahedronGeometry(br, 0);
        rock.scale(1, 0.7 + rr * 0.4, 1);
        rock.translate(wx, gy + br * 0.4, wz);
        scree.push(bakeColor(rock, screeLo.clone().lerp(screeHi, rr).getHex()));
      }
    }
  }

  const addMerged = (geos: THREE.BufferGeometry[]) => {
    if (!geos.length) return;
    const merged = mergeGeometries(geos, false);
    if (!merged) return;
    const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    mesh.castShadow = true;
    mesh.frustumCulled = false;   // one mesh spanning the whole island
    floraGroup!.add(mesh);
  };
  addMerged(flowers); addMerged(ferns); addMerged(shrooms); addMerged(drift);
  addMerged(tufts); addMerged(canopy); addMerged(trunks); addMerged(scree);
  scene.add(floraGroup);
}

// A ready-to-place clone of a loaded GLB (already normalised to world size,
// foot at y=0). Null until the model finishes loading — callers fall back.
function cloneModel(key: string): THREE.Group | null {
  const m = models.get(key);
  return m ? (m.clone(true) as THREE.Group) : null;
}

const propReflMat = new THREE.MeshBasicMaterial({
  color: 0x16323a, transparent: true, opacity: 0.1, depthWrite: false,
});

// FNV-1a over a string, folded into a running 32-bit hash. Cheap enough to run
// over every id each sync; used to skip prop/struct rebuilds when nothing changed.
function fnv(h: number, s: string): number {
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h;
}
let propsSig = -1;
let structsSig = -1;

// Props (trees, rocks, ponds) change ONLY when a node crosses the render
// threshold (chopped / depleted). buildProps used to rebuild hundreds of meshes
// EVERY backend tick (~1/s) — the stutter the island "lagged" from. Now it's
// gated on this signature and rebuilds only on real change.
function propsSignature(st: WorldState): number {
  let h = 2166136261;
  for (const n of st.resources) if (n.quantity >= 1) h = fnv(h, n.id);
  return h | 0;
}
function structsSignature(st: WorldState): number {
  let h = 2166136261;
  for (const s of st.structures) {
    const lit = s.state?.complete && ((s.state?.fuel as number) ?? 0) > 0 ? "L" : "";
    h = fnv(h, `${s.id}:${s.kind}:${s.state?.complete ? 1 : 0}${lit}`);
  }
  return h | 0;
}

function buildProps(st: WorldState, force = false): void {
  const sig = propsSignature(st);
  if (!force && sig === propsSig && propsGroup) return;
  propsSig = sig;
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
    // authored rock/bush GLBs (low-poly), with the primitive as fallback until
    // the model loads. Stone alternates basalt/boulder for variety.
    else if (k === "rocks") obj = cloneModel(hashStr(node.id) < 0.5 ? "basalt" : "boulder") ?? makeRock(node.id);
    else if (k === "orerock") obj = cloneModel("amber_ore") ?? makeRock(node.id, 0x7d766c);
    else if (k === "thicket") obj = cloneModel("saltbush") ?? makeBush(node.id);
    else if (k === "shell_bed") obj = cloneModel("coral") ?? makeRock(node.id, 0xe8dcc8);
    else if (k === "fishing") {
      // a lever rig on the shore — the fishing node finally has a presence
      // (it rendered nothing before, being on sand where ponds are suppressed)
      obj = cloneModel("fishing_rig");
    }
    else if (k === "spring") {
      // no water body on the beach or bare rock — the sea is right there and a
      // fake pond reads wrong; ponds belong inland on grass/foliage. Uses both
      // hand-modelled variants (water / water2), primitive pool as fallback.
      const tile = st.map.grid[node.y]?.[node.x] ?? "";
      if (!(tile.includes("sand") || tile.includes("rock") || tile.includes("water"))) {
        obj = cloneModel(hashStr(node.id + "w") < 0.5 ? "water" : "water2") ?? makePool();
      }
    }
    if (!obj) continue;
    const wx = node.x + 0.5, wz = node.y + 0.5;
    // Pools seat through seatOnMesh at their REAL visual radius — a pond whose
    // rim overhangs a cliff slides back onto the terrace (a pond hovering on
    // air was the screenshot bug: the old sample radius was smaller than the
    // pool disc). Trees/rocks: median of a small ring — a palm leaning over a
    // lip is charming, standing on air is not.
    const isPool = k === "spring" || k === "fishing";
    let px = wx, pz = wz, gy: number;
    if (isPool) {
      const seat = seatOnMesh(wx, wz, 0.8, 1.6);
      px = seat.x; pz = seat.z; gy = Math.max(0.02, seat.y);
    } else {
      const rad = 0.2;
      const samples = [surfaceY(wx, wz),
        surfaceY(wx - rad, wz), surfaceY(wx + rad, wz),
        surfaceY(wx, wz - rad), surfaceY(wx, wz + rad)].sort((a, b) => a - b);
      gy = Math.max(0.02, samples[2]);
    }
    obj.position.set(px, gy, pz);
    // spin each prop to a stable per-id heading so a grove of palms/trees/rocks
    // doesn't read as clones all facing the same way (reflection clone inherits it)
    obj.rotation.y = hashStr(node.id + "yaw") * Math.PI * 2;
    propsGroup.add(obj);

    // shoreline trees lay a still dark reflection on the water (Bad North)
    if ((k === "wood" || k === "fruit_tree") && gy < 0.75) {
      const refl = obj.clone(true);
      refl.traverse((o) => {
        const mm = o as THREE.Mesh;
        if (mm.isMesh) { mm.material = propReflMat; mm.castShadow = false; }
      });
      refl.scale.y = -1;
      refl.position.set(wx, -gy - 0.05, wz);
      markDecor(refl);
      propsGroup.add(refl);
    }
  }

  // (decorative canopy groves moved to buildFlora — merged into ~2 draw calls,
  // built once per map instead of rebuilt on every node change.)

  // (undergrowth moved to buildFlora — it MERGES into ~1 draw call, and is built
  // once per map instead of rebuilt every tick like propsGroup was.)
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
// flicker in tick() — plus rising SPARKS and glowing embers. Registered
// globally so the animation loop can breathe life into every fire at once.
let flames: THREE.Mesh[] = [];
let sparks: THREE.Mesh[] = [];

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
  // sparks: tiny embers that ride the heat column, wander and die out
  for (let i = 0; i < 7; i += 1) {
    const sp = new THREE.Mesh(
      new THREE.SphereGeometry(s * 0.045, 4, 3),
      new THREE.MeshBasicMaterial({
        color: i % 2 ? 0xffc46a : 0xff8a3e, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    sp.userData.seed = i / 7 + s * 3.7;
    sp.userData.s = s;
    sp.userData.y0 = y + s * 0.5;
    sparks.push(sp);
    g.add(sp);
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
    // A tent under construction has its own hand-modelled half-pitched frame.
    if ((s.kind === "tent" || s.kind === "lean_to") && useModel("tent_unfinished")) return g;
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
      if (useModel("tent")) break;
      const tent = new THREE.Mesh(new THREE.CylinderGeometry(0, 0.52, 0.62, 4), lam(CLOTH));
      tent.position.y = 0.31;
      tent.rotation.y = Math.PI / 4;
      tent.castShadow = true;
      g.add(tent);
      g.add(box(0.16, 0.26, 0.05, 0x6d4c2c, 0, 0.13, 0.34));   // entrance
      break;
    }
    case "water_still": {
      if (useModel("water_still")) break;
      g.add(cyl(0.3, 0.34, 0.12, 8, 0x8a7a55, 0, 0.06, 0));
      const wtr = cyl(0.24, 0.24, 0.04, 8, 0x53aabb, 0, 0.13, 0);
      (wtr.material as THREE.MeshLambertMaterial).flatShading = false;
      g.add(wtr);
      g.add(cone(0.3, 0.3, 4, CLOTH_D, 0, 0.42, 0));
      break;
    }
    case "well": {
      if (useModel("well")) break;
      g.add(cyl(0.28, 0.3, 0.26, 8, STONEW, 0, 0.13, 0));
      g.add(cyl(0.02, 0.02, 0.5, 4, WOOD_D, -0.24, 0.4, 0));
      g.add(cyl(0.02, 0.02, 0.5, 4, WOOD_D, 0.24, 0.4, 0));
      g.add(cone(0.34, 0.22, 4, WOOD, 0, 0.72, 0));
      break;
    }
    case "store": case "storage_crate": case "supply_pile": {
      if (s.kind === "store" && useModel("store")) break;
      g.add(box(0.34, 0.34, 0.34, WOOD, -0.2, 0.17, 0.05));
      g.add(box(0.3, 0.3, 0.3, WOOD_D, 0.18, 0.15, -0.08));
      g.add(box(0.28, 0.28, 0.28, WOOD, 0, 0.46, 0));
      break;
    }
    case "workbench": {
      if (useModel("workbench")) break;
      g.add(box(0.7, 0.06, 0.4, WOOD, 0, 0.3, 0));
      g.add(box(0.06, 0.3, 0.06, WOOD_D, -0.28, 0.15, -0.14));
      g.add(box(0.06, 0.3, 0.06, WOOD_D, 0.28, 0.15, 0.14));
      g.add(box(0.14, 0.1, 0.1, METAL, 0.12, 0.38, 0));
      break;
    }
    case "smokehouse": {
      if (!useModel("smokehouse")) {
        g.add(box(0.5, 0.42, 0.44, WOOD_D, 0, 0.21, 0));
        g.add(cone(0.4, 0.26, 4, 0x6d4c2c, 0, 0.55, 0));
      }
      const puff = new THREE.Mesh(new THREE.SphereGeometry(0.09, 5, 4),
        new THREE.MeshLambertMaterial({ color: 0xcccccc, transparent: true, opacity: 0.5 }));
      puff.position.set(0.06, 0.82, 0);
      markDecor(puff);
      g.add(puff);
      break;
    }
    case "garden": {
      if (useModel("garden")) break;
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
      if (useModel("cave")) break;
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
      if (!useModel("hotspring")) {
        g.add(cyl(0.42, 0.48, 0.1, 8, 0x8a7a55, 0, 0.05, 0));
        const pool = cyl(0.34, 0.34, 0.05, 8, 0x5db8c9, 0, 0.11, 0);
        (pool.material as THREE.MeshLambertMaterial).flatShading = false;
        g.add(pool);
      }
      // steam rises whether the pool is hand-modelled or primitive
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
      if (useModel("radiotower")) {
        if (st.active) {
          const tip = new THREE.Mesh(new THREE.SphereGeometry(0.06 / scale, 5, 4),
            new THREE.MeshBasicMaterial({ color: 0xff6a5a }));
          tip.position.y = 2.5 / scale;
          markDecor(tip);
          g.add(tip);
        }
        break;
      }
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
      if (useModel("plane")) break;
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
    case "grave": {
      // a low mound of turned earth with a plain wooden cross at its head
      const mound = new THREE.Mesh(new THREE.SphereGeometry(0.26, 8, 6), lam(0x5d5546));
      mound.scale.set(1.0, 0.35, 0.62);
      mound.position.y = 0.04;
      mound.castShadow = true;
      g.add(mound);
      g.add(cyl(0.02, 0.024, 0.42, 5, WOOD_D, 0, 0.21, -0.16));
      g.add(box(0.2, 0.035, 0.03, WOOD_D, 0, 0.3, -0.16));
      break;
    }
    case "ruin": {
      // the weathered remains of what a past run built: stumps, a leaning
      // post, scattered stones (palimpsest strata surfacing in the new world)
      g.add(cyl(0.2, 0.24, 0.05, 7, 0x4a463e, 0, 0.025, 0));      // old footprint
      const post = cyl(0.03, 0.038, 0.42, 5, WOOD_D, -0.18, 0.18, 0.1);
      post.rotation.z = 0.35;
      post.castShadow = true;
      g.add(post);
      g.add(cyl(0.034, 0.04, 0.16, 5, 0x5c4426, 0.2, 0.08, -0.12));  // broken stump
      for (let i = 0; i < 4; i += 1) {
        const r = hashStr(`ru${i}${s.id}`);
        const stone = new THREE.Mesh(
          new THREE.DodecahedronGeometry(0.05 + r * 0.05, 0), lam(0x8a877e));
        stone.position.set(Math.cos(r * 6.28) * 0.22, 0.045, Math.sin(r * 6.28) * 0.2);
        stone.rotation.set(r * 4, r * 7, r * 2);
        stone.castShadow = true;
        g.add(stone);
      }
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

function buildStructs(st: WorldState, force = false): void {
  const sig = structsSignature(st);
  if (!force && sig === structsSig && structsGroup) return;
  structsSig = sig;
  structsGroup?.removeFromParent();
  lifeGroup?.removeFromParent();
  for (const l of fireLights) l.removeFromParent();
  fireLights = [];
  flames = [];
  sparks = [];
  smokes = [];
  fireflies = [];
  structsGroup = new THREE.Group();
  lifeGroup = new THREE.Group();
  const smokeMat = new THREE.MeshLambertMaterial({
    color: 0xd9d9d2, transparent: true, opacity: 0, depthWrite: false,
  });
  const flyMat = new THREE.MeshBasicMaterial({
    color: 0xffd97a, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  for (const s of st.structures) {
    const obj = makeStructure(s);
    // Seat through seatOnMesh — the one placement law. Anchored at the
    // FOOTPRINT centre, sampled at the model's visual radius on the REAL mesh;
    // a lip-straddling cave slides back onto its terrace instead of hovering
    // (or growing a foundation cube — that hack is dead).
    const sw = s.w || 1, sh = s.h || 1;
    const seat = seatOnMesh(s.x + sw / 2, s.y + sh / 2,
                            Math.max(sw, sh) / 2 * 0.8, 2.0);
    const wx = seat.x, wz = seat.z, gy = Math.max(0.02, seat.y);
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
      pl.userData.bx = wx; pl.userData.bz = wz;   // for the dancing jitter
      scene.add(pl);
      fireLights.push(pl);

      // life around a burning fire: a TALL billowing smoke column, and a
      // fairytale swarm of fireflies that comes out with the dark
      const base = new THREE.Vector3(wx, gy + 0.55, wz);
      const puffs: THREE.Mesh[] = [];
      for (let i = 0; i < 8; i += 1) {
        const puff = new THREE.Mesh(new THREE.SphereGeometry(0.13, 6, 5), smokeMat.clone());
        puffs.push(puff);
        lifeGroup.add(puff);
      }
      smokes.push({ base, puffs, seed: hashStr(s.id) });
      const flyCols = [0xffd97a, 0xffe9a8, 0xcaf0b4];
      for (let i = 0; i < 22; i += 1) {
        const fm = flyMat.clone();
        fm.color.setHex(flyCols[i % 3]);
        const fly = new THREE.Mesh(
          new THREE.SphereGeometry(0.016 + hashStr(s.id + "fs" + i) * 0.016, 4, 3), fm);
        fireflies.push({ m: fly, base, seed: hashStr(s.id + "fly" + i) });
        lifeGroup.add(fly);
      }
    }
  }
  markDecor(lifeGroup);
  scene.add(structsGroup);
  scene.add(lifeGroup);
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

// Stage-manage the meeples: fan out tile-mates, push everyone OUT of structure
// footprints (nobody stands inside a burning campfire), then relax pairwise
// distances so the crowd forms a loose circle AROUND a point of interest
// instead of a single merged blob (this also un-stacks the speech bubbles).
function placeAgents(st: WorldState): Map<string, { x: number; z: number }> {
  const targets = new Map<string, { x: number; z: number }>();
  const byTile = new Map<string, string[]>();
  for (const a of st.agents) {
    const key = `${a.x},${a.y}`;
    const list = byTile.get(key) ?? [];
    list.push(a.id);
    byTile.set(key, list);
  }
  for (const list of byTile.values()) list.sort();
  for (const a of st.agents) {
    let tx = a.x + 0.5, tz = a.y + 0.5;
    const mates = byTile.get(`${a.x},${a.y}`)!;
    if (mates.length > 1) {
      const i = mates.indexOf(a.id);
      const ang = (i / mates.length) * Math.PI * 2 + hashStr(`${a.x},${a.y}`) * 6.28;
      const rad = mates.length === 2 ? 0.24 : 0.36;
      tx += Math.cos(ang) * rad;
      tz += Math.sin(ang) * rad;
    }
    targets.set(a.id, { x: tx, z: tz });
  }
  // out of every structure footprint, with breathing room
  for (const s of st.structures) {
    const w = s.w || 1, h = s.h || 1;
    const cx = s.x + w / 2, cz = s.y + h / 2;
    const clearR = Math.max(w, h) / 2 + 0.52;
    for (const [id, t] of targets) {
      if (t.x < s.x - 0.2 || t.x > s.x + w + 0.2
        || t.z < s.y - 0.2 || t.z > s.y + h + 0.2) continue;
      let dx = t.x - cx, dz = t.z - cz;
      let len = Math.hypot(dx, dz);
      if (len < 0.01) {
        const ang = hashStr(id + s.id) * Math.PI * 2;
        dx = Math.cos(ang); dz = Math.sin(ang); len = 1;
      }
      t.x = cx + (dx / len) * clearR;
      t.z = cz + (dz / len) * clearR;
    }
  }
  // pairwise relaxation: everyone keeps personal space (readable bubbles)
  const ids = [...targets.keys()].sort();
  const MIN = 0.5;
  for (let pass = 0; pass < 3; pass += 1) {
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const p = targets.get(ids[i])!, q = targets.get(ids[j])!;
        let dx = q.x - p.x, dz = q.z - p.z;
        let len = Math.hypot(dx, dz);
        if (len >= MIN) continue;
        if (len < 0.01) {
          const ang = hashStr(ids[i] + ids[j]) * Math.PI * 2;
          dx = Math.cos(ang); dz = Math.sin(ang); len = 1;
        }
        const push = (MIN - Math.min(len, MIN)) / 2;
        p.x -= (dx / len) * push; p.z -= (dz / len) * push;
        q.x += (dx / len) * push; q.z += (dz / len) * push;
      }
    }
  }
  return targets;
}

function syncAgents3d(st: WorldState): void {
  const seen = new Set<string>();
  const targets = placeAgents(st);
  for (const a of st.agents) {
    seen.add(a.id);
    let v = agents3d.get(a.id);
    const t = targets.get(a.id)!;
    const tx = t.x, tz = t.z;
    if (!v) {
      const group = makeMeeple3d(a);
      group.position.set(tx, Math.max(0.02, surfaceY(tx, tz)), tz);
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
  // continuous time of day (falls back to two anchors when the backend
  // predates day_length_ticks in the snapshot)
  const L = st.day_length_ticks ?? 0;
  dayLenTicks = L;
  dayFracTarget = L > 0 ? (st.tick % L) / L : st.is_night ? 0.72 : 0.25;
  // measure the sim's pace so the visual clock can run BETWEEN ticks
  if (st.tick !== lastSimTick) {
    const nowMs = performance.now();
    if (lastSimTick >= 0 && st.tick > lastSimTick && lastTickMs > 0) {
      const per = (nowMs - lastTickMs) / 1000 / (st.tick - lastSimTick);
      estTickSec = estTickSec > 0 ? estTickSec * 0.7 + per * 0.3 : per;
    }
    lastSimTick = st.tick;
    lastTickMs = nowMs;
  }
  const mapKey = `${st.scenario}:${st.map.size}`;
  if (mapKey !== builtMapKey) {
    builtMapKey = mapKey;
    buildTerrain(st);
    for (const [, v] of agents3d) v.group.removeFromParent();
    agents3d.clear();
  }
  buildProps(st);
  buildStructs(st);
  // trampling + seasons: regrow when the camp changes or a new day dawns
  if (st.structures.length !== grassStructCount || st.day !== grassDay) buildGrass(st);
  syncAgents3d(st);
  setActive3d(true);
}

export function setActive3d(on: boolean): void {
  if (on === active) { if (on && renderer) renderer.domElement.style.display = ""; return; }
  active = on;
  if (renderer) renderer.domElement.style.display = on ? "" : "none";
  if (on) {
    // FPS cap: this is a painterly, slow scene — 40fps is indistinguishable from
    // 60 here and cuts ~a third of the whole postprocess/render load. dt stays
    // correct because clock.getDelta() measures real elapsed time between ticks.
    const FRAME_MS = 1000 / 40;
    const loop = () => {
      if (!active || !renderer) return;
      rafId = requestAnimationFrame(loop);
      const t = performance.now();
      if (t - lastFrameT < FRAME_MS - 1.5) return;   // too soon — skip this vsync
      lastFrameT = t;
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

/** Live scene environment for the audio engine (0..1 each). Null when 3D is off. */
export function audioEnv3d(): { night: number; storm: number; fire: number } | null {
  if (!active) return null;
  return { night: nightMix, storm: stormMix, fire: fireLights.length ? 1 : 0 };
}

// ── per-frame ─────────────────────────────────────────────────────────────────
const stormGrey = new THREE.Color(0x8f9aa0);
const stormDark = new THREE.Color(0x363d45);       // heavy slate for the overcast
const nightCloud = new THREE.Color(0x39485a);
const moonTint = new THREE.Color(0xe4edff);
const flashSky = new THREE.Color(0xdfeaf8);
const tmpColor = new THREE.Color();
const tmpVecA = new THREE.Vector3();
const handheldOffset = new THREE.Vector3();   // operator sway, added post-update
const clock = new THREE.Clock();
let lastFrameT = 0;
let inkTick = 0;
const lastInkCam = new THREE.Vector3();
const lastInkTgt = new THREE.Vector3();

function tick(): void {
  if (!renderer || !state) return;
  const dt = Math.min(0.1, clock.getDelta());
  // undo last frame's handheld sway so controls/follow see the true position
  camera.position.sub(handheldOffset);
  handheldOffset.set(0, 0, 0);
  // resize to stage
  const el = renderer.domElement.parentElement;
  if (el) {
    const w = el.clientWidth, h = el.clientHeight;
    const cur = renderer.getSize(new THREE.Vector2());
    // Supersample factor over CSS px, driven by the "Render sharpness" setting —
    // deliberately INDEPENDENT of devicePixelRatio. On a 1x-DPI (Full HD) display
    // dpr=1 would render 1:1 with no AA headroom, so the Kuwahara/FXAA/tilt-shift
    // passes soften the image with nothing to spare = mush. Rendering at 1.5–2x
    // and letting the browser downsample restores the crispness the look was
    // tuned for on a HiDPI dev monitor (which was implicitly doing exactly this).
    const pr = Math.min(2, Math.max(1, gfx.renderScale || 1.5));
    if (Math.abs(cur.x - w) > 1 || Math.abs(cur.y - h) > 1 || pr !== lastRenderPr) {
      lastRenderPr = pr;
      renderer.setPixelRatio(pr);
      renderer.setSize(w, h, false);
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      // setSize(false) leaves CSS alone, so a <canvas> with no CSS width/height
      // displays at its BACKING-STORE size — at pr>1 that overflows the stage
      // 1:1 instead of downsampling. Pin the CSS box to the stage so the
      // pr×-sized buffer super-samples down into it (the whole point of SSAA).
      renderer.domElement.style.width = `${w}px`;
      renderer.domElement.style.height = `${h}px`;
      (fxaaPass.material.uniforms.resolution.value as THREE.Vector2)
        .set(1 / (w * pr), 1 / (h * pr));
      (gradePass.uniforms.uRes.value as THREE.Vector2).set(w * pr, h * pr);
      (kuwaharaPass.uniforms.uRes.value as THREE.Vector2).set(w * pr, h * pr);
      (tiltPass.uniforms.uRes.value as THREE.Vector2).set(w * pr, h * pr);
      (pixelPass.uniforms.uRes.value as THREE.Vector2).set(w * pr, h * pr);
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
    v.group.position.set(v.x, Math.max(0.02, surfaceY(v.x, v.z)) + bob, v.z);
    if (walking) v.group.rotation.y = Math.atan2(dx, dz);
    // arm swing while walking, relaxed at rest
    const arms = v.group.userData.arms as THREE.Mesh[] | undefined;
    if (arms) {
      const swing = walking ? Math.sin(performance.now() / 100) * 0.7 : 0;
      arms[0].rotation.x = swing;
      arms[1].rotation.x = -swing;
    }
  }

  // TIME OF DAY: the visual clock runs CONTINUOUSLY at the sim's measured
  // pace, so dawns and dusks sweep through their keyframes between ticks —
  // instead of the light snapping from one tick's hour to the next's. The
  // authoritative sim time only nudges it (and snaps after big jumps).
  if (dayFracOverride !== null) {
    dayFrac = dayFracOverride;
  } else {
    if (dayLenTicks > 0 && estTickSec > 0.05) {
      dayFrac = (dayFrac + dt / (dayLenTicks * estTickSec)) % 1;
    }
    let dGap = dayFracTarget - dayFrac;
    if (dGap > 0.5) dGap -= 1;
    if (dGap < -0.5) dGap += 1;
    const pull = Math.abs(dGap) > 0.2 ? 2.5 : 0.15;   // snap vs gentle nudge
    dayFrac = (dayFrac + dGap * Math.min(1, dt * pull) + 1) % 1;
  }
  evalLight(dayFrac);
  nightMix = LC.dark;

  // lightning: during a storm the sky tears open every so often — a fast
  // double pulse of cold light over everything (reads on land, sea and rain)
  const nowT = performance.now() / 1000;
  if (stormMix > 0.5 && nowT > nextFlash) {
    flashStart = nowT;
    nextFlash = nowT + 5 + Math.random() * 9;
  }
  const fd = nowT - flashStart;
  const flash = fd >= 0 && fd < 0.5
    ? Math.max(Math.exp(-fd * 16), 0.6 * Math.exp(-Math.abs(fd - 0.16) * 26)) * stormMix
    : 0;

  // storm GUSTS: a slow, irregular pulse that dims the light and swells the wind
  // — the sky breathing down on the island
  const gt = performance.now() / 1000;
  const gust = stormMix * (0.55 + 0.45 * Math.sin(gt * 0.5) * Math.cos(gt * 0.21 + 1.1));

  // Phase 5 — palette-aware light: tint & scale the time-of-day light per palette
  // so Gloaming glows warm, Boreal runs cool-pale, Ashfall goes leaden and dim.
  const lg = pal().light;
  sun.color.copy(LC.sun);
  sun.color.r *= lg.sun[0]; sun.color.g *= lg.sun[1]; sun.color.b *= lg.sun[2];
  sun.intensity = LC.sunI * lg.sunMul * (1 - stormMix * 0.5 - gust * 0.14) + flash * 1.7;
  const sunR = 62;
  sun.position.set(
    islandCX + Math.sin(LC.azim) * Math.cos(LC.elev * 1.35) * sunR,
    8 + Math.sin(LC.elev * 1.35) * sunR,
    islandCZ - Math.cos(LC.azim) * Math.cos(LC.elev * 1.35) * sunR * 0.55,
  );
  ambient.color.copy(LC.sky);
  ambient.color.r *= lg.amb[0]; ambient.color.g *= lg.amb[1]; ambient.color.b *= lg.amb[2];
  ambient.groundColor.copy(LC.gnd);
  ambient.intensity = LC.hemiI * lg.ambMul * (1 - stormMix * 0.3 - gust * 0.1) + flash * 1.1;
  // heavy, low overcast: toward slate and then darkened, gusting darker still
  tmpColor.copy(LC.fog).lerp(stormGrey, stormMix * 0.5).lerp(stormDark, stormMix * 0.4);
  tmpColor.multiplyScalar(1 - stormMix * 0.16 - gust * 0.07);
  if (flash > 0.01) tmpColor.lerp(flashSky, flash * 0.55);
  (scene.background as THREE.Color).copy(tmpColor);
  scene.fog!.color.copy(tmpColor);
  if (skyMat) {
    (skyMat.uniforms.uTop.value as THREE.Color)
      .copy(LC.top).lerp(stormGrey, stormMix * 0.4).lerp(stormDark, stormMix * 0.45)
      .multiplyScalar(1 - stormMix * 0.14 - gust * 0.05);
    (skyMat.uniforms.uHor.value as THREE.Color)
      .copy(LC.hor).lerp(stormGrey, stormMix * 0.55).lerp(stormDark, stormMix * 0.28)
      .multiplyScalar(1 - stormMix * 0.1);
  }
  if (waterMat) waterMat.color.copy(LC.water).lerp(stormGrey, stormMix * 0.3)
    .lerp(stormDark, stormMix * 0.35);
  // the whole frame sits darker and heavier under a storm (and dips in gusts)
  renderer.toneMappingExposure = 1.15 - stormMix * 0.26 - gust * 0.05;
  for (const l of fireLights) {
    const jt = performance.now() / 1000;
    l.intensity = (4.5 + Math.sin(performance.now() / 120) * 1.2) * (0.4 + nightMix * 0.9);
    // the light source itself dances a little — shadows breathe like firelight
    l.position.x = (l.userData.bx as number) + Math.sin(jt * 7.3) * 0.06;
    l.position.z = (l.userData.bz as number) + Math.cos(jt * 6.1) * 0.06;
  }

  const skyNow = performance.now() / 1000;
  // the luminary rides the light direction: warm wide sun ↔ small silver moon
  if (lumSprite) {
    tmpVecA.copy(sun.position);
    tmpVecA.x -= islandCX; tmpVecA.z -= islandCZ;
    tmpVecA.normalize();
    lumSprite.position.set(
      islandCX + tmpVecA.x * 320,
      Math.max(14, tmpVecA.y * 320),
      islandCZ + tmpVecA.z * 320,
    );
    const m = lumSprite.material as THREE.SpriteMaterial;
    m.color.setHex(0xffedb2).lerp(moonTint, nightMix);
    m.opacity = (0.9 - stormMix * 0.6);
    lumSprite.scale.setScalar(26 - nightMix * 13);
  }
  if (moonPath && state) {
    const mat = moonPath.material as THREE.MeshBasicMaterial;
    mat.opacity = Math.max(0, nightMix - 0.3) * 0.8 * (1 - stormMix * 0.7);
    moonPath.visible = mat.opacity > 0.01;
    if (moonPath.visible) {
      const dx = sun.position.x - islandCX, dz = sun.position.z - islandCZ;
      const dl = Math.hypot(dx, dz) || 1;
      moonPath.position.set(
        islandCX + (dx / dl) * (state.map.size * 0.5 + 14), 0.03,
        islandCZ + (dz / dl) * (state.map.size * 0.5 + 14) * 0.9,
      );
      moonPath.rotation.y = Math.atan2(-dz / dl, dx / dl);
      if (mat.map) mat.map.offset.x = skyNow * 0.015;   // the glimmer crawls
    }
  }
  if (cirrusMat) cirrusMat.opacity = (0.3 - nightMix * 0.18) * (1 - stormMix * 0.8);

  // rain, storm only: recompute streak endpoints while it falls
  if (rainMesh && rainBase) {
    const mat = rainMesh.material as THREE.LineBasicMaterial;
    mat.opacity = stormMix * 0.72;
    rainMesh.visible = stormMix > 0.02;
    if (rainMesh.visible) {
      const attr = rainMesh.geometry.getAttribute("position") as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      const drops = rainBase.length / 4;
      const slantX = 0.42 + gust * 0.45;    // wind drives the rain sideways in gusts
      for (let i = 0; i < drops; i += 1) {
        const bx = rainBase[i * 4], by = rainBase[i * 4 + 1];
        const bz = rainBase[i * 4 + 2], sp = rainBase[i * 4 + 3];
        const y = 14 - ((by + skyNow * sp * 1.3) % 14);   // falls faster
        arr[i * 6] = bx; arr[i * 6 + 1] = y; arr[i * 6 + 2] = bz;
        // longer, wind-slanted streaks read as a heavier downpour
        arr[i * 6 + 3] = bx + slantX; arr[i * 6 + 4] = y - 1.3; arr[i * 6 + 5] = bz + 0.14;
      }
      attr.needsUpdate = true;
    }
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
  // tilt-shift focus rides the followed hero; relaxes to mid-frame otherwise
  const wantFocus = sel
    ? Math.min(0.72, Math.max(0.25,
        tmpVecA.set(sel.x, sel.group.position.y + 0.4, sel.z).project(camera).y * 0.5 + 0.5))
    : 0.46;
  tiltPass.uniforms.uFocus.value +=
    (wantFocus - (tiltPass.uniforms.uFocus.value as number)) * Math.min(1, dt * 2.5);

  // atmosphere: waves, drifting clouds, breathing foam, storm front
  const now = performance.now() / 1000;
  const storm = stormOverride !== null ? stormOverride : (state.weather === "storm" ? 1 : 0);
  stormMix += (storm - stormMix) * Math.min(1, dt * 1.2);
  if (waterShader) {
    waterShader.uniforms.uTime.value = now;
    waterShader.uniforms.uAmp.value = 0.004 + stormMix * 0.09;
    (waterShader.uniforms.uIsland.value as unknown as THREE.Vector2).set(islandCX, islandCZ);
    waterShader.uniforms.uShoreR.value = mapN * 0.42;
  }
  if (surfMat) {
    surfMat.uniforms.uTime.value = now;
    surfMat.uniforms.uStorm.value = stormMix;
  }
  if (grassShader) {
    grassShader.uniforms.uTime.value = now;
    grassShader.uniforms.uWind.value = 0.35 + stormMix * 1.3;
  }
  // waterfalls: scroll the streak sheets downward — the whole illusion
  for (const m of waterfallMats) {
    if (m.map) m.map.offset.y = now * 0.55;
  }
  // streams flow along their length (u), a touch slower than the falls
  for (const m of streamMats) {
    if (m.map) m.map.offset.x = now * 0.3;
  }
  // living fire: layered breathing + sideways licks + the occasional tall
  // tongue of flame (a sharpened sine spike), each layer on its own phase
  for (const f of flames) {
    const ph = f.userData.phase as number;
    const lick = Math.max(0, Math.sin(now * 3.1 + ph * 2.3)) ** 8;
    f.scale.x = f.scale.z = 1 + Math.sin(now * 9 + ph) * 0.1 - lick * 0.12;
    f.scale.y = 1 + Math.sin(now * 13 + ph * 1.3) * 0.2 + lick * 0.45;
    f.position.y = (f.userData.baseY as number) * f.scale.y;
    f.rotation.y = now * 1.4 + ph;
    f.rotation.z = Math.sin(now * 6.3 + ph * 1.7) * 0.06;
  }
  if (cloudsGroup && state) {
    const n = state.map.size;
    // storm clouds go dark, dense and low — a lid clamped over the island
    tmpColor.setHex(0xdfe6e2).lerp(nightCloud, nightMix)
      .lerp(stormGrey, stormMix * 0.5).lerp(stormDark, stormMix * 0.6);
    for (let ci = 0; ci < cloudsGroup.children.length; ci += 1) {
      const cl = cloudsGroup.children[ci];
      cl.position.x += (cl.userData.speed as number) * dt * (1 + stormMix * 2.5);
      // a storm presses the ceiling down
      cl.position.y += ((12.5 - stormMix * 4.5 + (ci % 5) * 1.4) - cl.position.y) * Math.min(1, dt * 0.5);
      if (cl.position.x > n / 2 + n) {
        cl.position.x = n / 2 - n;
        cl.position.z = n / 2 + (Math.random() - 0.5) * n * 1.1;   // fresh lane
      }
      const mat = cloudMats[ci];
      if (mat) {
        mat.color.copy(tmpColor);
        // melt away when drifting between the camera and the island; heavier
        // and more opaque in a storm
        const near = camera.position.distanceTo(cl.position);
        mat.opacity = (0.92 - nightMix * 0.18 + stormMix * 0.06) * THREE.MathUtils.smoothstep(near, 12, 26);
      }
    }
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
    // crowns also ROCK in the wind, not just breathe — reads at a distance
    b.m.rotation.z = Math.sin(now * 1.4 + b.phase * 1.3) * 0.04 * wind;
  }

  // AMBIENT LIFE ──────────────────────────────────────────────────────────────
  // smoke: a real billowing column — born at the fire, rises high, leans
  // downwind, swells and thins; each puff corkscrews a little as it climbs
  const drift = 0.6 + stormMix * 1.8;
  for (const s of smokes) {
    for (let i = 0; i < s.puffs.length; i += 1) {
      const t = (now * 0.08 + i / s.puffs.length + s.seed) % 1;
      const p = s.puffs[i];
      const spin = now * 0.9 + i * 2.1 + s.seed * 9;
      p.position.set(
        s.base.x + t * t * drift + Math.sin(spin) * 0.14 * t,
        s.base.y + t * 3.4,
        s.base.z + Math.cos(spin * 0.8) * 0.14 * t,
      );
      const sc = 0.45 + t * 2.7;
      p.scale.setScalar(sc);
      (p.material as THREE.MeshLambertMaterial).opacity =
        0.34 * Math.min(1, t * 7) * (1 - t) * (1 + stormMix * 0.3);
    }
  }
  // fireflies: only with darkness — a fairytale swarm. Each one WANDERS (its
  // roaming point drifts slowly and incommensurately, with a smaller flutter on
  // top) so no two trace the same clean orbit, and each TWINKLES on its own
  // clock with long dark gaps — sparks of light drifting through the night, not
  // beads on a wire.
  for (const f of fireflies) {
    const s = f.seed;
    const t = now * (0.5 + s * 0.5) + s * 30;
    // slow roaming centre (two incommensurate sines per axis = no visible loop),
    // kept fairly close so they read as a swarm HUGGING the fire, not scattered
    const spread = 0.7 + s * 1.0;
    const rx = Math.sin(t * 0.23 + s * 17) * spread + Math.sin(t * 0.61 + s * 5) * spread * 0.4;
    const rz = Math.cos(t * 0.19 + s * 11) * spread + Math.cos(t * 0.53 + s * 8) * spread * 0.4;
    // small fast flutter + a gentle rise/fall
    const fx = Math.sin(t * 1.9 + s * 21) * 0.12;
    const fz = Math.cos(t * 2.3 + s * 13) * 0.12;
    const ry = 0.12 + s * 0.8 + Math.sin(t * 0.9 + s * 9) * 0.4 + Math.sin(t * 3.3) * 0.06;
    f.m.position.set(f.base.x + rx + fx, f.base.y + ry, f.base.z + rz + fz);
    // twinkle: a soft glow spike with a dim mote persisting between blinks, so
    // the swarm always shimmers (fairytale) instead of mostly going dark
    const blink = Math.max(0, Math.sin(now * (0.9 + s * 1.6) + s * 40));
    (f.m.material as THREE.MeshBasicMaterial).opacity = nightMix * (0.1 + 0.9 * Math.pow(blink, 1.8));
  }
  // sparks ride the heat column and wink out
  for (const sp of sparks) {
    const seed = sp.userData.seed as number;
    const fs = sp.userData.s as number;
    const t = (now * (0.45 + seed * 0.2) + seed * 5) % 1;
    sp.position.set(
      Math.sin(now * 2.5 + seed * 20) * 0.09 * fs * (1 + t * 2),
      (sp.userData.y0 as number) + t * fs * 2.6,
      Math.cos(now * 2.1 + seed * 14) * 0.09 * fs * (1 + t * 2),
    );
    (sp.material as THREE.MeshBasicMaterial).opacity =
      Math.min(1, t * 8) * (1 - t) * (0.5 + 0.5 * Math.sin(now * 11 + seed * 30));
  }
  // gulls circle by day, roost at night; butterflies flutter over the meadow
  const daylight = 1 - nightMix;
  for (const b of birds) {
    const a = now * b.speed + b.phase;
    b.g.visible = daylight > 0.35;
    b.g.position.set(
      b.cx + Math.cos(a) * b.r,
      b.h + Math.sin(a * 2.3) * 0.4,
      b.cz + Math.sin(a) * b.r,
    );
    b.g.rotation.y = -a;
    const flap = Math.sin(now * 6 + b.phase * 3) * 0.45;
    b.wings[0].rotation.y = flap;
    b.wings[1].rotation.y = -flap;
  }
  for (const bf of butterflies) {
    bf.g.visible = daylight > 0.5;
    const t = now * 0.7 + bf.seed;
    bf.g.position.set(
      bf.base.x + Math.sin(t * 0.8) * 0.9 + Math.sin(t * 2.7) * 0.2,
      bf.base.y + Math.sin(t * 1.9) * 0.25,
      bf.base.z + Math.cos(t * 0.6) * 0.9,
    );
    bf.g.rotation.y = t * 0.5;
    const flap = Math.sin(now * 16 + bf.seed) * 0.9;
    bf.wings[0].rotation.y = flap;
    bf.wings[1].rotation.y = -flap;
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

  // VOLUMETRIC MIST + LIGHT: a low band of soft wisps that thickens at dawn and
  // dusk (and in storm). When the sun rides low it glows — the mist takes the
  // warm sun colour, so light appears to scatter through the air (the reliable
  // "volumetric light" read for this locked top-down camera, where screen-space
  // god-ray shafts have no visible sky to gather from).
  if (fogGroup && fogSprites.length && state) {
    const cd = (c: number) => { const d = Math.abs(dayFrac - c) % 1; return Math.min(d, 1 - d); };
    const dawnDusk = Math.max(Math.max(0, 1 - cd(0.03) / 0.09), Math.max(0, 1 - cd(0.53) / 0.10));
    const golden = Math.max(0, 1 - cd(0.42) / 0.08);   // a lighter veil at golden hour
    const mist = Math.min(1, dawnDusk * 0.85 + golden * 0.4 + stormMix * 0.45);
    fogGroup.visible = mist > 0.01;
    if (fogGroup.visible) {
      // base mist is the fog colour (warm dawn / violet dusk); when the sun is
      // low it glows toward the sun tint — luminous haze, i.e. scattered light.
      // In a storm it instead turns dark and heavy — low scud over the ground.
      const lowSun = THREE.MathUtils.clamp(1 - LC.elev * 1.2, 0, 1) * (1 - nightMix) * (1 - stormMix);
      tmpColor.copy(LC.fog).lerp(stormGrey, 0.18).lerp(LC.sun, lowSun * 0.5)
        .lerp(stormDark, stormMix * 0.5);
      const glow = 1 + lowSun * 0.6;                    // low sun lifts the veil a touch
      const span = state.map.size;
      for (const spr of fogSprites) {
        const mat = spr.material as THREE.SpriteMaterial;
        mat.color.copy(tmpColor);
        mat.opacity = Math.min(0.22, mist * (spr.userData.baseA as number) * glow);
        spr.position.x += (spr.userData.speed as number) * dt;
        if (spr.position.x > islandCX + span * 0.95) spr.position.x -= span * 1.9;
        spr.position.y = (spr.userData.y as number)
          + Math.sin(now * 0.1 + (spr.userData.phase as number)) * 0.15;
      }
    }
  }

  const fog = scene.fog as THREE.Fog;
  fog.near = 70 - stormMix * 35;
  fog.far = 210 - stormMix * 90;
  if (pixelPass) {
    // block size in DISPLAY px: multiply by the render scale so a "4px" block
    // stays 4 screen pixels rather than shrinking under super-sampling.
    pixelPass.uniforms.uPixel.value = gfx.pixel > 1 ? gfx.pixel * lastRenderPr : 1;
    pixelPass.uniforms.uScale.value = lastRenderPr;
    pixelPass.uniforms.uBits.value = gfx.colorBits;
    pixelPass.uniforms.uDither.value = gfx.dither;
  }
  if (gradePass) {
    const gu = gradePass.uniforms;
    gu.uTime.value = now;
    gu.uStorm.value = stormMix;
    (gu.uInvVP.value as THREE.Matrix4)
      .multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
    (gu.uCamPos.value as THREE.Vector3).copy(camera.position);
    camera.getWorldDirection(gu.uCamFwd.value as THREE.Vector3);
    // live style knobs from the graphics panel / preset
    gu.uInkAmt.value = gfx.ink;
    gu.uInkWidth.value = gfx.inkWidth;
    gu.uInkMode.value = gfx.inkSilhouette ? 1 : 0;
    gu.uComic.value = gfx.comic;
    gu.uPosterLevels.value = gfx.posterLevels;
    gu.uPosterAmt.value = gfx.posterAmt;
    gu.uHalftone.value = gfx.halftone;
    gu.uHalftoneScale.value = gfx.halftoneScale;
    gu.uSat.value = gfx.saturation;
    gu.uPaperAmt.value = gfx.paper;
    gu.uVignette.value = gfx.vignette;
    gu.uBarrel.value = gfx.barrel;
    gu.uSepia.value = gfx.sepia;
    gu.uFlicker.value = gfx.flicker;
    gu.uWeave.value = gfx.weave;
    // colour script: highlights lean into the sun, shadows into the sky dome
    (gu.uHiTint.value as THREE.Color).copy(LC.sun);
    (gu.uShadowTint.value as THREE.Color).copy(LC.top);
    // film stock emulation
    const fp = FILM_PROFILES[gfx.film] ?? FILM_PROFILES.none;
    gu.uFilm.value = fp.strength;
    gu.uFilmContrast.value = fp.contrast;
    gu.uFilmSCurve.value = fp.sCurve;
    gu.uFilmToe.value = fp.toe;
    gu.uFilmShoulder.value = fp.shoulder;
    gu.uFilmSat.value = fp.sat;
    gu.uFilmHalo.value = fp.halo;
    gu.uFilmGrain.value = fp.grain;
    (gu.uFilmShadow.value as THREE.Color).setRGB(fp.shadow[0], fp.shadow[1], fp.shadow[2]);
    (gu.uFilmHigh.value as THREE.Color).setRGB(fp.high[0], fp.high[1], fp.high[2]);
    (gu.uFilmHaloTint.value as THREE.Color).setRGB(fp.haloTint[0], fp.haloTint[1], fp.haloTint[2]);
  }
  if (bloomPass) bloomPass.strength = gfx.bloom;
  if (tiltPass) tiltPass.uniforms.uMax.value = 2.6 * gfx.focus;

  controls.update();

  // operator handheld sway while following a survivor — a whisper of life added
  // AFTER controls set the true position (and undone at the next tick's start)
  if (sel && gfx.handheld > 0.001) {
    const h = gfx.handheld, ht = now * 0.9;
    handheldOffset.set(
      (Math.sin(ht * 1.3) * 0.02 + Math.sin(ht * 3.1 + 1.0) * 0.007) * h,
      (Math.sin(ht * 1.7 + 2.0) * 0.013) * h,
      (Math.cos(ht * 1.1) * 0.02 + Math.cos(ht * 2.7) * 0.007) * h,
    );
    camera.position.add(handheldOffset);
  }

  // ink prepass: solids only (layer 0), one override material, into the
  // half-float normals+depth target the grade shader reads. Shadow updates
  // are deferred to the main render so they aren't paid twice per frame.
  // It's a WHOLE extra scene pass, and the normals/depth only shift when the
  // camera moves — so refresh it on camera motion, else only every 2nd frame
  // (≤25ms of contour lag on a slowly-walking survivor: imperceptible), and
  // reuse the last target the rest of the time.
  if (inkTarget && inkMat) {
    const camMoved = camera.position.distanceToSquared(lastInkCam) > 1e-7
      || controls.target.distanceToSquared(lastInkTgt) > 1e-7;
    if (camMoved || (inkTick & 1) === 0) {
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = false;   // never update inside the prepass
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
      lastInkCam.copy(camera.position);
      lastInkTgt.copy(controls.target);
    }
    inkTick++;
    camera.layers.set(0);      // main composer render always sees both layers
    camera.layers.enable(1);
  }

  // Shadows re-render the whole scene from the sun — but the sun crawls, so
  // refreshing the map every 3rd frame (~20fps) is indistinguishable and saves
  // two full depth passes out of three. autoUpdate stays off; we pulse it.
  renderer.shadowMap.autoUpdate = false;
  if (shadowTick++ % 3 === 0) renderer.shadowMap.needsUpdate = true;

  composer.render();
}
