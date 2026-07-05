// Procedural vector renderer, quality pass G2.
//
// Everything is generated from the world grid — no raster assets. What sells
// the look is not geometry but LIGHT: one imaginary sun in the north-west,
// every layer gets a lit rim toward it and a shade rim away from it, every
// prop drops a directional shadow, the meadow is broken up by tonal patches
// and scattered detail, and each structure kind is actually drawn.
//
// Deterministic: same world -> same picture (scatter/noise use hashed or
// seeded generators, never Math.random).

import { Container, Graphics, Texture, TilingSprite } from "pixi.js";
import { TILE_SIZE } from "./constants";
import { agentHue, hslToRgbInt } from "./utils";
import type { ResourceState, StructureState, WorldState } from "./types";

// ── palette ───────────────────────────────────────────────────────────────────
export const V = {
  seaDeep: 0x2e6d84,
  seaShallow: 0x5fb7c2,
  seaFoam: 0xe2f5f0,
  slabTop: 0xa8845a,        // island plate (diorama side)
  slabDark: 0x7c5f3e,
  sand: 0xf2e3b0,
  grass: 0xa2d573,
  grassLight: 0xb8e488,
  grassDark: 0x8cc161,
  jungle: 0x71b25c,
  rock: 0xb5ada0,
  trunk: 0x8a6239,
  trunkDark: 0x6d4c2c,
  palmLeaf: 0x55984f,
  palmLeafDark: 0x417c40,
  bush: 0x6ca055,
  bushDark: 0x558843,
  stone: 0xb0aba1,
  stoneDark: 0x8b867c,
  flint: 0xd9a441,
  shell: 0xf2e8d8,
  poolWater: 0x53aabb,
  poolRim: 0x8a7a55,
  shadow: 0x1c2e1a,
  wood: 0xa07848,
  woodDark: 0x7c5a34,
  canvasCloth: 0xd9c69a,
  canvasDark: 0xbfa878,
  flame: 0xf2913d,
  flameCore: 0xffd166,
  metal: 0x9aa2ab,
  metalDark: 0x6e767f,
  stoneWall: 0xb7b0a4,
} as const;

// Sun from the NW: light rims up-left, shadows fall down-right.
const RIM_L: [number, number] = [-1.6, -2.2];
const RIM_D: [number, number] = [2.2, 3.0];
const SHADOW_DX = 3.5;
const SLAB_DEPTH = TILE_SIZE * 0.55;

function shade(color: number, f: number): number {
  // f > 0 lighten toward white, f < 0 darken toward black
  const r = (color >> 16) & 255, g = (color >> 8) & 255, b = color & 255;
  const mix = (c: number) => Math.round(f >= 0 ? c + (255 - c) * f : c * (1 + f));
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}

// ── deterministic hashing / rng ───────────────────────────────────────────────
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

function hash01(x: number, y: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2246822519) >>> 0;
  h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
  return (h >>> 8) / 16777216;
}

// ── mask -> smooth loops (marching squares + Chaikin) ─────────────────────────
type Pt = [number, number];

export function maskLoops(n: number, solid: (x: number, y: number) => boolean): Pt[][] {
  const s = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < n && y < n && solid(x, y);
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
      const tl = s(x, y), tr = s(x + 1, y), bl = s(x, y + 1), br = s(x + 1, y + 1);
      const idx = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      const cx = x + 1, cy = y + 1;
      const top: Pt = [cx, cy - 0.5];
      const right: Pt = [cx + 0.5, cy];
      const bottom: Pt = [cx, cy + 0.5];
      const left: Pt = [cx - 0.5, cy];
      switch (idx) {
        case 1: addSeg(left, bottom); break;
        case 2: addSeg(bottom, right); break;
        case 3: addSeg(left, right); break;
        case 4: addSeg(right, top); break;
        case 5: addSeg(right, bottom); addSeg(left, top); break;
        case 6: addSeg(bottom, top); break;
        case 7: addSeg(left, top); break;
        case 8: addSeg(top, left); break;
        case 9: addSeg(top, bottom); break;
        case 10: addSeg(top, right); addSeg(bottom, left); break;
        case 11: addSeg(top, right); break;
        case 12: addSeg(right, left); break;
        case 13: addSeg(right, bottom); break;
        case 14: addSeg(bottom, left); break;
      }
    }
  }
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

function drawLoops(g: Graphics, loops: Pt[][], scale: number, dx = 0, dy = 0): Graphics {
  for (const loop of loops) {
    g.moveTo(loop[0][0] * scale + dx, loop[0][1] * scale + dy);
    for (let i = 1; i < loop.length; i += 1) {
      g.lineTo(loop[i][0] * scale + dx, loop[i][1] * scale + dy);
    }
    g.closePath();
  }
  return g;
}

/** Fill a biome layer with fake directional light: a lit copy offset toward the
 * sun and a shaded copy away from it are drawn UNDER the true fill, so only
 * thin rims of them survive along the silhouette. Cheap, mask-free. */
