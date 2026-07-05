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
import type { AgentState, WorldState } from "./types";
import { agentHue, hslToRgbInt } from "./utils";

// ── palette (shared spirit with vector.ts, tuned for lit 3D) ──────────────────
const C = {
  seaDeep: 0x2b6a80,
  seaSurface: 0x3f96a8,
  sand: 0xeadfa8,
  grass: 0x8fc767,
  jungle: 0x5f9e4d,
  rock: 0xb0a89a,
  cliff: 0x8a6f4c,
  trunk: 0x8a6239,
  leaf: 0x4f9448,
  leafDark: 0x3d7a3a,
  bush: 0x67a052,
  stone: 0xa8a29a,
  flame: 0xffa54f,
  skyDay: 0xbfe0e8,
  skyNight: 0x0e1e34,
};

const BIOME_HEIGHT: Record<string, number> = {
  water: -1.35, sand: 0.14, grass: 0.6, foliage: 0.85, rock: 1.9,
};

function biomeOf(t: string): keyof typeof BIOME_HEIGHT {
  if (t.includes("water")) return "water";
  if (t.includes("sand")) return "sand";
  if (t.includes("foliage")) return "foliage";
  if (t.includes("rock")) return "rock";
  return "grass";
}

const BIOME_COLOR: Record<string, number> = {
  water: C.seaDeep, sand: C.sand, grass: C.grass, foliage: C.jungle, rock: C.rock,
};

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
let terrainGroup: THREE.Group | null = null;
let propsGroup: THREE.Group | null = null;
let structsGroup: THREE.Group | null = null;
let fireLights: THREE.PointLight[] = [];
let active = false;
let rafId = 0;
let builtMapKey = "";
let heightGrid: number[][] = [];          // smoothed corner heights (n+1)^2
let mapN = 0;
let state: WorldState | null = null;
let nightMix = 0;                          // 0 = day, 1 = night (lerped)

type Agent3d = {
  group: THREE.Group;
  x: number; z: number;                    // current world pos (lerped)
  tx: number; tz: number;                  // target
  status: string;
};
const agents3d = new Map<string, Agent3d>();

// ── height sampling ───────────────────────────────────────────────────────────
function buildHeights(st: WorldState): void {
  const n = st.map.size;
  mapN = n;
  const tileH = (x: number, y: number) =>
    x < 0 || y < 0 || x >= n || y >= n
      ? BIOME_HEIGHT.water
      : BIOME_HEIGHT[biomeOf(st.map.grid[y][x])];
  // corner grid = average of adjacent tiles, then two smoothing passes
  let g: number[][] = [];
  for (let y = 0; y <= n; y += 1) {
    const row: number[] = [];
    for (let x = 0; x <= n; x += 1) {
      row.push((tileH(x - 1, y - 1) + tileH(x, y - 1) + tileH(x - 1, y) + tileH(x, y)) / 4);
    }
    g.push(row);
  }
  for (let pass = 0; pass < 2; pass += 1) {
    const out = g.map((r) => r.slice());
    for (let y = 1; y < n; y += 1)
      for (let x = 1; x < n; x += 1)
        out[y][x] = (g[y][x] * 2 + g[y - 1][x] + g[y + 1][x] + g[y][x - 1] + g[y][x + 1]) / 6;
    g = out;
  }
  heightGrid = g;
}

function heightAt(wx: number, wz: number): number {
  // bilinear over the corner grid
  const x = Math.max(0, Math.min(mapN - 0.001, wx));
  const z = Math.max(0, Math.min(mapN - 0.001, wz));
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const fx = x - x0, fz = z - z0;
  const h00 = heightGrid[z0][x0], h10 = heightGrid[z0][x0 + 1];
  const h01 = heightGrid[z0 + 1][x0], h11 = heightGrid[z0 + 1][x0 + 1];
  return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
}

