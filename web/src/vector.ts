// Procedural vector renderer (Graphics sprint G1, no raster assets).
//
// The whole island look is generated from the world grid the backend already
// sends: tile masks -> marching-squares contours -> Chaikin smoothing ->
// layered filled polygons. That kills the two structural problems of tilesets
// (the jagged tile coastline and the third-party art dependency) and gives the
// observer a clean "diorama" aesthetic: a smooth island slab floating in the
// sea, flat-colour biome layers, stylised props and meeple survivors.
//
// Everything here is deterministic: same world -> same picture.

import { Container, Graphics } from "pixi.js";
import { TILE_SIZE } from "./constants";
import { agentHue, hslToRgbInt } from "./utils";
import type { AgentState, ResourceState, WorldState } from "./types";

// ── palette (single source of the vector look) ────────────────────────────────
export const V = {
  seaShallow: 0x3d7f8e,      // dilated ring around the island
  seaFoam: 0xbfe3e0,         // thin foam line at the waterline
  slab: 0x8a6f4d,            // the island's "cliff" extrusion (diorama side)
  slabDark: 0x6e5539,
  sand: 0xe3d29b,
  grass: 0x88b35f,
  jungle: 0x5d8f4a,
  rock: 0x9a938a,
  rockDark: 0x7e766c,
  trunk: 0x8a6239,
  palmLeaf: 0x4f8f4f,
  palmLeafDark: 0x3f7440,
  bush: 0x6ca055,
  bushDark: 0x558843,
  stone: 0xa8a49c,
  stoneDark: 0x8b867c,
  flint: 0xd9a441,
  shell: 0xf2e8d8,
  poolWater: 0x4fa3b5,
  poolRim: 0x8a7a55,
  shadow: 0x1c2e1a,
} as const;

const SLAB_DEPTH = TILE_SIZE * 0.55;   // visual thickness of the island plate

// ── mask -> smooth loops (marching squares + Chaikin) ─────────────────────────
type Pt = [number, number];

/** Trace all iso-contours of a boolean tile mask. Returns closed loops in tile
 * coordinates (tile centres at x+0.5). Land loops and hole loops come out with
 * opposite winding, so drawing them into one path with a nonzero fill rule
 * renders holes (inland lakes) correctly for free. */
export function maskLoops(n: number, solid: (x: number, y: number) => boolean): Pt[][] {
  const s = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < n && y < n && solid(x, y);
  // Segment per cell of the dual grid; endpoints keyed for chaining.
  const key = (p: Pt) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
  const segs = new Map<string, { a: Pt; b: Pt }[]>();
  const addSeg = (a: Pt, b: Pt) => {
    const k = key(a);
    const arr = segs.get(k) ?? [];
    arr.push({ a, b });
    segs.set(k, arr);
  };
  for (let y = -1; y < n; y += 1) {
    for (let x = -1; x < n; x += 1) {
      // corners of the dual cell = 4 tile centres
      const tl = s(x, y), tr = s(x + 1, y), bl = s(x, y + 1), br = s(x + 1, y + 1);
      const idx = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      const cx = x + 1, cy = y + 1;                 // dual-cell centre in tile units
      const top: Pt = [cx, cy - 0.5];
      const right: Pt = [cx + 0.5, cy];
      const bottom: Pt = [cx, cy + 0.5];
      const left: Pt = [cx - 0.5, cy];
      // Directed so that solid stays on the LEFT of a->b (consistent winding).
      switch (idx) {
        case 1: addSeg(left, bottom); break;
        case 2: addSeg(bottom, right); break;
        case 3: addSeg(left, right); break;
        case 4: addSeg(right, top); break;
        case 5: addSeg(right, bottom); addSeg(left, top); break;   // saddle
        case 6: addSeg(bottom, top); break;
        case 7: addSeg(left, top); break;
        case 8: addSeg(top, left); break;
        case 9: addSeg(top, bottom); break;
        case 10: addSeg(top, right); addSeg(bottom, left); break;  // saddle
        case 11: addSeg(top, right); break;
        case 12: addSeg(right, left); break;
        case 13: addSeg(right, bottom); break;
        case 14: addSeg(bottom, left); break;
      }
    }
  }
  // Chain segments into closed loops.
  const loops: Pt[][] = [];
  const used = new Set<{ a: Pt; b: Pt }>();
  for (const bucket of segs.values()) {
    for (const start of bucket) {
      if (used.has(start)) continue;
      const loop: Pt[] = [start.a];
      let cur = start;
      for (let guard = 0; guard < 100000; guard += 1) {
        used.add(cur);
        loop.push(cur.b);
        const nexts = segs.get(key(cur.b)) ?? [];
        const next = nexts.find((sg) => !used.has(sg));
        if (!next) break;
        cur = next;
      }
      if (loop.length >= 4) loops.push(loop);
    }
  }
  return loops;
}