function shadedLayer(loops: Pt[][], color: number, T: number,
                     rim = 0.14): Graphics {
  const g = new Graphics();
  drawLoops(g, loops, T, RIM_D[0], RIM_D[1]).fill(shade(color, -rim - 0.04));
  drawLoops(g, loops, T, RIM_L[0], RIM_L[1]).fill(shade(color, rim));
  drawLoops(g, loops, T).fill(color);
  return g;
}

// ── masks over the world grid ─────────────────────────────────────────────────
function gridMasks(state: WorldState) {
  const n = state.map.size;
  const grid = state.map.grid;
  const water = (x: number, y: number) =>
    x < 0 || y < 0 || x >= n || y >= n || grid[y][x].includes("water");
  const land = (x: number, y: number) => !water(x, y);
  const grassy = (x: number, y: number) => land(x, y) && !grid[y][x].includes("sand");
  const rock = (x: number, y: number) => land(x, y) && grid[y][x].includes("rock");

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
  // Drop micro-blobs (components of <= 2 cells): a lone rounded square of dark
  // green reads as dirt, not as a grove.
  const seen = sm.map((r) => r.map(() => false));
  for (let y = 0; y < n; y += 1)
    for (let x = 0; x < n; x += 1) {
      if (!sm[y][x] || seen[y][x]) continue;
      const comp: [number, number][] = [];
      const stack: [number, number][] = [[x, y]];
      seen[y][x] = true;
      while (stack.length) {
        const [cx2, cy2] = stack.pop()!;
        comp.push([cx2, cy2]);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = cx2 + dx, ny = cy2 + dy;
          if (nx >= 0 && ny >= 0 && nx < n && ny < n && sm[ny][nx] && !seen[ny][nx]) {
            seen[ny][nx] = true;
            stack.push([nx, ny]);
          }
        }
      }
      if (comp.length <= 2) for (const [px2, py2] of comp) sm[py2][px2] = false;
    }
  const jungle = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < n && y < n && sm[y][x] && land(x, y);

  // Tonal meadow patches: hashed blobs, smoothed so they read as gentle
  // colour variation instead of pixel noise.
  const patch = (salt: number, thr: number) => {
    const rawP: boolean[][] = [];
    for (let y = 0; y < n; y += 1) {
      const row: boolean[] = [];
      for (let x = 0; x < n; x += 1)
        row.push(grassy(x, y) && !jungle(x, y) && hash01(x >> 1, y >> 1, salt) < thr);
      rawP.push(row);
    }
    return (x: number, y: number) =>
      x >= 0 && y >= 0 && x < n && y < n && rawP[y][x];
  };

  const dilated = (r: number) => (x: number, y: number) => {
    for (let dy = -r; dy <= r; dy += 1)
      for (let dx = -r; dx <= r; dx += 1)
        if (land(x + dx, y + dy)) return true;
    return false;
  };
  return { n, grid, land, grassy, jungle, rock, patch, dilated };
}

// ── film grain (seeded, subtle) ───────────────────────────────────────────────
let noiseTex: Texture | null = null;

function noiseTexture(): Texture {
  if (noiseTex) return noiseTex;
  const size = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  // 2D hash per pixel (an LCG stream correlates along rows and reads as weave).
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let h = (x * 374761393 + y * 668265263) >>> 0;
      h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
      const v = 244 + (h >>> 24) % 12;              // 244..255 — barely-there grain
      const i = (y * size + x) * 4;
      img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  noiseTex = Texture.from(cv);
  return noiseTex;
}

// ── terrain (cached per map identity) ─────────────────────────────────────────
let cachedKey = "";
let cachedTerrain: Container | null = null;