// ── scene bootstrap ───────────────────────────────────────────────────────────
function ensureRenderer(stageEl: HTMLElement): void {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.style.position = "absolute";
  renderer.domElement.style.inset = "0";
  stageEl.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(C.skyDay);
  scene.fog = new THREE.Fog(C.skyDay, 120, 280);

  camera = new THREE.PerspectiveCamera(32, 1, 0.1, 500);

  sun = new THREE.DirectionalLight(0xfff2dd, 2.9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  scene.add(sun);
  scene.add(sun.target);

  ambient = new THREE.HemisphereLight(0xdff3f7, 0x5a6b4a, 0.45);
  scene.add(ambient);

  // Sea: a translucent surface plane + an opaque deep floor far below.
  const seaSize = 1000;
  waterMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(seaSize, seaSize),
    new THREE.MeshPhongMaterial({
      color: C.seaSurface, transparent: true, opacity: 0.62,
      shininess: 36, specular: 0x2f4f5c,
    }),
  );
  waterMesh.rotation.x = -Math.PI / 2;
  waterMesh.position.y = 0;
  waterMesh.receiveShadow = true;
  scene.add(waterMesh);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(seaSize, seaSize),
    new THREE.MeshLambertMaterial({ color: C.seaDeep }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1.45;
  scene.add(floor);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.44;    // never below the horizon
  controls.minPolarAngle = Math.PI * 0.12;
  controls.minDistance = 14;
  controls.maxDistance = 140;
}

// ── terrain ───────────────────────────────────────────────────────────────────
function buildTerrain(st: WorldState): void {
  terrainGroup?.removeFromParent();
  terrainGroup = new THREE.Group();
  const n = st.map.size;
  buildHeights(st);

  let geo: THREE.BufferGeometry = new THREE.PlaneGeometry(n, n, n, n);
  geo.rotateX(-Math.PI / 2);
  geo.translate(n / 2, 0, n / 2);
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i += 1) {
    const vx = Math.round(pos.getX(i));
    const vz = Math.round(pos.getZ(i));
    pos.setY(i, heightGrid[Math.min(n, Math.max(0, vz))][Math.min(n, Math.max(0, vx))]);
  }
  const shallowCol = new THREE.Color(0x2fa3b8);
  const deepCol = new THREE.Color(C.seaDeep);
  const vCol = new THREE.Color();
  geo = geo.toNonIndexed();                    // crisp low-poly facets
  const p2 = geo.getAttribute("position") as THREE.BufferAttribute;
  const colors = new Float32Array(p2.count * 3);
  const col = new THREE.Color();
  for (let f = 0; f < p2.count; f += 3) {
    // face centre -> owning tile -> biome colour (slight per-tile tone jitter)
    const cx = (p2.getX(f) + p2.getX(f + 1) + p2.getX(f + 2)) / 3;
    const cz = (p2.getZ(f) + p2.getZ(f + 1) + p2.getZ(f + 2)) / 3;
    const tx = Math.max(0, Math.min(n - 1, Math.floor(cx)));
    const tz = Math.max(0, Math.min(n - 1, Math.floor(cz)));
    const biome = biomeOf(st.map.grid[tz][tx]);
    col.setHex(BIOME_COLOR[biome]);
    const jitter = (hashStr(`${tx}:${tz}`) - 0.5) * (biome === "grass" ? 0.07 : 0.04);
    col.offsetHSL(0, 0, jitter);
    for (let v = 0; v < 3; v += 1) {
      // Per-VERTEX water blending: below the waterline each vertex dissolves
      // toward turquoise shallows and then deep sea by its own depth, giving a
      // smooth shore gradient instead of blocky per-face terraces.
      vCol.copy(col);
      const vy = p2.getY(f + v);
      if (vy < 0.1) {
        const t = Math.min(1, (0.1 - vy) / 1.2);
        vCol.lerp(shallowCol, 0.4 + t * 0.25);
        vCol.lerp(deepCol, t * t);
      }
      colors[(f + v) * 3] = vCol.r;
      colors[(f + v) * 3 + 1] = vCol.g;
      colors[(f + v) * 3 + 2] = vCol.b;
    }
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  terrainGroup.add(mesh);
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

  // First-time camera framing: pulled back so the island floats in open sea.
  camera.position.set(cx + n * 0.12, n * 1.1, cz + n * 1.25);
  controls.target.set(cx, 0, cz);
  controls.update();
}

// ── props (primitive assemblies, deterministic per node id) ───────────────────
function makePalm(id: string): THREE.Group {
  const g = new THREE.Group();
  const r = hashStr(id);
  const h = 1.1 + r * 0.5;
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.075, h, 5),
    new THREE.MeshLambertMaterial({ color: C.trunk, flatShading: true }),
  );
  trunk.position.y = h / 2;
  trunk.rotation.z = (r - 0.5) * 0.25;
  trunk.castShadow = true;
  g.add(trunk);
  const crown = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.42 + r * 0.1, 0),
    new THREE.MeshLambertMaterial({ color: r > 0.5 ? C.leaf : C.leafDark, flatShading: true }),
  );
  crown.position.set((r - 0.5) * 0.3, h + 0.14, 0);
  crown.scale.y = 0.62;
  crown.castShadow = true;
  g.add(crown);
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
  const g = new THREE.Group();
  const r = hashStr(id);
  const bush = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.22 + r * 0.08, 0),
    new THREE.MeshLambertMaterial({ color: C.bush, flatShading: true }),
  );
  bush.position.y = 0.14;
  bush.scale.y = 0.75;
  bush.castShadow = true;
  g.add(bush);
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
  for (const node of st.resources) {
    if (node.quantity <= 0) continue;
    let obj: THREE.Group | null = null;
    const k = node.kind;
    if (k === "wood" || k === "fruit_tree") obj = makePalm(node.id);
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
  scene.add(propsGroup);
}