/** Chaikin corner-cutting on a closed loop: staircase -> smooth curve. */
export function chaikin(loop: Pt[], iterations = 3): Pt[] {
  let pts = loop;
  for (let it = 0; it < iterations; it += 1) {
    const out: Pt[] = [];
    for (let i = 0; i < pts.length; i += 1) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    pts = out;
  }
  return pts;
}

function drawLoops(g: Graphics, loops: Pt[][], scale: number,
                   dx = 0, dy = 0): Graphics {
  for (const loop of loops) {
    g.moveTo(loop[0][0] * scale + dx, loop[0][1] * scale + dy);
    for (let i = 1; i < loop.length; i += 1) {
      g.lineTo(loop[i][0] * scale + dx, loop[i][1] * scale + dy);
    }
    g.closePath();
  }
  return g;
}

// ── mask helpers over the world grid ──────────────────────────────────────────
function grid_masks(state: WorldState) {
  const n = state.map.size;
  const grid = state.map.grid;
  const water = (x: number, y: number) =>
    x < 0 || y < 0 || x >= n || y >= n || grid[y][x].includes("water");
  const land = (x: number, y: number) => !water(x, y);
  const grassy = (x: number, y: number) =>
    land(x, y) && !grid[y][x].includes("sand");
  const rock = (x: number, y: number) =>
    land(x, y) && grid[y][x].includes("rock");

  // Jungle mask smoothed the same way the tile renderer does, so its boundary
  // reads as one clean wavy line without lone one-tile fingers.
  const raw: boolean[][] = [];
  for (let y = 0; y < n; y += 1) {
    const row: boolean[] = [];
    for (let x = 0; x < n; x += 1) row.push(grid[y][x].includes("foliage"));
    raw.push(row);
  }
  const sm = raw.map((r) => r.slice());
  const near4 = (g: boolean[][], x: number, y: number) =>
    ((g[y - 1]?.[x] ? 1 : 0) + (g[y + 1]?.[x] ? 1 : 0) +
     (g[y]?.[x - 1] ? 1 : 0) + (g[y]?.[x + 1] ? 1 : 0));
  for (let y = 0; y < n; y += 1)
    for (let x = 0; x < n; x += 1) {
      const c = near4(raw, x, y);
      if (!raw[y][x] && c >= 3) sm[y][x] = true;
      else if (raw[y][x] && c <= 1) sm[y][x] = false;
    }
  const jungle = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < n && y < n && sm[y][x] && land(x, y);

  // Dilated land (radius r) for the shallow-water ring.
  const dilated = (r: number) => (x: number, y: number) => {
    for (let dy = -r; dy <= r; dy += 1)
      for (let dx = -r; dx <= r; dx += 1)
        if (land(x + dx, y + dy)) return true;
    return false;
  };
  return { n, land, grassy, jungle, rock, dilated };
}

// Cache: geometry depends only on the map, not on per-tick state.
let cachedKey = "";
let cachedTerrain: Container | null = null;

/** Build (or reuse) the whole island terrain as one container of smooth
 * polygons: shallow rings -> slab shadow -> slab -> sand -> grass -> jungle ->
 * rock -> foam line. */