export function buildVectorTerrain(state: WorldState): Container {
  const mapKey = `${state.scenario}:${state.map.size}`;
  if (cachedTerrain && cachedKey === mapKey) return cachedTerrain;
  cachedTerrain?.destroy({ children: true });

  const { n, grid, land, grassy, jungle, rock, patch, dilated } = gridMasks(state);
  const T = TILE_SIZE;
  const c = new Container();

  const landLoops = maskLoops(n, land).map((l) => chaikin(l, 3));
  const grassLoops = maskLoops(n, grassy).map((l) => chaikin(l, 3));
  const jungleLoops = maskLoops(n, jungle).map((l) => chaikin(l, 3));
  const rockLoops = maskLoops(n, rock).map((l) => chaikin(l, 3));
  const lightPatch = maskLoops(n, patch(11, 0.30)).map((l) => chaikin(l, 2));
  const darkPatch = maskLoops(n, patch(23, 0.24)).map((l) => chaikin(l, 2));

  // Shallow-water halo: four rings for a soft depth falloff (outermost is a
  // faint glow that lifts the island off the dark sea).
  for (const [r, a] of [[7, 0.08], [4, 0.18], [2, 0.36], [1, 0.52]] as const) {
    const loops = maskLoops(n, dilated(r)).map((l) => chaikin(l, 2));
    c.addChild(drawLoops(new Graphics(), loops, T).fill({ color: V.seaShallow, alpha: a }));
  }

  // Diorama: drop shadow on the water, then the slab, then the lit land layers.
  c.addChild(drawLoops(new Graphics(), landLoops, T, 4, SLAB_DEPTH + 6)
    .fill({ color: 0x0e222b, alpha: 0.35 }));
  const slab = drawLoops(new Graphics(), landLoops, T, 0, SLAB_DEPTH).fill(V.slabTop);
  drawLoops(slab, landLoops, T, 0, SLAB_DEPTH * 0.6).fill(V.slabDark);
  c.addChild(slab);

  c.addChild(shadedLayer(landLoops, V.sand, T, 0.10));
  c.addChild(shadedLayer(grassLoops, V.grass, T));
  // Tonal variation on the meadow (no rims — just gentle colour drift).
  c.addChild(drawLoops(new Graphics(), lightPatch, T).fill({ color: V.grassLight, alpha: 0.6 }));
  c.addChild(drawLoops(new Graphics(), darkPatch, T).fill({ color: V.grassDark, alpha: 0.55 }));
  c.addChild(shadedLayer(jungleLoops, V.jungle, T, 0.10));

  // Rock plateau as a raised terrace: its own shade under the south edge.
  c.addChild(drawLoops(new Graphics(), rockLoops, T, 0, 4)
    .fill({ color: 0x5f594e, alpha: 0.5 }));
  c.addChild(shadedLayer(rockLoops, V.rock, T, 0.16));

  // Waterline foam.
  c.addChild(drawLoops(new Graphics(), landLoops, T)
    .stroke({ width: 2, color: V.seaFoam, alpha: 0.85 }));

  // Scatter detail: grass tufts, pebbles, flowers — hashed, sparse, cheap.
  const scatter = new Graphics();
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (!grassy(x, y) || rock(x, y)) continue;
      const r = hash01(x, y, 7);
      if (r > 0.16) continue;
      const px = (x + 0.2 + hash01(x, y, 8) * 0.6) * T;
      const py = (y + 0.2 + hash01(x, y, 9) * 0.6) * T;
      if (r < 0.09) {
        // grass tuft: three short blades
        const col = jungle(x, y) ? shade(V.jungle, -0.18) : V.grassDark;
        for (let b = -1; b <= 1; b += 1) {
          scatter.moveTo(px + b * 2, py)
            .lineTo(px + b * 3.2, py - 4.5 - (b === 0 ? 1.5 : 0));
        }
        scatter.stroke({ width: 1.2, color: col, alpha: 0.9 });
      } else if (r < 0.13) {
        scatter.circle(px, py, 1.6).fill({ color: V.stoneDark, alpha: 0.7 });
      } else if (!jungle(x, y)) {
        scatter.circle(px, py, 1.4).fill(hash01(x, y, 10) < 0.5 ? 0xf2ead2 : 0xe8a8b8);
        scatter.circle(px, py, 0.6).fill(0xd9b13f);
      }
    }
  }
  c.addChild(scatter);

  // Subtle multiply grain so the flats don't read as plastic.
  const grain = new TilingSprite({
    texture: noiseTexture(), width: n * T + 160, height: n * T + SLAB_DEPTH + 160,
  });
  grain.x = -80; grain.y = -80;
  grain.alpha = 0.35;
  grain.blendMode = "multiply";
  c.addChild(grain);

  cachedKey = mapKey;
  cachedTerrain = c;
  return c;
}

export function invalidateVectorTerrain(): void {
  cachedTerrain?.destroy({ children: true });
  cachedTerrain = null;
  cachedKey = "";
}

// ── props ─────────────────────────────────────────────────────────────────────
function dropShadow(g: Graphics, w: number, dy = -2): Graphics {
  return g.ellipse(SHADOW_DX, dy, w, w * 0.34).fill({ color: V.shadow, alpha: 0.22 });
}

function frond(g: Graphics, cx: number, cy: number, ang: number, len: number,
               width: number, color: number): void {
  // A filled palm leaf: out along `ang`, slight droop, back with width.
  const dx = Math.cos(ang), dy = Math.sin(ang) * 0.55;
  const tipX = cx + dx * len, tipY = cy + dy * len + len * 0.22;
  const midX = cx + dx * len * 0.55, midY = cy + dy * len * 0.5 - 4;
  const nx = -dy * 0.7, ny = dx * 0.7;                     // sideways normal
  g.moveTo(cx, cy)
    .quadraticCurveTo(midX + nx * width, midY + ny * width, tipX, tipY)
    .quadraticCurveTo(midX - nx * width, midY - ny * width, cx, cy)
    .closePath()
    .fill(color);
}