// ── structures: G3.1 = role-coloured blocks; G3.2 draws each kind ─────────────
const ROLE_COLOR_3D: Record<string, number> = {
  shelter: 0xc4a165, campfire: 0xe2641f, water: 0x4fa3b5, hotspring: 0x5db8c9,
  store: 0xa5824f, salvage: 0x8a8f98, beacon: 0xd8cfae, signal: 0xc0574f,
  escape: 0xd08a4e, workbench: 0x9b7a53, smokehouse: 0x8f6e4e, garden: 0x7fae56,
  lookout: 0xb0946a, signpost: 0xcbb98a, refill_oxygen: 0x7fd0d8, hazard: 0xb0483f,
};

function buildStructs(st: WorldState): void {
  structsGroup?.removeFromParent();
  for (const l of fireLights) l.removeFromParent();
  fireLights = [];
  structsGroup = new THREE.Group();
  for (const s of st.structures) {
    const w = Math.max(1, s.w || 1) * 0.62;
    const d = Math.max(1, s.h || 1) * 0.5;
    const hgt = 0.4 + Math.min(1.6, Math.max(w, d) * 0.35);
    const color = ROLE_COLOR_3D[s.role] ?? 0x9a8f7a;
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(w, hgt, d),
      new THREE.MeshLambertMaterial({ color, flatShading: true }),
    );
    const wx = s.x + 0.5, wz = s.y + 0.5;
    const gy = Math.max(0.02, heightAt(wx, wz));
    box.position.set(wx, gy + hgt / 2, wz);
    box.castShadow = true;
    box.receiveShadow = true;
    structsGroup.add(box);

    // Lit campfires and active beacons cast real light — the night payoff.
    const lit = (s.role === "campfire" && s.state?.complete && ((s.state?.fuel as number) ?? 0) > 0)
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
  const hue = agentHue(a.id);
  const bodyColor = hslToRgbInt(hue, 58, 55);
  const headColor = hslToRgbInt(hue, 32, 78);
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.15, 0.26, 3, 8),
    new THREE.MeshLambertMaterial({ color: bodyColor }),
  );
  body.position.y = 0.34;
  body.castShadow = true;
  g.add(body);
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.13, 10, 8),
    new THREE.MeshLambertMaterial({ color: headColor }),
  );
  head.position.y = 0.72;
  head.castShadow = true;
  g.add(head);
  if (a.gender === "female") {
    const bun = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 6, 5),
      new THREE.MeshLambertMaterial({ color: hslToRgbInt(hue, 58, 38) }),
    );
    bun.position.set(0.1, 0.8, -0.02);
    g.add(bun);
  }
  return g;
}

function syncAgents3d(st: WorldState): void {
  const seen = new Set<string>();
  for (const a of st.agents) {
    seen.add(a.id);
    let v = agents3d.get(a.id);
    const tx = a.x + 0.5, tz = a.y + 0.5;
    if (!v) {
      const group = makeMeeple3d(a);
      group.position.set(tx, Math.max(0.02, heightAt(tx, tz)), tz);
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
const tmpColor = new THREE.Color();

function tick(): void {
  if (!renderer || !state) return;
  // resize to stage
  const el = renderer.domElement.parentElement;
  if (el) {
    const w = el.clientWidth, h = el.clientHeight;
    const cur = renderer.getSize(new THREE.Vector2());
    if (Math.abs(cur.x - w) > 1 || Math.abs(cur.y - h) > 1) {
      renderer.setSize(w, h, false);
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
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
    const bob = dist > 0.05 ? Math.abs(Math.sin(performance.now() / 90)) * 0.05 : 0;
    v.group.position.set(v.x, Math.max(0.02, heightAt(v.x, v.z)) + bob, v.z);
    if (dist > 0.05) v.group.rotation.y = Math.atan2(dx, dz);
  }

  // day/night: real lighting, not an overlay
  const targetNight = state.is_night ? 1 : 0;
  nightMix += (targetNight - nightMix) * 0.03;
  sun.intensity = 2.6 - nightMix * 2.25;
  ambient.intensity = 0.9 - nightMix * 0.55;
  tmpColor.copy(dayFog).lerp(nightFog, nightMix);
  (scene.background as THREE.Color).copy(tmpColor);
  scene.fog!.color.copy(tmpColor);
  sun.color.setHSL(0.09, 0.5, 0.9 - nightMix * 0.25);
  for (const l of fireLights) {
    l.intensity = (4.5 + Math.sin(performance.now() / 120) * 1.2) * (0.4 + nightMix * 0.9);
  }

  controls.update();
  renderer.render(scene, camera);
}