export function buildVectorTerrain(state: WorldState): Container {
  const mapKey = `${state.scenario}:${state.map.size}`;
  if (cachedTerrain && cachedKey === mapKey) return cachedTerrain;
  cachedTerrain?.destroy({ children: true });

  const { n, land, grassy, jungle, rock, dilated } = grid_masks(state);
  const T = TILE_SIZE;
  const c = new Container();

  const landLoops = maskLoops(n, land).map((l) => chaikin(l, 3));
  const grassLoops = maskLoops(n, grassy).map((l) => chaikin(l, 3));
  const jungleLoops = maskLoops(n, jungle).map((l) => chaikin(l, 3));
  const rockLoops = maskLoops(n, rock).map((l) => chaikin(l, 3));
  const shallow1 = maskLoops(n, dilated(2)).map((l) => chaikin(l, 2));
  const shallow2 = maskLoops(n, dilated(1)).map((l) => chaikin(l, 2));

  // Shallow water rings (light teal halo fading toward the coast).
  c.addChild(drawLoops(new Graphics(), shallow1, T).fill({ color: V.seaShallow, alpha: 0.35 }));
  c.addChild(drawLoops(new Graphics(), shallow2, T).fill({ color: V.seaShallow, alpha: 0.55 }));

  // Diorama: soft drop shadow on the water, then the slab (island thickness),
  // then the land surface stacked on top, lifted so the slab shows at the south.
  c.addChild(drawLoops(new Graphics(), landLoops, T, 3, SLAB_DEPTH + 5)
    .fill({ color: 0x10242c, alpha: 0.30 }));
  const slab = drawLoops(new Graphics(), landLoops, T, 0, SLAB_DEPTH).fill(V.slab);
  drawLoops(slab, landLoops, T, 0, SLAB_DEPTH * 0.55).fill(V.slabDark);
  c.addChild(slab);

  c.addChild(drawLoops(new Graphics(), landLoops, T).fill(V.sand));
  c.addChild(drawLoops(new Graphics(), grassLoops, T).fill(V.grass));
  c.addChild(drawLoops(new Graphics(), jungleLoops, T).fill(V.jungle));
  const rockG = drawLoops(new Graphics(), rockLoops, T).fill(V.rock);
  drawLoops(rockG, rockLoops, T, -1.5, -2.5).fill({ color: 0xffffff, alpha: 0.10 });
  c.addChild(rockG);

  // Foam line at the waterline.
  c.addChild(drawLoops(new Graphics(), landLoops, T)
    .stroke({ width: 2, color: V.seaFoam, alpha: 0.8 }));

  cachedKey = mapKey;
  cachedTerrain = c;
  return c;
}

/** Drop the cached terrain (call when the world identity changes). */
export function invalidateVectorTerrain(): void {
  cachedTerrain?.destroy({ children: true });
  cachedTerrain = null;
  cachedKey = "";
}

// ── deterministic per-id variation ────────────────────────────────────────────
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

// ── props (palms, rocks, bushes, springs, shells) drawn per node ──────────────
function shadow(g: Graphics, w: number): Graphics {
  return g.ellipse(0, 0, w, w * 0.36).fill({ color: V.shadow, alpha: 0.22 });
}

function drawPalm(id: string): Graphics {
  const g = new Graphics();
  const r = hashStr(id);
  const lean = (r - 0.5) * 10;                 // trunk lean, px at the crown
  const h = TILE_SIZE * (1.5 + r * 0.5);       // height varies per tree
  shadow(g, TILE_SIZE * 0.5);
  // curved trunk
  g.moveTo(0, 0).quadraticCurveTo(lean * 0.4, -h * 0.6, lean, -h)
    .stroke({ width: 3.4, color: V.trunk });
  // crown: a lush fan of 8 fronds around the top (two green tones)
  const cx = lean, cy = -h;
  for (let i = 0; i < 8; i += 1) {
    const ang = (i / 8) * Math.PI * 2 + r * 2;
    const lx = Math.cos(ang) * TILE_SIZE * 0.78;
    const ly = Math.sin(ang) * TILE_SIZE * 0.42 - 3;
    g.moveTo(cx, cy)
      .quadraticCurveTo(cx + lx * 0.55, cy + ly * 0.55 - 6, cx + lx, cy + ly)
      .stroke({ width: 3.6, color: i % 2 ? V.palmLeaf : V.palmLeafDark, cap: "round" });
  }
  g.circle(cx, cy - 1, 3.4).fill(V.palmLeafDark);   // crown core ties fronds together
  g.circle(cx, cy + 1, 2.2).fill(V.trunk);      // coconuts
  g.circle(cx - 3, cy + 2.5, 1.8).fill(V.slabDark);
  return g;
}

function drawRock(id: string, tint: number = V.stone, tintDark: number = V.stoneDark): Graphics {
  const g = new Graphics();
  const r = hashStr(id);
  const w = TILE_SIZE * (0.38 + r * 0.2);
  shadow(g, w * 1.1);
  // irregular 6-gon
  const pts: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const ang = (i / 6) * Math.PI * 2;
    const rad = w * (0.8 + hashStr(id + i) * 0.4);
    pts.push(Math.cos(ang) * rad, -w * 0.5 + Math.sin(ang) * rad * 0.7);
  }
  g.poly(pts).fill(tint).stroke({ width: 1.5, color: tintDark });
  g.poly(pts.map((v, i) => (i % 2 ? v - w * 0.16 : v * 0.55))).fill({ color: 0xffffff, alpha: 0.14 });
  return g;
}