function drawPalm(id: string): Graphics {
  const g = new Graphics();
  const r = hashStr(id);
  const lean = (r - 0.5) * 12;
  const h = TILE_SIZE * (1.55 + r * 0.5);
  dropShadow(g, TILE_SIZE * 0.55);
  // tapered trunk with a bend and ring marks
  g.moveTo(-2.2, 0).quadraticCurveTo(lean * 0.35 - 1, -h * 0.6, lean - 1.2, -h)
    .lineTo(lean + 1.2, -h).quadraticCurveTo(lean * 0.35 + 2, -h * 0.6, 2.6, 0)
    .closePath().fill(V.trunk);
  for (let i = 1; i <= 3; i += 1) {
    const t = i / 4;
    g.circle(lean * 0.35 * t * 2 + (1 - t) * 0, -h * t, 1.1).fill({ color: V.trunkDark, alpha: 0.6 });
  }
  // crown: filled fronds, back row dark, front row light
  const cx = lean, cy = -h;
  for (let i = 0; i < 4; i += 1) {
    frond(g, cx, cy, (i / 4) * Math.PI * 2 + 0.5 + r, TILE_SIZE * (0.72 + r * 0.12), 5.2, V.palmLeafDark);
  }
  for (let i = 0; i < 4; i += 1) {
    frond(g, cx, cy, (i / 4) * Math.PI * 2 + 1.28 + r, TILE_SIZE * (0.66 + r * 0.1), 4.6, V.palmLeaf);
  }
  g.circle(cx, cy, 2.6).fill(V.trunkDark);
  g.circle(cx - 3.4, cy + 1.6, 1.9).fill(V.trunkDark);      // coconuts
  g.circle(cx + 3.2, cy + 1.8, 1.7).fill(V.trunkDark);
  return g;
}

function rockPoly(id: string, w: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i < 7; i += 1) {
    const ang = (i / 7) * Math.PI * 2;
    const rad = w * (0.75 + hashStr(id + i) * 0.45);
    pts.push(Math.cos(ang) * rad, -w * 0.5 + Math.sin(ang) * rad * 0.66);
  }
  return pts;
}

function drawRock(id: string, tint: number = V.stone, tintDark: number = V.stoneDark): Graphics {
  const g = new Graphics();
  const r = hashStr(id);
  const w = TILE_SIZE * (0.36 + r * 0.2);
  dropShadow(g, w * 1.15, -1);
  const pts = rockPoly(id, w);
  // dark base facet, then a lit top facet shifted toward the sun
  g.poly(pts).fill(tintDark);
  g.poly(pts.map((v, i) => (i % 2 === 0 ? v * 0.78 - 1.8 : v * 0.78 - w * 0.28))).fill(tint);
  g.poly(pts.map((v, i) => (i % 2 === 0 ? v * 0.4 - 2.6 : v * 0.4 - w * 0.5))).fill({ color: 0xffffff, alpha: 0.16 });
  return g;
}

function drawBush(id: string): Graphics {
  const g = new Graphics();
  const r = hashStr(id);
  dropShadow(g, TILE_SIZE * 0.36, -3);
  const s = TILE_SIZE * (0.25 + r * 0.08);
  g.circle(-s * 0.75, -s * 0.75, s).fill(V.bushDark);
  g.circle(s * 0.72, -s * 0.85, s * 0.95).fill(V.bushDark);
  g.circle(0, -s * 1.15, s * 1.12).fill(V.bush);
  g.circle(-s * 0.3, -s * 1.5, s * 0.5).fill({ color: 0xffffff, alpha: 0.14 });
  return g;
}

function drawOreRock(id: string): Graphics {
  const g = drawRock(id, V.stoneDark, 0x655f56);
  const r = hashStr(id + "ore");
  for (let i = 0; i < 3; i += 1) {
    g.circle((r - 0.5) * 8 + i * 5 - 5, -6 - i * 3, 1.8).fill(V.flint);
  }
  return g;
}

function drawShellBed(id: string): Graphics {
  const g = new Graphics();
  g.ellipse(0, -3, TILE_SIZE * 0.55, TILE_SIZE * 0.3).fill({ color: V.shell, alpha: 0.4 });
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
  g.ellipse(0, cy + 2, rx * 1.3, ry * 1.3).fill({ color: V.poolRim, alpha: 0.5 });
  g.ellipse(0, cy, rx, ry).fill(V.poolWater);
  g.ellipse(-rx * 0.26, cy - ry * 0.28, rx * 0.42, ry * 0.28)
    .fill({ color: 0xffffff, alpha: 0.35 });
  g.ellipse(0, cy, rx, ry).stroke({ width: 1.2, color: 0x2a5866, alpha: 0.5 });
  return g;
}

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

