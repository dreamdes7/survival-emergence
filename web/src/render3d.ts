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
import type { AgentState, StructureState, WorldState } from "./types";
import { agentHue, hslToRgbInt } from "./utils";
import { store } from "./store";
import { openAgentModal, openStructModal, renderChrome } from "./ui";

function lam(color: number): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color, flatShading: true });
}

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

  // Selection halo that follows the selected agent.
  selRing = new THREE.Mesh(
    new THREE.RingGeometry(0.26, 0.36, 24),
    new THREE.MeshBasicMaterial({ color: 0x2bd1c4, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
  );
  selRing.rotation.x = -Math.PI / 2;
  selRing.visible = false;
  scene.add(selRing);

  bindPicking(renderer.domElement);
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
  // A real fan palm: bent trunk + two stacked frond umbrellas + coconuts.
  const g = new THREE.Group();
  const r = hashStr(id);
  const h = 1.15 + r * 0.55;
  const lean = (r - 0.5) * 0.35;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.08, h, 5), lam(C.trunk));
  trunk.position.set(Math.sin(lean) * h * 0.4, h / 2, 0);
  trunk.rotation.z = lean;
  trunk.castShadow = true;
  g.add(trunk);
  const topX = Math.sin(lean) * h * 0.8;
  // fronds: inverted shallow cones with few segments = a low-poly leaf umbrella
  const fr1 = new THREE.Mesh(new THREE.ConeGeometry(0.62 + r * 0.15, 0.30, 7, 1, true), lam(C.leafDark));
  fr1.position.set(topX, h + 0.02, 0);
  fr1.rotation.x = Math.PI;                      // open side up
  fr1.rotation.y = r * 3;
  fr1.castShadow = true;
  g.add(fr1);
  const fr2 = new THREE.Mesh(new THREE.ConeGeometry(0.46 + r * 0.1, 0.34, 6, 1, true), lam(C.leaf));
  fr2.position.set(topX, h + 0.14, 0);
  fr2.rotation.x = Math.PI;
  fr2.rotation.y = r * 5 + 0.4;
  fr2.castShadow = true;
  g.add(fr2);
  const nut = new THREE.Mesh(new THREE.SphereGeometry(0.055, 5, 4), lam(0x6d4c2c));
  nut.position.set(topX + 0.08, h - 0.02, 0.05);
  g.add(nut);
  return g;
}

function makeFruitTree(id: string): THREE.Group {
  // Round-crown tree with visible fruit — food sources read at a glance.
  const g = new THREE.Group();
  const r = hashStr(id);
  const h = 0.8 + r * 0.3;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, h, 5), lam(C.trunk));
  trunk.position.y = h / 2;
  trunk.castShadow = true;
  g.add(trunk);
  const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(0.4 + r * 0.1, 0), lam(C.leaf));
  crown.position.y = h + 0.16;
  crown.scale.y = 0.8;
  crown.castShadow = true;
  g.add(crown);
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

function flameMesh(s: number, y: number): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.ConeGeometry(s * 0.5, s * 1.4, 6),
    new THREE.MeshBasicMaterial({ color: C.flame }),
  );
  m.position.y = y + s * 0.7;
  return m;
}

function makeStructure(s: StructureState): THREE.Group {
  const g = new THREE.Group();
  const st = s.state ?? {};
  const building = st.buildable_kind !== undefined && !st.complete;
  const fp = Math.max(s.w || 1, s.h || 1);        // footprint in tiles
  const lit = Boolean(st.complete) && ((st.fuel as number) ?? 0) > 0;

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
      for (let i = 0; i < 6; i += 1) {
        const a = (i / 6) * Math.PI * 2;
        g.add(box(0.1, 0.08, 0.1, 0x8b867c, Math.cos(a) * 0.3, 0.04, Math.sin(a) * 0.3));
      }
      const log1 = box(0.4, 0.07, 0.07, WOOD_D, 0, 0.06, 0);
      log1.rotation.y = 0.6;
      g.add(log1);
      const log2 = box(0.4, 0.07, 0.07, WOOD, 0, 0.1, 0);
      log2.rotation.y = -0.5;
      g.add(log2);
      if (lit) g.add(flameMesh(0.22, 0.1));
      break;
    }
    case "signal_fire": {
      g.add(cone(0.42, 0.5, 6, WOOD_D, 0, 0.25, 0));
      g.add(cone(0.3, 0.42, 5, WOOD, 0, 0.36, 0));
      g.add(flameMesh(0.34, 0.55));
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
        g.add(steam);
      }
      break;
    }
    case "lighthouse": {
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
      g.add(cyl(0.3, 0.34, 0.08, 8, METAL_D, 0, 0.04, 0));
      const btn = new THREE.Mesh(new THREE.SphereGeometry(0.04, 5, 4),
        new THREE.MeshBasicMaterial({ color: 0xc0574f }));
      btn.position.set(0.14, 0.1, 0);
      g.add(btn);
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
  // Bigger footprints scale their assembly up.
  const scale = 0.8 + fp * 0.35;
  g.scale.set(scale, scale, scale);
  return g;
}

function buildStructs(st: WorldState): void {
  structsGroup?.removeFromParent();
  for (const l of fireLights) l.removeFromParent();
  fireLights = [];
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

  // day/night: real lighting, not an overlay (time-based, frame-rate agnostic)
  const targetNight = state.is_night ? 1 : 0;
  nightMix += (targetNight - nightMix) * Math.min(1, dt * 1.6);
  sun.intensity = 2.9 - nightMix * 2.62;
  ambient.intensity = 0.45 - nightMix * 0.22;
  tmpColor.copy(dayFog).lerp(nightFog, nightMix);
  (scene.background as THREE.Color).copy(tmpColor);
  scene.fog!.color.copy(tmpColor);
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

  controls.update();
  renderer.render(scene, camera);
}