function drawBush(id: string): Graphics {
  const g = new Graphics();
  const r = hashStr(id);
  shadow(g, TILE_SIZE * 0.34);
  const s = TILE_SIZE * (0.24 + r * 0.08);
  g.circle(-s * 0.7, -s * 0.7, s).fill(V.bushDark);
  g.circle(s * 0.7, -s * 0.8, s * 0.95).fill(V.bush);
  g.circle(0, -s * 1.2, s * 1.05).fill(V.bush);
  g.circle(-s * 0.2, -s * 1.5, s * 0.55).fill({ color: 0xffffff, alpha: 0.10 });
  return g;
}

function drawOreRock(id: string): Graphics {
  const g = drawRock(id, V.stoneDark, 0x6b665e);
  const r = hashStr(id + "ore");
  for (let i = 0; i < 3; i += 1) {
    g.circle((r - 0.5) * 8 + i * 5 - 5, -6 - i * 3, 1.8).fill(V.flint);
  }
  return g;
}

function drawShellBed(id: string): Graphics {
  const g = new Graphics();
  g.ellipse(0, -3, TILE_SIZE * 0.55, TILE_SIZE * 0.3).fill({ color: V.shell, alpha: 0.45 });
  for (let i = 0; i < 5; i += 1) {
    const r = hashStr(id + i);
    const x = (r - 0.5) * TILE_SIZE * 0.9;
    const y = -3 + (hashStr(id + i + "y") - 0.5) * TILE_SIZE * 0.4;
    g.circle(x, y, 2.2).fill(V.shell).stroke({ width: 0.8, color: V.poolRim });
  }
  return g;
}

function drawPool(id: string, w: number): Graphics {
  const g = new Graphics();
  const rx = TILE_SIZE * w, ry = TILE_SIZE * w * 0.62;
  const cy = -TILE_SIZE * 0.35;
  g.ellipse(0, cy, rx * 1.25, ry * 1.25).fill({ color: V.poolRim, alpha: 0.5 });
  g.ellipse(0, cy, rx, ry).fill(V.poolWater);
  g.ellipse(-rx * 0.28, cy - ry * 0.3, rx * 0.4, ry * 0.26)
    .fill({ color: 0xffffff, alpha: 0.35 });
  g.ellipse(0, cy, rx, ry).stroke({ width: 1.2, color: 0x2a5866, alpha: 0.5 });
  return g;
}

/** One vector prop for a resource node, or null for kinds without a drawing. */
export function buildVectorProp(node: ResourceState): Graphics | null {
  const k = node.kind;
  if (k === "wood" || k === "fruit_tree") return drawPalm(node.id);
  if (k === "rocks") return drawRock(node.id);
  if (k === "orerock") return drawOreRock(node.id);
  if (k === "thicket") return drawBush(node.id);
  if (k === "shell_bed") return drawShellBed(node.id);
  if (k === "spring") return drawPool(node.id, 0.5);
  if (k === "fishing") return drawPool(node.id, 0.42);
  return null;
}

// ── meeples: code-drawn survivors ─────────────────────────────────────────────
export type Meeple = Graphics;

/** A Bad-North style meeple: capsule body in the agent's colour, round head,
 * hair bun for women. Feet at (0, 0); flip via scale.x; death handled by the
 * caller (rotation + tint). */
export function buildMeeple(agentId: string, gender?: string): Meeple {
  const hue = agentHue(agentId);
  const body = hslToRgbInt(hue, 58, 55);
  const bodyDark = hslToRgbInt(hue, 58, 42);
  const head = hslToRgbInt(hue, 34, 78);
  const g = new Graphics();
  const W = 10, H = 14;
  // body capsule
  g.roundRect(-W / 2, -H, W, H, W / 2).fill(body).stroke({ width: 1.2, color: bodyDark });
  // subtle front highlight
  g.roundRect(-W / 2 + 1.6, -H + 1.6, W * 0.42, H - 4, W / 3).fill({ color: 0xffffff, alpha: 0.14 });
  // head
  g.circle(0, -H - 4.4, 4.6).fill(head).stroke({ width: 1.2, color: bodyDark });
  if (gender === "female") {
    g.circle(3.6, -H - 7.2, 2.1).fill(bodyDark);   // hair bun
  }
  return g;
}

/** Cloud-shadow blob texture source: a soft dark radial blob drawn on canvas. */
export function makeCloudShadowCanvas(): HTMLCanvasElement {
  const size = 160;
  const cv = document.createElement("canvas");
  cv.width = size; cv.height = size / 2;
  const ctx = cv.getContext("2d")!;
  const blob = (x: number, y: number, r: number) => {
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, "rgba(12,26,20,0.55)");
    grad.addColorStop(1, "rgba(12,26,20,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };
  blob(50, 40, 38); blob(85, 34, 44); blob(118, 42, 34);
  return cv;
}