// ── structures (each kind actually drawn; bottom-centre at (0,0)) ─────────────
function flame(g: Graphics, x: number, y: number, s: number): void {
  g.moveTo(x, y).quadraticCurveTo(x - s * 0.8, y - s * 0.9, x, y - s * 1.7)
    .quadraticCurveTo(x + s * 0.8, y - s * 0.9, x, y).closePath().fill(V.flame);
  g.moveTo(x, y).quadraticCurveTo(x - s * 0.4, y - s * 0.5, x, y - s * 0.95)
    .quadraticCurveTo(x + s * 0.4, y - s * 0.5, x, y).closePath().fill(V.flameCore);
}

function logs(g: Graphics, w: number): void {
  g.roundRect(-w * 0.5, -3.5, w, 4, 2).fill(V.woodDark);
  g.roundRect(-w * 0.42, -6, w * 0.84, 4, 2).fill(V.wood);
}

function drawCampfire(lit: boolean, S: number): Graphics {
  const g = new Graphics();
  dropShadow(g, S * 0.4, -2);
  for (let i = 0; i < 7; i += 1) {                     // stone ring
    const a = (i / 7) * Math.PI * 2;
    g.circle(Math.cos(a) * S * 0.34, -3 + Math.sin(a) * S * 0.15, 2.4).fill(V.stoneDark);
  }
  logs(g, S * 0.5);
  if (lit) flame(g, 0, -5, S * 0.28);
  else g.circle(0, -6, 2.2).fill(0x555048);
  return g;
}

function drawSignalFire(lit: boolean, S: number): Graphics {
  const g = new Graphics();
  dropShadow(g, S * 0.42, -2);
  // log pyramid
  g.poly([-S * 0.34, -2, S * 0.34, -2, 0, -S * 0.5]).fill(V.woodDark);
  g.poly([-S * 0.24, -2, S * 0.24, -2, 0, -S * 0.4]).fill(V.wood);
  if (lit) flame(g, 0, -S * 0.34, S * 0.3);
  return g;
}

function drawTent(S: number): Graphics {
  const g = new Graphics();
  dropShadow(g, S * 0.5, -2);
  g.poly([-S * 0.48, 0, S * 0.48, 0, 0, -S * 0.62]).fill(V.canvasCloth);
  g.poly([S * 0.05, 0, S * 0.48, 0, 0, -S * 0.62]).fill(V.canvasDark);
  g.poly([-S * 0.13, 0, S * 0.13, 0, 0, -S * 0.34]).fill(V.trunkDark);   // entrance
  g.moveTo(0, -S * 0.62).lineTo(0, -S * 0.72).stroke({ width: 1.6, color: V.woodDark });
  return g;
}

function drawWaterStill(S: number): Graphics {
  const g = new Graphics();
  dropShadow(g, S * 0.42, -2);
  g.ellipse(0, -3, S * 0.4, S * 0.18).fill(V.poolRim);
  g.ellipse(0, -4, S * 0.33, S * 0.14).fill(V.poolWater);
  g.moveTo(-S * 0.3, -4).lineTo(0, -S * 0.5).lineTo(S * 0.3, -4)
    .stroke({ width: 1.6, color: V.woodDark });
  g.poly([-S * 0.22, -6, S * 0.22, -6, 0, -S * 0.44]).fill({ color: V.canvasCloth, alpha: 0.75 });
  return g;
}

function drawWell(S: number): Graphics {
  const g = new Graphics();
  dropShadow(g, S * 0.4, -2);
  g.roundRect(-S * 0.3, -S * 0.26, S * 0.6, S * 0.26, 3).fill(V.stoneWall)
    .stroke({ width: 1.2, color: V.stoneDark });
  g.ellipse(0, -S * 0.26, S * 0.3, S * 0.1).fill(0x27404a);
  g.moveTo(-S * 0.26, -S * 0.26).lineTo(-S * 0.2, -S * 0.6).lineTo(S * 0.2, -S * 0.6)
    .lineTo(S * 0.26, -S * 0.26).stroke({ width: 1.6, color: V.woodDark });
  g.poly([-S * 0.3, -S * 0.55, S * 0.3, -S * 0.55, 0, -S * 0.78]).fill(V.wood);
  return g;
}

function drawStore(S: number): Graphics {
  const g = new Graphics();
  dropShadow(g, S * 0.46, -2);
  const crate = (x: number, y: number, w: number) => {
    g.roundRect(x - w / 2, y - w, w, w, 2).fill(V.wood).stroke({ width: 1.2, color: V.woodDark });
    g.moveTo(x - w / 2, y - w / 2).lineTo(x + w / 2, y - w / 2).stroke({ width: 1, color: V.woodDark });
  };
  crate(-S * 0.2, 0, S * 0.34);
  crate(S * 0.18, 0, S * 0.3);
  crate(0, -S * 0.32, S * 0.3);
  g.ellipse(-S * 0.05, -S * 0.62 - 1, S * 0.16, S * 0.07).fill(V.canvasDark);
  return g;
}

function drawWorkbench(S: number): Graphics {
  const g = new Graphics();
  dropShadow(g, S * 0.42, -2);
  g.roundRect(-S * 0.4, -S * 0.34, S * 0.8, 5, 2).fill(V.wood).stroke({ width: 1, color: V.woodDark });
  g.rect(-S * 0.32, -S * 0.34 + 5, 3.4, S * 0.3).fill(V.woodDark);
  g.rect(S * 0.28, -S * 0.34 + 5, 3.4, S * 0.3).fill(V.woodDark);
  g.rect(S * 0.08, -S * 0.44, 2.4, S * 0.12).fill(V.metal);        // tool
  g.circle(-S * 0.16, -S * 0.38, 2).fill(V.metalDark);
  return g;
}

function drawSmokehouse(S: number): Graphics {
  const g = new Graphics();
  dropShadow(g, S * 0.42, -2);
  g.roundRect(-S * 0.3, -S * 0.42, S * 0.6, S * 0.42, 3).fill(V.woodDark);
  g.poly([-S * 0.36, -S * 0.42, S * 0.36, -S * 0.42, 0, -S * 0.66]).fill(V.trunkDark);
  g.circle(0, -S * 0.72, 2.6).fill({ color: 0xcccccc, alpha: 0.5 });
  g.circle(2, -S * 0.8, 3.2).fill({ color: 0xcccccc, alpha: 0.35 });
  return g;
}

function drawGarden(S: number): Graphics {
  const g = new Graphics();
  g.roundRect(-S * 0.42, -S * 0.3, S * 0.84, S * 0.3, 3).fill(0x8a6a45);
  for (let r = 0; r < 2; r += 1)
    for (let i = 0; i < 4; i += 1) {
      const x = -S * 0.3 + i * S * 0.2, y = -S * 0.22 + r * S * 0.12;
      g.circle(x, y, 2).fill(V.bush);
      g.circle(x, y - 2, 1.4).fill(V.grassLight);
    }
  return g;
}

function drawSignpost(S: number): Graphics {
  const g = new Graphics();
  g.rect(-1.4, -S * 0.7, 2.8, S * 0.7).fill(V.woodDark);
  g.roundRect(-S * 0.3, -S * 0.66, S * 0.6, S * 0.22, 2).fill(V.wood)
    .stroke({ width: 1, color: V.woodDark });
  g.moveTo(-S * 0.2, -S * 0.56).lineTo(S * 0.2, -S * 0.56).stroke({ width: 1, color: V.woodDark });
  return g;
}

function drawWatchtower(S: number): Graphics {
  const g = new Graphics();
  dropShadow(g, S * 0.4, -2);
  g.moveTo(-S * 0.3, 0).lineTo(-S * 0.16, -S * 0.62).stroke({ width: 2.4, color: V.woodDark });
  g.moveTo(S * 0.3, 0).lineTo(S * 0.16, -S * 0.62).stroke({ width: 2.4, color: V.woodDark });
  g.moveTo(-S * 0.26, -S * 0.2).lineTo(S * 0.26, -S * 0.2).stroke({ width: 1.6, color: V.wood });
  g.moveTo(-S * 0.22, -S * 0.4).lineTo(S * 0.22, -S * 0.4).stroke({ width: 1.6, color: V.wood });
  g.roundRect(-S * 0.24, -S * 0.78, S * 0.48, S * 0.18, 2).fill(V.wood)
    .stroke({ width: 1.2, color: V.woodDark });
  g.poly([-S * 0.3, -S * 0.78, S * 0.3, -S * 0.78, 0, -S * 0.95]).fill(V.canvasDark);
  return g;
}

function drawCave(S: number): Graphics {
  const g = new Graphics();
  dropShadow(g, S * 0.5, -2);
  const pts = rockPoly("cave" + S, S * 0.5);
  g.poly(pts.map((v, i) => (i % 2 ? v * 1.1 - S * 0.1 : v * 1.15))).fill(V.stoneDark);
  g.poly(pts.map((v, i) => (i % 2 ? v * 0.9 - S * 0.16 : v * 0.95))).fill(V.stone);
  g.moveTo(-S * 0.2, 0).quadraticCurveTo(0, -S * 0.42, S * 0.2, 0).closePath().fill(0x241d16);
  return g;
}

function drawHotspring(S: number): Graphics {
  const g = drawPool("hotspring", 0.55);
  for (let i = 0; i < 3; i += 1) {
    g.circle(-6 + i * 6, -S * 0.5 - i * 3, 2.4 - i * 0.4).fill({ color: 0xffffff, alpha: 0.30 - i * 0.07 });
  }
  return g;
}

function drawLighthouse(active: boolean, S: number): Graphics {
  const g = new Graphics();
  dropShadow(g, S * 0.4, -2);
  // tapered striped tower
  g.poly([-S * 0.22, 0, S * 0.22, 0, S * 0.13, -S * 0.85, -S * 0.13, -S * 0.85]).fill(0xd8d2c4);
  for (let i = 0; i < 3; i += 1) {
    const t0 = 0.14 + i * 0.24, t1 = t0 + 0.12;
    const w0 = 0.22 - 0.09 * t0, w1 = 0.22 - 0.09 * t1;
    g.poly([-S * w0, -S * 0.85 * t0, S * w0, -S * 0.85 * t0,
            S * w1, -S * 0.85 * t1, -S * w1, -S * 0.85 * t1]).fill(0xb8574e);
  }
  g.roundRect(-S * 0.15, -S * 1.02, S * 0.3, S * 0.18, 2)
    .fill(active ? V.flameCore : 0x3d4650);
  g.poly([-S * 0.18, -S * 1.02, S * 0.18, -S * 1.02, 0, -S * 1.16]).fill(V.metalDark);
  return g;
}

function drawRadioTower(S: number): Graphics {
  const g = new Graphics();
  dropShadow(g, S * 0.34, -2);
  g.moveTo(-S * 0.26, 0).lineTo(0, -S * 1.05).stroke({ width: 2, color: V.metalDark });
  g.moveTo(S * 0.26, 0).lineTo(0, -S * 1.05).stroke({ width: 2, color: V.metalDark });
  for (let i = 1; i <= 4; i += 1) {
    const t = i / 5, w = S * 0.26 * (1 - t);
    g.moveTo(-w, -S * 1.05 * t).lineTo(w, -S * 1.05 * t).stroke({ width: 1.2, color: V.metal });
  }
  g.circle(0, -S * 1.08, 2.2).fill(0xc0574f);
  return g;
}

function drawWreckPlane(S: number): Graphics {
  const g = new Graphics();
  dropShadow(g, S * 0.55, -3);
  g.ellipse(-S * 0.05, -S * 0.16, S * 0.42, S * 0.13).fill(V.metal)
    .stroke({ width: 1.4, color: V.metalDark });                     // fuselage
  g.poly([-S * 0.1, -S * 0.2, -S * 0.42, -S * 0.5, -S * 0.28, -S * 0.14]).fill(V.metalDark);  // bent wing
  g.poly([S * 0.28, -S * 0.2, S * 0.5, -S * 0.34, S * 0.34, -S * 0.1]).fill(V.metalDark);     // tail
  for (let i = 0; i < 4; i += 1) {
    g.circle(-S * 0.28 + i * S * 0.13, -S * 0.18, 1.4).fill(0x37474f);   // windows
  }
  g.circle(-S * 0.3, -S * 0.42, 3).fill({ color: 0x999999, alpha: 0.4 });  // smoke wisp
  return g;
}

function drawMonolith(S: number): Graphics {
  const g = new Graphics();
  dropShadow(g, S * 0.32, -2);
  g.poly([-S * 0.14, 0, S * 0.14, 0, S * 0.09, -S * 0.85, -S * 0.11, -S * 0.8]).fill(0x3a3f4a)
    .stroke({ width: 1.2, color: 0x262a33 });
  g.moveTo(-S * 0.04, -S * 0.2).lineTo(0, -S * 0.6).stroke({ width: 1, color: 0x7f8fb0, alpha: 0.8 });
  return g;
}

function drawIdol(S: number): Graphics {
  const g = new Graphics();
  dropShadow(g, S * 0.3, -2);
  g.roundRect(-S * 0.16, -S * 0.6, S * 0.32, S * 0.6, 3).fill(V.woodDark);
  g.circle(0, -S * 0.68, S * 0.16).fill(V.wood);
  g.circle(-S * 0.06, -S * 0.7, 1.6).fill(0x241d16);
  g.circle(S * 0.06, -S * 0.7, 1.6).fill(0x241d16);
  g.moveTo(-S * 0.1, -S * 0.6).lineTo(S * 0.1, -S * 0.6).stroke({ width: 1.2, color: 0x241d16 });
  return g;
}

function drawHatch(S: number): Graphics {
  const g = new Graphics();
  g.ellipse(0, -S * 0.12, S * 0.34, S * 0.2).fill(V.metalDark)
    .stroke({ width: 1.6, color: 0x37474f });
  g.ellipse(0, -S * 0.14, S * 0.24, S * 0.13).fill(V.metal);
  g.circle(S * 0.12, -S * 0.14, 2).fill(0xc0574f);                  // the button
  return g;
}

function drawWhisperzone(S: number): Graphics {
  const g = new Graphics();
  for (let i = 3; i >= 1; i -= 1) {
    g.ellipse(0, -S * 0.14, S * 0.16 * i, S * 0.09 * i)
      .stroke({ width: 1.4, color: 0x9a7fb8, alpha: 0.5 - i * 0.1 });
  }
  g.circle(0, -S * 0.14, 2.4).fill({ color: 0x9a7fb8, alpha: 0.8 });
  return g;
}

function drawRelic(S: number): Graphics {
  const g = new Graphics();
  dropShadow(g, S * 0.24, -1);
  g.poly([0, -S * 0.5, S * 0.14, -S * 0.3, 0, -S * 0.06, -S * 0.14, -S * 0.3]).fill(0x67e0c4)
    .stroke({ width: 1.2, color: 0x2f8f7a });
  g.poly([0, -S * 0.42, S * 0.07, -S * 0.3, 0, -S * 0.16, -S * 0.07, -S * 0.3])
    .fill({ color: 0xffffff, alpha: 0.4 });
  return g;
}

function drawScaffold(S: number, progress: number, targetColor: number): Graphics {
  const g = new Graphics();
  g.moveTo(-S * 0.34, 0).lineTo(-S * 0.34, -S * 0.4).stroke({ width: 2, color: V.woodDark });
  g.moveTo(S * 0.34, 0).lineTo(S * 0.34, -S * 0.4).stroke({ width: 2, color: V.woodDark });
  g.moveTo(-S * 0.4, -S * 0.36).lineTo(S * 0.4, -S * 0.36).stroke({ width: 1.6, color: V.wood });
  g.moveTo(-S * 0.34, 0).lineTo(S * 0.34, -S * 0.36).stroke({ width: 1.2, color: V.wood, alpha: 0.7 });
  g.roundRect(-S * 0.3, -4, S * 0.6 * Math.max(0.06, Math.min(1, progress)), 3.4, 1.6)
    .fill(targetColor);
  g.roundRect(-S * 0.3, -4, S * 0.6, 3.4, 1.6).stroke({ width: 1, color: V.woodDark });
  return g;
}

/** Draw a structure by kind. Bottom-centre of the footprint = (0,0). Returns
 * null for kinds we don't draw yet (caller falls back to a placeholder). */
export function buildVectorStructure(s: StructureState, pw: number, ph: number): Graphics | null {
  const st = s.state ?? {};
  const building = st.buildable_kind !== undefined && !st.complete;
  const S = Math.max(pw, TILE_SIZE * 1.4);
  if (building) {
    const prog = (st.progress as number ?? 0) / Math.max(1, (st as any).required ?? 40);
    return drawScaffold(S, prog, V.canvasCloth);
  }
  const lit = Boolean(st.complete) && (st.fuel as number ?? 0) > 0;
  switch (s.kind) {
    case "campfire": return drawCampfire(lit, S);
    case "signal_fire": return drawSignalFire(true, S);
    case "tent": case "lean_to": return drawTent(S);
    case "water_still": return drawWaterStill(S);
    case "well": return drawWell(S);
    case "store": case "storage_crate": case "supply_pile": return drawStore(S);
    case "workbench": return drawWorkbench(S);
    case "smokehouse": return drawSmokehouse(S);
    case "garden": return drawGarden(S);
    case "signpost": return drawSignpost(S);
    case "watchtower": return drawWatchtower(S);
    case "cave": return drawCave(S);
    case "hotspring": return drawHotspring(S);
    case "lighthouse": return drawLighthouse(Boolean(st.active), S);
    case "radiotower": return drawRadioTower(S);
    case "plane_wreckage": return drawWreckPlane(S);
    case "monolith": return drawMonolith(S);
    case "idol": return drawIdol(S);
    case "hatch": return drawHatch(S);
    case "whisperzone": return drawWhisperzone(S);
    case "relic": return drawRelic(S);
    default: return null;
  }
}

// ── meeples ───────────────────────────────────────────────────────────────────
export type Meeple = Graphics;

export function buildMeeple(agentId: string, gender?: string): Meeple {
  const hue = agentHue(agentId);
  const body = hslToRgbInt(hue, 58, 55);
  const bodyDark = hslToRgbInt(hue, 58, 40);
  const head = hslToRgbInt(hue, 32, 80);
  const g = new Graphics();
  const W = 10.5, H = 14.5;
  g.ellipse(SHADOW_DX * 0.6, 0.6, 6.2, 2.4).fill({ color: V.shadow, alpha: 0.28 });
  g.roundRect(-W / 2, -H, W, H, W / 2).fill(body).stroke({ width: 1.3, color: bodyDark });
  g.roundRect(-W / 2 + 1.6, -H + 1.6, W * 0.4, H - 4.5, W / 3).fill({ color: 0xffffff, alpha: 0.16 });
  g.circle(0, -H - 4.6, 4.8).fill(head).stroke({ width: 1.3, color: bodyDark });
  if (gender === "female") {
    g.circle(3.8, -H - 7.4, 2.2).fill(bodyDark);
  }
  return g;
}

/** Cloud-shadow blob for the diorama (drawn on canvas, no assets). */
export function makeCloudShadowCanvas(): HTMLCanvasElement {
  const size = 200;
  const cv = document.createElement("canvas");
  cv.width = size; cv.height = size / 2;
  const ctx = cv.getContext("2d")!;
  const blob = (x: number, y: number, r: number) => {
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, "rgba(14,30,24,0.42)");
    grad.addColorStop(1, "rgba(14,30,24,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };
  blob(62, 52, 48); blob(104, 42, 56); blob(148, 54, 42);
  return cv;
}
