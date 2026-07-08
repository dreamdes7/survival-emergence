// The Pixi renderer: canvas, camera, terrain, props, structures, animated agents.
// All render-internal mutable state (sprite caches, camera, animation clocks)
// stays private to this module; shared app state comes from the store.

import { Application, Assets, Container, Graphics, Rectangle, RenderTexture, Sprite, Texture, TilingSprite } from "pixi.js";
import { API_URL, OCEAN_COLOR, OCEAN_PAD, TILE_SIZE, VOID_COLOR } from "./constants";
import { requiredProgress, store } from "./store";
import { agentCssInk, agentIndex, agentTint, intentIcon } from "./utils";
import { closeModal, openAgentModal, openStructModal, pushEvent, renderChrome, stageEl, viewportTools } from "./ui";
import { controlSim } from "./api";
import { buildMeeple, buildVectorProp, buildVectorStructure, buildVectorTerrain,
         invalidateVectorTerrain, makeFogCanvas, makeGrainCanvas, makeVignetteCanvas,
         V } from "./vector";
import { agentScreen3d, audioEnv3d, invalidate3d, setActive3d, sync3d } from "./render3d";
import { audioEnabled, audioWanted, toggleAudio, updateAudioEnv } from "./audio";
import { gfx, saveGfx } from "./gfx";
import type { StructureState, WorldState } from "./types";

// Vector (procedural, asset-free) renderer is island-only for now; Mars keeps
// the tile path in both styles.
function vectorMode(): boolean {
  return store.renderStyle === "vector" && store.state?.scenario === "island";
}

// Low-poly three.js diorama (G3) — island only as well.
function mode3d(): boolean {
  return store.renderStyle === "3d" && store.state?.scenario === "island";
}

// ── pixi scene graph ──────────────────────────────────────────────────────────
export const app = new Application();
const mapRoot = new Container();
const worldLayer = new Container();                 // terrain (bottom, unsorted)
const objectLayer = new Container();                // props + structures + agents
objectLayer.sortableChildren = true;                // depth-sorted by base Y
const agentLayer = objectLayer;                     // agents live in the sorted layer
const propSprites: (Sprite | Graphics | Container)[] = [];   // rebuilt each render
const cloudLayer = new Container();                 // drifting clouds (top, atmosphere)
const cloudSprites: { sprite: Sprite; vx: number }[] = [];
const cloudTex: Texture[] = [];
let cloudsForScenario = "";
const ISLAND_CLOUD_COUNT = 14;
const nightOverlay = new Graphics();                // blue darkening at night
let nightAlpha = 0;
let glowTex: Texture | null = null;                 // additive glow for lit fires
const glowSprites: { sprite: Sprite; base: number }[] = [];
const beamSprites: { c: Container; v: number }[] = [];   // rotating lighthouse beams
let glowT = 0;
// The Lighthouse film layer (vector mode only): grain, vignette, lamp flicker.
let filmGrain: TilingSprite | null = null;
let filmVignette: Sprite | null = null;
let filmFlicker: Graphics | null = null;
let flickerAlpha = 0;
let flickerTarget = 0;
let flickerT = 0;
let grainT = 0;
let renderSeq = 0;
let fittedMapKey = "";
let isDragging = false;
let dragStart = { x: 0, y: 0 };
let cameraStart = { x: 0, y: 0 };
const camera = { x: 12, y: 12, scale: 1 };
const textureCache = new Map<string, Texture>();

export async function initPixi(): Promise<void> {
  await app.init({
    background: OCEAN_COLOR,
    backgroundAlpha: 1,
    antialias: false,
    resizeTo: stageEl,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });
  stageEl.appendChild(app.canvas);
  app.stage.addChild(mapRoot);
  nightOverlay.eventMode = "none";
  mapRoot.addChild(worldLayer, objectLayer, cloudLayer, nightOverlay);
  app.ticker.add(animateAgents);
  app.ticker.add(updateOverlay);
  app.ticker.add(animateFoam);
  app.ticker.add(animateBushes);
  app.ticker.add(animateClouds);
  app.ticker.add(animateNight);
  app.ticker.add(animateGlow);
  app.ticker.add(animateFilm);
  app.ticker.add(animateAudio);
  glowTex = makeGlowTexture();

  // Screen-space film layer above the world (visible only in vector mode).
  filmGrain = new TilingSprite({ texture: Texture.from(makeGrainCanvas()),
    width: stageEl.clientWidth || 800, height: stageEl.clientHeight || 600 });
  filmGrain.blendMode = "multiply";
  filmGrain.alpha = 0.42;
  filmVignette = new Sprite(Texture.from(makeVignetteCanvas()));
  filmVignette.blendMode = "multiply";
  filmFlicker = new Graphics();
  for (const o of [filmGrain, filmVignette, filmFlicker]) {
    o.eventMode = "none";
    o.visible = false;
    app.stage.addChild(o);
  }
  sizeFilmLayer();

  bindViewportControls();
  new ResizeObserver(() => {
    fitCamera(true);
    sizeFilmLayer();
    void render();
  }).observe(stageEl);
}

function sizeFilmLayer(): void {
  const w = Math.max(1, stageEl.clientWidth), h = Math.max(1, stageEl.clientHeight);
  if (filmGrain) { filmGrain.width = w; filmGrain.height = h; }
  if (filmVignette) { filmVignette.width = w; filmVignette.height = h; }
  filmFlicker?.clear().rect(0, 0, w, h).fill(0x000000);
  if (filmFlicker) filmFlicker.alpha = 0;
}

// Live grain jitter + the uneasy lantern flicker of the whole frame.
function animateFilm(): void {
  const on = vectorMode();
  if (filmGrain) filmGrain.visible = on;
  if (filmVignette) filmVignette.visible = on;
  if (filmFlicker) filmFlicker.visible = on;
  if (!on) return;
  const dt = app.ticker.deltaMS / 1000;
  grainT += dt;
  if (grainT > 0.09 && filmGrain) {
    grainT = 0;
    filmGrain.tilePosition.set(Math.floor(Math.random() * 96), Math.floor(Math.random() * 96));
  }
  flickerT += dt;
  if (flickerT > 0.14) {
    flickerT = 0;
    flickerTarget = Math.random() < 0.82 ? Math.random() * 0.02 : 0.03 + Math.random() * 0.035;
  }
  flickerAlpha += (flickerTarget - flickerAlpha) * Math.min(1, dt * 14);
  if (filmFlicker) filmFlicker.alpha = flickerAlpha * (0.6 + nightAlpha);
}

// Drive the procedural ambience from the live scene. In 3D we read the real
// continuous night/storm/fire from the renderer; otherwise we fall back to the
// snapshot's discrete flags so sound still tracks the world in 2D modes.
function animateAudio(): void {
  const dt = app.ticker.deltaMS / 1000;
  const st = store.state;
  let night = 0, storm = 0, fire = 0;
  const e3 = mode3d() ? audioEnv3d() : null;
  if (e3) {
    night = e3.night; storm = e3.storm; fire = e3.fire;
  } else if (st) {
    night = st.is_night ? 1 : 0;
    storm = st.weather === "storm" ? 1 : 0;
    fire = st.structures.some((s) =>
      (s.kind === "campfire" || s.kind === "signal_fire")
      && (Number(s.state?.fuel ?? 0) > 0 || s.state?.active === true)) ? 1 : 0;
  }
  updateAudioEnv({ night, storm, fire, day: 1 - night }, dt);
}

// New-world housekeeping, extracted from applyState: when the map identity
// changes, refit the camera and rebuild world-scoped visuals.
export function handleWorldChange(next: WorldState): void {
  const mapKey = `${next.scenario}:${next.map.size}`;
  if (mapKey === fittedMapKey) return;
  fittedMapKey = mapKey;
  fitCamera(true);
  // New world: drop persistent agent sprites so they respawn in place
  // instead of gliding across the map from their old tiles.
  for (const vis of agentVis.values()) vis.container.destroy({ children: true });
  agentVis.clear();
  for (const id of [...agentDom.keys()]) removeAgentDom(id);
  cloudsForScenario = "";          // rebuild clouds for the new world
  terrainDirty = true;             // re-bake land for the new world
  invalidateVectorTerrain();
  invalidate3d();
  void setupClouds();
  sizeNight();
  app.renderer.background.color = next.scenario === "island" ? OCEAN_COLOR : VOID_COLOR;
}

// Sim-tab switch: reset per-sim visuals so the next applyState rebuilds cleanly.
export function resetForSimSwitch(): void {
  for (const vis of agentVis.values()) vis.container.destroy({ children: true });
  agentVis.clear();
  for (const id of [...agentDom.keys()]) removeAgentDom(id);
  fittedMapKey = "";
  cloudsForScenario = "";
  invalidateVectorTerrain();
  invalidate3d();
}

// Style toggle (🎨): cycle 3d -> vector -> tiles. Agent visuals rebuild.
function toggleRenderStyle(): void {
  store.renderStyle = store.renderStyle === "3d" ? "vector"
    : store.renderStyle === "vector" ? "tiles" : "3d";
  localStorage.setItem("renderStyle", store.renderStyle);
  for (const vis of agentVis.values()) vis.container.destroy({ children: true });
  agentVis.clear();
  cloudsForScenario = "";
  void setupClouds();
  void render();
  const label = store.renderStyle === "3d" ? "3D диорама"
    : store.renderStyle === "vector" ? "вектор (2D)" : "тайлы";
  pushEvent(`render: ${label}`);
}

function bindViewportControls() {
  viewportTools.addEventListener("click", async (event) => {
    // clicks may land on an inner <svg>/<path>, so resolve the owning button
    const target = (event.target as HTMLElement).closest("button") as HTMLButtonElement | null;
    if (!target) return;
    const action = target.dataset.zoom;
    if (action === "in") zoomAt(1.2, stageEl.clientWidth / 2, stageEl.clientHeight / 2);
    if (action === "out") zoomAt(1 / 1.2, stageEl.clientWidth / 2, stageEl.clientHeight / 2);
    if (action === "reset") fitCamera(true);
    if (target.id === "style-btn") toggleRenderStyle();
    if (target.id === "audio-btn") {
      const on = toggleAudio();
      target.classList.toggle("on", on);
      pushEvent(on ? "звук: эмбиент включён" : "звук выключен");
    }
    if (target.id === "cine-btn") {
      const on = !target.classList.contains("on");
      target.classList.toggle("on", on);
      document.getElementById("app")?.classList.toggle("cinematic", on);
      gfx.letterbox = on;
      saveGfx();
    }
    if (target.dataset.control === "pause") {
      const next = !store.simPaused;
      try {
        const data = await controlSim(store.activeSimId, next ? "pause" : "resume");
        store.simPaused = data.paused;
        target.classList.toggle("paused", store.simPaused);
        pushEvent(store.simPaused ? "paused — model calls stopped" : "resumed");
      } catch {
        pushEvent("pause/resume failed");
      }
    }
  });

  // Reflect a persisted cinematic choice on load.
  if (gfx.letterbox) {
    document.getElementById("cine-btn")?.classList.add("on");
    document.getElementById("app")?.classList.add("cinematic");
  }

  // Restore a previously-enabled soundscape on the first world interaction
  // (autoplay policy forbids starting audio without a user gesture). Bound to
  // the canvas only, so it never races the explicit audio-button toggle.
  if (audioWanted()) {
    app.canvas.addEventListener("pointerdown", () => {
      if (audioEnabled()) return;
      const on = toggleAudio();
      document.querySelector<HTMLButtonElement>("#audio-btn")?.classList.toggle("on", on);
    }, { once: true });
  }

  app.canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoomAt(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.offsetX, event.offsetY);
  }, { passive: false });

  app.canvas.addEventListener("pointerdown", (event) => {
    isDragging = true;
    dragStart = { x: event.clientX, y: event.clientY };
    cameraStart = { x: camera.x, y: camera.y };
    app.canvas.setPointerCapture(event.pointerId);
  });
  app.canvas.addEventListener("pointermove", (event) => {
    if (!isDragging) return;
    camera.x = cameraStart.x + event.clientX - dragStart.x;
    camera.y = cameraStart.y + event.clientY - dragStart.y;
    updateCamera();
  });
  app.canvas.addEventListener("pointerup", (event) => {
    isDragging = false;
    app.canvas.releasePointerCapture(event.pointerId);
  });
  app.canvas.addEventListener("pointercancel", () => {
    isDragging = false;
  });
}

export function fitCamera(force = false) {
  const state = store.state;
  if (!state || (!force && fittedMapKey)) return;
  const mapPixels = state.map.size * TILE_SIZE;
  const viewW = Math.max(1, stageEl.clientWidth);
  const viewH = Math.max(1, stageEl.clientHeight);
  camera.scale = Math.max(0.55, Math.min((viewW - 24) / mapPixels, (viewH - 24) / mapPixels));
  camera.x = Math.max(12, (viewW - mapPixels * camera.scale) / 2);
  camera.y = 12;
  updateCamera();
}

function zoomAt(factor: number, screenX: number, screenY: number) {
  const nextScale = Math.max(0.45, Math.min(4, camera.scale * factor));
  const worldX = (screenX - camera.x) / camera.scale;
  const worldY = (screenY - camera.y) / camera.scale;
  camera.x = screenX - worldX * nextScale;
  camera.y = screenY - worldY * nextScale;
  camera.scale = nextScale;
  updateCamera();
}

function updateCamera() {
  mapRoot.scale.set(camera.scale);
  mapRoot.position.set(Math.round(camera.x), Math.round(camera.y));
}

// ── texture loading ───────────────────────────────────────────────────────────
const ASSET_VERSION = "5";   // bump to force browsers to refetch updated sprites

async function texture(path: string): Promise<Texture> {
  const url = `${API_URL}/assets/atlas/${path}?v=${ASSET_VERSION}`;
  const cached = textureCache.get(url);
  if (cached) return cached;
  const loaded = await Assets.load<Texture>(url);
  loaded.source.scaleMode = "nearest";
  textureCache.set(url, loaded);
  return loaded;
}

async function maybeTexture(path: string): Promise<Texture | null> {
  try {
    return await texture(path);
  } catch {
    pushEvent(`asset missing: ${path}`);
    return null;
  }
}

// Tiny Swords assets served by Vite from web/public/tiny/.
async function tinyTexture(name: string): Promise<Texture | null> {
  const url = `/tiny/${name}?v=${ASSET_VERSION}`;
  const cached = textureCache.get(url);
  if (cached) return cached;
  try {
    const loaded = await Assets.load<Texture>(url);
    loaded.source.scaleMode = "nearest";
    textureCache.set(url, loaded);
    return loaded;
  } catch {
    return null;
  }
}

// Low-poly structure cutouts served by Vite from web/public/vector-structures/.
async function vectorStructureTexture(name: string): Promise<Texture | null> {
  const url = `/vector-structures/${name}?v=${ASSET_VERSION}`;
  const cached = textureCache.get(url);
  if (cached) return cached;
  try {
    const loaded = await Assets.load<Texture>(url);
    textureCache.set(url, loaded);
    return loaded;
  } catch {
    return null;
  }
}

// Nature prop cutouts (palms, boulders, bushes…) from web/public/vector-props/.
async function vectorPropTexture(name: string): Promise<Texture | null> {
  const url = `/vector-props/${name}?v=${ASSET_VERSION}`;
  const cached = textureCache.get(url);
  if (cached) return cached;
  try {
    const loaded = await Assets.load<Texture>(url);
    textureCache.set(url, loaded);
    return loaded;
  } catch {
    return null;
  }
}

// Sprite spec for a resource node in the noir vector world. `size` = height in
// tiles; `flip` mirrors by id hash for variety (palms have real L/R variants).
type PropSpec = { file: string; size: number; anchorY: number; flip: boolean; shadowW: number };
const PALM_FILES = ["palm_tree_left.png", "palm_tree_bent.png", "palm_tree_right.png"];

function vectorPropSpec(kind: string, id: string): PropSpec | null {
  const r = hashStr(id);
  if (kind === "wood" || kind === "fruit_tree") {
    return { file: PALM_FILES[Math.floor(r * PALM_FILES.length) % PALM_FILES.length],
             size: 1.9 + r * 0.5, anchorY: 0.97, flip: false, shadowW: 0.52 };
  }
  if (kind === "rocks") {
    return { file: "boulder.png", size: 0.85 + r * 0.3, anchorY: 0.93,
             flip: r > 0.5, shadowW: 0.46 };
  }
  if (kind === "thicket") {
    return r < 0.55
      ? { file: "tall_grass_clump.png", size: 0.8 + r * 0.25, anchorY: 0.92,
          flip: r > 0.75, shadowW: 0.3 }
      : { file: "spiky_bush.png", size: 0.85 + r * 0.25, anchorY: 0.9,
          flip: r > 0.8, shadowW: 0.38 };
  }
  if (kind === "spring") {
    return { file: "spring_waterfall.png", size: 1.45, anchorY: 0.9,
             flip: r > 0.5, shadowW: 0.5 };
  }
  return null;   // fishing / shell_bed / orerock keep their own path
}

async function silentTexture(path: string): Promise<Texture | null> {
  try {
    return await texture(path);
  } catch {
    return null;
  }
}

// ── animated agents ───────────────────────────────────────────────────────────
type Dir = "down" | "up" | "left" | "right";

type AgentVis = {
  container: Container;
  sprite: Sprite;
  meeple?: Graphics;          // vector mode: the code-drawn survivor (no sprite)
  ring: Graphics;
  px: number; py: number;     // current pixel position (container)
  sx: number; sy: number;     // start pixel of current move
  tx: number; ty: number;     // target pixel position
  lx: number; ly: number;     // last known tile
  dir: Dir;
  moving: boolean;
  moveElapsed: number;        // seconds into current move
  moveDur: number;            // seconds for the current move (scales with distance)
  isPawn: boolean;            // island = Tiny Swords pawn (side view, flip L/R)
  pawnColor: string;
  frame: number;
  frameT: number;             // seconds accumulator for frame cycling
  status: string;
};

const SPRITE_PX = 32;
const AGENT_OFFX = (TILE_SIZE - SPRITE_PX) / 2;   // center 32px sprite on tile
const AGENT_OFFY = -14;                            // lift so feet sit on the tile
const MOVE_DURATION = 0.6;                          // seconds to cross one tile
const FRAME_INTERVAL = 0.12;                        // seconds per walk frame
const STEP_BOB = 2.2;                               // px vertical bob while walking

const agentVis = new Map<string, AgentVis>();
const agentTex = new Map<string, Texture>();        // sync texture lookup for ticker
let loadedAgentPrefix = "";

function agentPrefix(): string {
  return store.state?.scenario === "island" ? "castaway" : "suit";
}

function tilePx(tile: number, off: number): number {
  return tile * TILE_SIZE + off;
}

function dirFromDelta(dx: number, dy: number, fallback: Dir): Dir {
  if (dx === 0 && dy === 0) return fallback;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

async function ensureAgentTextures(prefix: string): Promise<void> {
  if (loadedAgentPrefix === prefix) return;
  const dirs: Dir[] = ["down", "up", "left", "right"];
  const keys: string[] = [];
  for (const d of dirs) for (let f = 0; f < 3; f += 1) keys.push(`${prefix}_walk_${d}_${f}`);
  keys.push(`${prefix}_downed`, `${prefix}_sleeping`);
  for (const key of keys) {
    const t = await maybeTexture(`agents/${key}.png`);
    if (t) agentTex.set(key, t);
  }
  loadedAgentPrefix = prefix;
}

function agentTexture(prefix: string, vis: AgentVis): Texture | undefined {
  if (vis.status === "dead" || vis.status === "incapacitated") {
    return agentTex.get(`${prefix}_downed`);
  }
  const frame = vis.moving ? vis.frame % 3 : 0;   // frame 0 = standing pose
  return agentTex.get(`${prefix}_walk_${vis.dir}_${frame}`);
}

function syncAgents(): void {
  const state = store.state;
  if (!state) return;
  const prefix = agentPrefix();
  const seen = new Set<string>();

  // Group agents sharing a tile so we can fan them out (otherwise they stack
  // on the exact same pixel and become invisible / their bubbles overlap).
  const occupancy = new Map<string, string[]>();
  for (const a of state.agents) {
    const key = `${a.x},${a.y}`;
    const arr = occupancy.get(key) ?? [];
    arr.push(a.id);
    occupancy.set(key, arr);
  }

  for (const a of state.agents) {
    seen.add(a.id);
    // fan-out offset for co-located agents (stable ring by index in the group)
    const group = occupancy.get(`${a.x},${a.y}`)!;
    let ox = 0, oy = 0;
    if (group.length > 1) {
      const idx = group.indexOf(a.id);
      const ang = (idx / group.length) * Math.PI * 2;
      const r = 4 + group.length * 1.5;
      ox = Math.cos(ang) * r;
      oy = Math.sin(ang) * r;
    }
    const px = tilePx(a.x, AGENT_OFFX) + ox;
    const py = tilePx(a.y, AGENT_OFFY) + oy;
    let vis = agentVis.get(a.id);

    if (!vis) {
      const island = state.scenario === "island";
      const pawnColor = pawnColorFor(a.id);
      const container = new Container();
      // Soft contact shadow at the feet — grounds the figure on the grass.
      const footY = island ? TILE_SIZE - AGENT_OFFY - 1 : SPRITE_PX - 3;
      const footX = island ? TILE_SIZE / 2 - AGENT_OFFX : SPRITE_PX / 2;
      const shadow = new Graphics().ellipse(0, 0, 8.5, 3).fill({ color: 0x10240f, alpha: 0.28 });
      shadow.x = footX; shadow.y = footY;
      const ring = new Graphics().roundRect(1, 3, SPRITE_PX - 2, SPRITE_PX - 4, 5)
        .stroke({ width: 2, color: 0x2bd1c4 });
      ring.visible = false;
      const sprite = new Sprite(Texture.EMPTY);
      let meeple: Graphics | undefined;
      if (vectorMode()) {
        // Code-drawn survivor: capsule + head in the agent's colour.
        meeple = buildMeeple(a.id, a.gender);
        meeple.x = TILE_SIZE / 2 - AGENT_OFFX;
        meeple.y = TILE_SIZE - AGENT_OFFY;         // feet on the tile bottom
        sprite.visible = false;
        shadow.visible = false;                    // the meeple draws its own
      } else if (island) {
        const set = pawnCache[pawnColor];
        sprite.texture = set ? set.idle[0] : Texture.EMPTY;
        sprite.anchor.set(0.5, 0.92);
        sprite.scale.set(PAWN_PX / PAWN_FRAME);
        sprite.x = TILE_SIZE / 2 - AGENT_OFFX;     // centre on the tile
        sprite.y = TILE_SIZE - AGENT_OFFY;         // feet near the tile bottom
      } else {
        sprite.texture = agentTex.get(`${prefix}_walk_down_0`) ?? Texture.EMPTY;
        sprite.width = SPRITE_PX;
        sprite.height = SPRITE_PX;
        sprite.tint = agentTint(a.id);             // distinct colour per agent
      }
      let lastTapId = "";
      let lastTapT = 0;
      const onTap = () => {
        const now = Date.now();
        const dbl = now - lastTapT < 280 && lastTapId === a.id;
        lastTapT = now; lastTapId = a.id;
        store.selectedAgentId = a.id;
        store.selectedStructureId = null;
        if (dbl) { openAgentModal(a.id); return; }
        renderChrome();
        syncAgents();
      };
      for (const target of [sprite, meeple].filter(Boolean) as (Sprite | Graphics)[]) {
        target.eventMode = "static";
        target.cursor = "pointer";
        target.on("pointertap", onTap);
      }
      container.addChild(shadow, ring, sprite);
      if (meeple) container.addChild(meeple);
      container.x = px;
      container.y = py;
      agentLayer.addChild(container);
      vis = {
        container, sprite, meeple, ring,
        px, py, sx: px, sy: py, tx: px, ty: py,
        lx: a.x, ly: a.y, dir: "down", moving: false, moveElapsed: 0, moveDur: MOVE_DURATION,
        frame: 0, frameT: 0, status: a.status, isPawn: island && !meeple, pawnColor,
      };
      agentVis.set(a.id, vis);
    } else if (a.x !== vis.lx || a.y !== vis.ly) {
      // New tile -> start a walk tween toward it (duration scales with distance).
      const tiles = Math.max(Math.abs(a.x - vis.lx), Math.abs(a.y - vis.ly));
      vis.dir = dirFromDelta(a.x - vis.lx, a.y - vis.ly, vis.dir);
      vis.sx = vis.px; vis.sy = vis.py;
      vis.tx = px; vis.ty = py;
      vis.moving = true;
      vis.moveElapsed = 0;
      vis.moveDur = Math.min(1.5, MOVE_DURATION * tiles);
      vis.lx = a.x; vis.ly = a.y;
    } else {
      vis.tx = px; vis.ty = py;   // keep target in sync (e.g. after camera/fit)
    }

    vis.status = a.status;
    vis.ring.visible = a.id === store.selectedAgentId;
    vis.sprite.alpha = a.status === "dead" ? 0.5 : 1;
    if (vis.meeple) {
      // Meeple death pose: lie down, fade; incapacitated: slump halfway.
      const down = a.status === "dead" || a.status === "incapacitated";
      vis.meeple.rotation = a.status === "dead" ? -Math.PI / 2
        : a.status === "incapacitated" ? -Math.PI / 4 : 0;
      vis.meeple.alpha = a.status === "dead" ? 0.55 : down ? 0.8 : 1;
    }
    if (a.status === "dead" || a.status === "incapacitated") {
      vis.moving = false;
    }

    // Name + speech bubble are HTML overlay elements (crisp, zoom-independent).
    const dom = ensureAgentDom(a.id, a.name);
    const icon = intentIcon(a.status, a.action);
    if (icon !== dom.lastIntent) { dom.lastIntent = icon; dom.intentEl.textContent = icon; }
    if (a.status === "dead") dom.wrap.classList.add("dead");
    else dom.wrap.classList.remove("dead");
    if (a.said && a.said !== dom.lastSaid) {
      dom.lastSaid = a.said;
      dom.bubbleEl.textContent = a.said;
      dom.bubbleEl.classList.add("show");
      dom.ttl = bubbleTtl(a.said);
    }
  }

  for (const [id, vis] of agentVis) {
    if (!seen.has(id)) {
      vis.container.destroy({ children: true });
      agentVis.delete(id);
      removeAgentDom(id);
    }
  }
}

// ── HTML overlay: agent names + speech bubbles (crisp, zoom-independent) ───────
const overlayEl = document.querySelector<HTMLDivElement>("#overlay")!;
const cineboxEl = document.querySelector<HTMLDivElement>("#cinebox")!;
type AgentDom = { wrap: HTMLDivElement; nameEl: HTMLDivElement; bubbleEl: HTMLDivElement; intentEl: HTMLDivElement; ttl: number; lastSaid: string; lastIntent: string };
const agentDom = new Map<string, AgentDom>();

// Speech bubbles linger by reading time, not a flat 4-6s — a longer line stays
// up long enough to actually read (~7s floor, ~18s ceiling).
function bubbleTtl(said: string): number {
  return Math.min(18, Math.max(7, 5 + said.length * 0.11));
}

function ensureAgentDom(id: string, name: string): AgentDom {
  let d = agentDom.get(id);
  if (!d) {
    const wrap = document.createElement("div");
    wrap.className = "agent-ov";
    const bubbleEl = document.createElement("div");
    bubbleEl.className = "agent-bubble";
    const intentEl = document.createElement("div");
    intentEl.className = "agent-intent";
    const nameEl = document.createElement("div");
    nameEl.className = "agent-name";
    // the agent's colour is now a small accent DOT (via --tint), not a loud fill
    wrap.style.setProperty("--tint", agentCssInk(id));
    wrap.append(bubbleEl, intentEl, nameEl);
    overlayEl.appendChild(wrap);
    d = { wrap, nameEl, bubbleEl, intentEl, ttl: 0, lastSaid: "", lastIntent: "" };
    agentDom.set(id, d);
  }
  d.nameEl.textContent = name;
  return d;
}

function removeAgentDom(id: string): void {
  const d = agentDom.get(id);
  if (d) { d.wrap.remove(); agentDom.delete(id); }
}

// Names/bubbles without Pixi sprites — used by the 3D mode, where three.js owns
// the world but the crisp HTML overlay stays exactly the same.
function syncAgentDom(state: WorldState): void {
  const seen = new Set<string>();
  for (const a of state.agents) {
    seen.add(a.id);
    const dom = ensureAgentDom(a.id, a.name);
    const icon = intentIcon(a.status, a.action);
    if (icon !== dom.lastIntent) { dom.lastIntent = icon; dom.intentEl.textContent = icon; }
    if (a.status === "dead") dom.wrap.classList.add("dead");
    else dom.wrap.classList.remove("dead");
    if (a.said && a.said !== dom.lastSaid) {
      dom.lastSaid = a.said;
      dom.bubbleEl.textContent = a.said;
      dom.bubbleEl.classList.add("show");
      dom.ttl = bubbleTtl(a.said);
    }
  }
  for (const id of [...agentDom.keys()]) {
    if (!seen.has(id)) removeAgentDom(id);
  }
}

// Position each agent's name + bubble just above its head, in screen space.
// In 3D, labels then push each other apart vertically (front-most keeps its
// anchor) so overlapping speech bubbles stay readable when agents cluster.
function updateOverlay(): void {
  const dt = app.ticker.deltaMS / 1000;
  const in3d = mode3d();
  // cinematic optics: letterbox whenever enabled in 3D, viewfinder while a
  // survivor is being followed
  const following3d = in3d && !!store.selectedAgentId;
  cineboxEl.classList.toggle("show-lb", gfx.letterbox && in3d);
  cineboxEl.classList.toggle("show-vf", gfx.viewfinder && following3d);
  const sc = camera.scale;
  const items: { id: string; d: AgentDom; x: number; y: number }[] = [];
  for (const [id, d] of agentDom) {
    if (d.ttl > 0) {
      d.ttl -= dt;
      if (d.ttl <= 0) d.bubbleEl.classList.remove("show");
    }
    if (in3d) {
      const p = agentScreen3d(id);
      if (!p) { d.wrap.style.transform = "translate(-9999px, -9999px)"; continue; }
      items.push({ id, d, x: p.x, y: p.y });
      continue;
    }
    const vis = agentVis.get(id);
    if (!vis) continue;
    const sx = mapRoot.position.x + (vis.px + 16) * sc;
    const sy = mapRoot.position.y + (vis.py + (vis.isPawn ? -14 : -2)) * sc;
    d.wrap.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -100%)`;
  }
  if (!items.length) return;
  // Every label stays GLUED to its own agent — no climbing. Depth order: the
  // agent nearest the camera (largest y) draws on top and always stays crisp;
  // a label a nearer one covers is gently DIMMED (never moved), so you can still
  // read the front and always know which name belongs to which survivor. The
  // selected agent and anyone currently speaking never dim.
  items.sort((a, b) => b.y - a.y);
  const sel = store.selectedAgentId;
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  let z = items.length + 10;
  for (const it of items) {
    const w = it.d.wrap.offsetWidth || 60;
    const h = it.d.wrap.offsetHeight || 22;
    const covered = placed.some((r) =>
      Math.abs(it.x - r.x) < (w + r.w) / 2 - 6
      && Math.abs(it.y - r.y) < (h + r.h) / 2 - 2);
    const keepBright = it.id === sel || it.d.ttl > 0;
    it.d.wrap.classList.toggle("occluded", covered && !keepBright);
    it.d.wrap.style.zIndex = String(keepBright ? 999 : z);
    z -= 1;
    it.d.wrap.style.transform = `translate(${it.x}px, ${it.y}px) translate(-50%, -100%)`;
    placed.push({ x: it.x, y: it.y, w, h });
  }
}

function animateAgents(): void {
  const dt = app.ticker.deltaMS / 1000;
  const prefix = loadedAgentPrefix || agentPrefix();
  for (const vis of agentVis.values()) {
    let bob = 0;
    if (vis.moving) {
      vis.moveElapsed += dt;
      const p = Math.min(1, vis.moveElapsed / vis.moveDur);
      vis.px = vis.sx + (vis.tx - vis.sx) * p;
      vis.py = vis.sy + (vis.ty - vis.sy) * p;
      bob = -Math.abs(Math.sin(p * Math.PI * 2)) * STEP_BOB;   // two little hops per tile
      if (p >= 1) vis.moving = false;
    } else {
      vis.px = vis.tx; vis.py = vis.ty;
    }
    // Advance the animation frame (astronaut idle ignores it at lookup time).
    const interval = vis.isPawn ? (vis.moving ? 0.09 : 0.16) : FRAME_INTERVAL;
    vis.frameT += dt;
    if (vis.frameT >= interval) { vis.frame += 1; vis.frameT = 0; }

    vis.container.x = vis.px;
    vis.container.y = vis.py + (vis.isPawn ? 0 : bob);   // pawns animate their own run cycle
    vis.container.zIndex = vis.py + 38;                  // depth-sort by the agent's feet

    if (vis.meeple) {
      // Meeple: flip to face left, tiny walk lean; no textures involved.
      vis.meeple.scale.x = vis.dir === "left" ? -1 : 1;
      if (vis.status === "active") {
        vis.meeple.rotation = vis.moving
          ? Math.sin(vis.frame * 1.3) * 0.06 : 0;   // subtle waddle while walking
      }
    } else if (vis.isPawn) {
      const set = pawnCache[vis.pawnColor];
      if (set) {
        const frames = vis.moving ? set.run : set.idle;
        const tex = frames[vis.frame % frames.length];
        if (vis.sprite.texture !== tex) vis.sprite.texture = tex;
      }
      const s = PAWN_PX / PAWN_FRAME;
      vis.sprite.scale.x = vis.dir === "left" ? -s : s;   // flip to face left
      vis.sprite.scale.y = s;
    } else {
      const tex = agentTexture(prefix, vis);
      if (tex && vis.sprite.texture !== tex) vis.sprite.texture = tex;
    }
  }
}

// ── structures ────────────────────────────────────────────────────────────────
// Render scale for structure sprites (small props shouldn't fill their footprint).
const STRUCT_RENDER_SCALE: Record<string, number> = {
  campfire: 1.3, signal_fire: 0.85, tent: 0.9, lean_to: 0.9,
  water_still: 0.85, store: 0.85,
  workbench: 0.9, smokehouse: 0.95, garden: 0.95, well: 0.9, signpost: 1.1, watchtower: 1.0,
  hotspring: 0.95, cave: 1.0, lighthouse: 1.0, lighthouse_lit: 1.0, radiotower: 1.0,
  monolith: 0.95, idol: 0.95, hatch: 0.9, whisperzone: 1.0, relic: 1.0,
};

const STRUCT_SHADOW_LIFT: Record<string, number> = {
  plane_wreckage: TILE_SIZE * 0.63,
  shuttle_wreckage: TILE_SIZE * 0.45,
};

// State-aware sprite candidates for a structure (most specific first); the first
// one that exists is used, otherwise a themed placeholder is drawn.
function structureSpriteCandidates(s: StructureState): string[] {
  const sc = store.state?.scenario ?? "mars";
  const st = s.state || {};
  const building = st.buildable_kind !== undefined && !st.complete;
  const out: string[] = [];
  if (s.kind === "campfire") {
    if (building) out.push(`${sc}_campfire_unlit.png`);
    else if ((st.fuel as number ?? 0) > 0) out.push(`${sc}_campfire_lit.png`);
    else out.push(`${sc}_campfire_unlit.png`);
    out.push(`${sc}_campfire_lit.png`, `${sc}_campfire_unlit.png`);
  } else if (s.kind === "tent" || s.kind === "lean_to") {
    if (building) out.push(`${sc}_tent_frame.png`);
    out.push(`${sc}_tent.png`);                    // reuse the new tent for old lean-to
  } else if (s.kind === "signal_fire") {
    out.push(`${sc}_campfire_lit.png`);            // reuse the new bonfire for the signal fire
  } else if (s.kind === "lighthouse") {
    if (st.active) out.push(`${sc}_lighthouse_lit.png`);
    out.push(`${sc}_lighthouse.png`);              // dark/abandoned by default
  }
  if (building) out.push(`${sc}_scaffold.png`);   // generic under-construction
  out.push(`${sc}_${s.kind}.png`);
  return out;
}

function vectorStructureSpriteCandidates(s: StructureState): string[] {
  const st = s.state || {};
  const building = st.buildable_kind !== undefined && !st.complete;
  const out: string[] = [];
  if (s.kind === "campfire") {
    if (building) out.push("campfire_unlit.png");
    else out.push((st.fuel as number ?? 0) > 0 ? "campfire_lit.png" : "campfire_unlit.png");
  } else if (s.kind === "signal_fire") out.push("campfire_lit.png");
  else if (s.kind === "cave") out.push("cave_entrance.png");
  else if (s.kind === "garden") out.push("garden_plot.png");
  else if (s.kind === "hatch") out.push("sealed_hatch.png");
  else if (s.kind === "hotspring") out.push("hot_spring.png");
  else if (s.kind === "idol") out.push("idol_totem.png");
  else if (s.kind === "lighthouse") out.push(st.active ? "lighthouse_lit.png" : "lighthouse_unlit.png");
  else if (s.kind === "monolith" || s.kind === "whisperzone") out.push("stone_obelisk.png");
  else if (s.kind === "plane_wreckage") out.push("plane_wreckage.png");
  else if (s.kind === "radiotower") out.push("radio_tower.png");
  else if (s.kind === "raft") out.push("raft.png");
  else if (s.kind === "relic") out.push("ancient_tablet.png");
  else if (s.kind === "signpost") out.push("signpost.png");
  else if (s.kind === "watchtower") out.push("watchtower.png");
  else if (s.kind === "well" || s.kind === "water_still") out.push("water_well.png");
  return out;
}

// Role-based palette so asset-less structures read as themselves, not as one
// dark blob (the vector renderer leans on these until G2 draws each kind).
const PLACEHOLDER_ROLE_COLOR: Record<string, number> = {
  shelter: 0xc4a165, campfire: 0xe2641f, water: 0x4fa3b5, hotspring: 0x5db8c9,
  store: 0xa5824f, salvage: 0x8a8f98, beacon: 0xd8cfae, signal: 0xc0574f,
  escape: 0xd08a4e, workbench: 0x9b7a53, smokehouse: 0x8f6e4e, garden: 0x7fae56,
  lookout: 0xb0946a, signpost: 0xcbb98a, refill_oxygen: 0x7fd0d8, hazard: 0xb0483f,
};

// Themed placeholder for a structure with no sprite yet (works before art lands).
function structurePlaceholder(s: StructureState, px: number, py: number, pw: number, ph: number): Graphics {
  const st = s.state || {};
  const building = st.buildable_kind !== undefined && !st.complete;
  let color = PLACEHOLDER_ROLE_COLOR[s.role] ?? 0x9a8f7a;
  if (s.kind === "campfire") color = building ? 0x6b5230 : ((st.fuel as number ?? 0) > 0 ? 0xe2641f : 0x555048);
  else if (s.kind === "tent") color = building ? 0x7a6a3a : 0xb89a5a;
  const g = new Graphics().roundRect(px + 2, py + 2, pw - 4, ph - 4, Math.min(8, pw * 0.18))
    .fill({ color, alpha: building ? 0.55 : 0.92 })
    .stroke({ width: 1.5, color: 0x3a3128, alpha: 0.6 });
  if (building) {
    const req = requiredProgress((st.buildable_kind as string) ?? s.kind);
    const p = Math.min(1, (st.progress as number ?? 0) / req);
    g.rect(px + 3, py + ph - 7, (pw - 6) * p, 4).fill(0xffe08a);
  }
  return g;
}

function itemSpriteName(item: string): string {
  const map: Record<string, string> = {
    food: "item_ration.png",
    water: "item_water.png",
    wood: "item_wood.png",
    ore: "item_ore.png",
  };
  return map[item] ?? "item_crate.png";
}

// ── Tiny Swords pawns (island survivors) ──────────────────────────────────────
type PawnSet = { idle: Texture[]; run: Texture[] };
const PAWN_COLORS = ["blue", "red", "purple", "yellow", "black"];
const PAWN_FRAME = 192;
const PAWN_PX = 56;
const pawnCache: Record<string, PawnSet> = {};

async function loadPawn(color: string): Promise<PawnSet | null> {
  if (pawnCache[color]) return pawnCache[color];
  const idle = await tinyTexture(`pawn_${color}_idle.png`);
  const run = await tinyTexture(`pawn_${color}_run.png`);
  if (!idle || !run) return null;
  const slice = (sheet: Texture, frames: number) => {
    const out: Texture[] = [];
    for (let i = 0; i < frames; i += 1) {
      out.push(new Texture({
        source: sheet.source,
        frame: new Rectangle(i * PAWN_FRAME, 0, PAWN_FRAME, PAWN_FRAME),
      }));
    }
    return out;
  };
  const set: PawnSet = { idle: slice(idle, 8), run: slice(run, 6) };
  pawnCache[color] = set;
  return set;
}

function pawnColorFor(id: string): string {
  return PAWN_COLORS[agentIndex(id) % PAWN_COLORS.length];
}

// ── Tiny Swords island terrain ────────────────────────────────────────────────
const grassTex: Record<string, Texture> = {};
const grass2Tex: Record<string, Texture> = {};      // darker jungle grass
const sandTex: Record<string, Texture> = {};
let waterTex: Texture | null = null;
let tinyTerrainReady = false;
// Baked land: all terrain layers flattened into one texture (no inter-tile seams
// at any zoom). Rebuilt only when the world changes.
let bakedTerrain: RenderTexture | null = null;
let terrainDirty = true;
const SLICE_NAMES = ["c", "t", "b", "l", "r", "tl", "tr", "bl", "br"];

// Animated shoreline foam (a 16-frame halo placed under each coastal land tile).
const FOAM_FRAME = 192;
let foamFrames: Texture[] = [];
const foamSprites: Sprite[] = [];
let foamIdx = 0;
let foamT = 0;

async function loadFoam(): Promise<boolean> {
  if (foamFrames.length) return true;
  const sheet = await tinyTexture("foam.png");
  if (!sheet) return false;
  for (let i = 0; i < 16; i += 1) {
    foamFrames.push(new Texture({
      source: sheet.source,
      frame: new Rectangle(i * FOAM_FRAME, 0, FOAM_FRAME, FOAM_FRAME),
    }));
  }
  return true;
}

function animateBushes(): void {
  if (!bushSprites.length) return;
  bushT += app.ticker.deltaMS / 1000;
  if (bushT < 0.18) return;
  bushIdx = (bushIdx + 1) % 8;
  bushT = 0;
  for (const b of bushSprites) {
    const t = b.frames[bushIdx % b.frames.length];
    if (b.sprite.texture !== t) b.sprite.texture = t;
  }
}

let fogTex: Texture | null = null;

async function setupClouds(): Promise<void> {
  const state = store.state;
  const styleKey = `${state?.scenario}:${store.renderStyle}`;
  if (!state || cloudsForScenario === styleKey) return;
  cloudsForScenario = styleKey;
  cloudLayer.removeChildren();
  cloudSprites.length = 0;
  if (state.scenario !== "island") return;           // clouds only on the island for now

  let texs: Texture[];
  if (vectorMode()) {
    // The Lighthouse: no cloud shadows — pale fog banks crawling over the rock.
    if (!fogTex) fogTex = Texture.from(makeFogCanvas());
    texs = [fogTex];
  } else {
    if (!cloudTex.length) {
      for (let i = 1; i <= 8; i += 1) {
        const t = await tinyTexture(`cloud${i}.png`);
        if (t) cloudTex.push(t);
      }
    }
    texs = cloudTex;
  }
  if (!texs.length) return;
  const mapPx = state.map.size * TILE_SIZE;
  const count = vectorMode() ? 6 : ISLAND_CLOUD_COUNT;
  for (let i = 0; i < count; i += 1) {
    const tex = texs[Math.floor(Math.random() * texs.length)];
    const s = new Sprite(tex);
    if (vectorMode()) {
      s.alpha = 0.10 + Math.random() * 0.08;
      s.blendMode = "screen";
      s.scale.set((TILE_SIZE * (11 + Math.random() * 7)) / tex.frame.width);
    } else {
      s.alpha = 0.26 + Math.random() * 0.08;
      s.scale.set((TILE_SIZE * (8 + Math.random() * 5)) / tex.frame.width);
    }
    s.x = Math.random() * mapPx;
    s.y = Math.random() * mapPx;
    cloudLayer.addChild(s);
    cloudSprites.push({ sprite: s, vx: vectorMode() ? 2 + Math.random() * 3.5 : 4 + Math.random() * 6 });
  }
}

function animateClouds(): void {
  const state = store.state;
  if (!cloudSprites.length || !state) return;
  const mapPx = state.map.size * TILE_SIZE;
  const dt = app.ticker.deltaMS / 1000;
  for (const c of cloudSprites) {
    c.sprite.x += c.vx * dt;
    if (c.sprite.x > mapPx + 80) c.sprite.x = -c.sprite.width - 20;
  }
}

function makeGlowTexture(): Texture {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(245,240,222,0.95)");
  g.addColorStop(0.38, "rgba(196,190,174,0.52)");
  g.addColorStop(1, "rgba(90,90,84,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return Texture.from(c);
}

// Warm flicker on every lit fire's glow sprite; at night the pools of light
// become the only thing left alive in the frame. The lighthouse beam sweeps.
function animateGlow(): void {
  const dt = app.ticker.deltaMS / 1000;
  glowT += dt;
  const f = 0.8 + Math.sin(glowT * 7) * 0.12 + Math.sin(glowT * 13) * 0.06;
  const nightBoost = vectorMode() ? 0.55 + nightAlpha * 0.9 : 1;
  for (const g of glowSprites) g.sprite.alpha = Math.min(1, g.base * f * nightBoost);
  for (const b of beamSprites) {
    b.c.rotation += b.v * dt;
    b.c.alpha = 0.10 + nightAlpha * 0.75 + Math.sin(glowT * 9) * 0.02;
  }
}

function sizeNight(): void {
  const state = store.state;
  if (!state) return;
  // Cover the whole tiled ocean, not just the island grid, so night falls on the sea too.
  const pad = OCEAN_PAD * TILE_SIZE;
  const span = state.map.size * TILE_SIZE + pad * 2;
  nightOverlay.clear().rect(-pad, -pad, span, span).fill(0x020304);
}

// Smoothly darken to a hard monochrome night (and dim a little during storms).
function animateNight(): void {
  const state = store.state;
  if (!state) { nightOverlay.alpha = 0; return; }
  const dt = app.ticker.deltaMS / 1000;
  const nightDeep = vectorMode() ? 0.64 : 0.5;       // noir night falls harder
  const target = state.is_night ? nightDeep : (state.weather === "storm" ? 0.26 : 0);
  nightAlpha += (target - nightAlpha) * Math.min(1, dt * 1.2);   // dusk/dawn ramp
  nightOverlay.alpha = nightAlpha;
}

function animateFoam(): void {
  if (!foamFrames.length || !foamSprites.length) return;
  foamT += app.ticker.deltaMS / 1000;
  if (foamT >= 0.08) {
    foamIdx = (foamIdx + 1) % foamFrames.length;
    foamT = 0;
    const tex = foamFrames[foamIdx];
    for (const s of foamSprites) s.texture = tex;
  }
}

async function loadIslandTerrain(): Promise<boolean> {
  if (tinyTerrainReady) return true;
  waterTex = await tinyTexture("water.png");
  let ok = waterTex !== null;
  for (const nm of SLICE_NAMES) {
    const g = await tinyTexture(`grass_${nm}.png`);
    if (g) grassTex[nm] = g; else ok = false;
    const s = await tinyTexture(`sand_${nm}.png`);
    if (s) sandTex[nm] = s; else ok = false;
    const g2 = await tinyTexture(`grass2_${nm}.png`);
    if (g2) grass2Tex[nm] = g2;
  }
  tinyTerrainReady = ok;
  return ok;
}

// Decorations (trees / bushes / rocks / water-rocks) scattered by terrain.
type DecorKind = "tree" | "rock" | "waterrock" | "decoRock" | "decoBush" | "orerock";
const decorTex: Record<DecorKind, Texture[]> = {
  tree: [],
  rock: [],
  waterrock: [],
  decoRock: [],
  decoBush: [],
  orerock: [],
};
const bushFrames: Texture[][] = [];                 // 4 animated bush variants × 8 frames
const bushSprites: { sprite: Sprite; frames: Texture[] }[] = [];   // rebuilt each render
let bushIdx = 0; let bushT = 0;
let decorReady = false;

async function loadDecor(): Promise<boolean> {
  if (decorReady) return true;
  const sets: [DecorKind, number[]][] = [
    ["tree", [1, 2, 3, 4]],         // palms (all trees)
    ["rock", [2, 3, 4]],            // varied rocks
    ["orerock", [1]],               // flint/ore deposit
    ["waterrock", [1, 2, 3, 4]],
  ];
  for (const [kind, idxs] of sets) {
    for (const i of idxs) {
      const t = await tinyTexture(`${kind}${i}.png`);
      if (t) decorTex[kind].push(t);
    }
  }
  const bakedShadowSets: [DecorKind, number[]][] = [
    ["decoRock", [4, 5, 6]],
    ["decoBush", [7, 8, 9, 10, 11]],
  ];
  for (const [kind, idxs] of bakedShadowSets) {
    for (const i of idxs) {
      const t = await tinyTexture(`deco${String(i).padStart(2, "0")}.png`);
      if (t) decorTex[kind].push(t);
    }
  }
  // animated bushes (8-frame sheets) for thickets
  for (let v = 1; v <= 4; v += 1) {
    const sheet = await tinyTexture(`bushsheet${v}.png`);
    if (!sheet) continue;
    const frames: Texture[] = [];
    for (let f = 0; f < 8; f += 1) {
      frames.push(new Texture({ source: sheet.source, frame: new Rectangle(f * 128, 0, 128, 128) }));
    }
    bushFrames.push(frames);
  }
  decorReady = decorTex.tree.length > 0 || decorTex.decoRock.length > 0 || decorTex.decoBush.length > 0;
  return decorReady;
}

// Deterministic 0..1 hash so decor placement is stable across re-renders.
function hash01(x: number, y: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2246822519) >>> 0;
  h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
  return (h >>> 8) / 16777216;
}

function pick(arr: Texture[], x: number, y: number): Texture {
  return arr[Math.floor(hash01(x, y, 2) * arr.length) % arr.length];
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

function pickById(arr: Texture[], id: string): Texture {
  return arr[Math.floor(hashStr(id) * arr.length) % arr.length];
}

// Render resource nodes (trees / rocks / thickets / springs) as depth-sorted
// props in the object layer. What you see IS what you harvest.
async function renderNodes(): Promise<void> {
  const state = store.state;
  if (!state) return;
  await loadDecor();
  bushSprites.length = 0;
  const propSprite = (tex: Texture, base: number, cx: number, sizeT: number, anchorY: number) => {
    const s = new Sprite(tex);
    s.anchor.set(0.5, anchorY);
    s.x = cx; s.y = base;
    s.scale.set((sizeT * TILE_SIZE) / tex.frame.height);
    s.zIndex = base;
    objectLayer.addChild(s); propSprites.push(s);
  };
  // A real little water pool: a wet bank rim, textured water masked to an ellipse,
  // and a glint — instead of a flat teal blob.
  const pool = (base: number, cx: number, w: number) => {
    const cy = -TILE_SIZE * 0.45;
    const rx = TILE_SIZE * w, ry = TILE_SIZE * w * 0.62;
    const cont = new Container();
    cont.x = cx; cont.y = base; cont.zIndex = base;
    cont.addChild(new Graphics().ellipse(0, cy, rx * 1.2, ry * 1.2).fill({ color: 0x7a6643, alpha: 0.45 }));
    cont.addChild(new Graphics().ellipse(0, cy, rx, ry).fill({ color: 0x3f93a8 }));
    if (waterTex) {
      const mask = new Graphics().ellipse(0, cy, rx, ry).fill(0xffffff);
      const wsp = new Sprite(waterTex);
      wsp.anchor.set(0.5); wsp.x = 0; wsp.y = cy;
      wsp.width = rx * 2.3; wsp.height = ry * 2.3; wsp.alpha = 0.92;
      wsp.mask = mask;
      cont.addChild(mask, wsp);
    }
    cont.addChild(new Graphics()
      .ellipse(-rx * 0.28, cy - ry * 0.32, rx * 0.42, ry * 0.26).fill({ color: 0xcdeef3, alpha: 0.40 }));
    cont.addChild(new Graphics().ellipse(0, cy, rx, ry).stroke({ width: 1.5, color: 0x24566a, alpha: 0.45 }));
    objectLayer.addChild(cont); propSprites.push(cont);
  };
  // Soft contact shadow grounds a prop so it doesn't look pasted on the grass.
  const shadow = (cx: number, base: number, w: number) => {
    const g = new Graphics().ellipse(0, 0, w, w * 0.34).fill({ color: 0x10240f, alpha: 0.22 });
    g.x = cx; g.y = base - 3; g.zIndex = base - 0.5;
    objectLayer.addChild(g); propSprites.push(g);
  };
  for (const node of state.resources) {
    if (node.quantity <= 0) continue;
    const cx = node.x * TILE_SIZE + TILE_SIZE / 2;
    const base = node.y * TILE_SIZE + TILE_SIZE;
    const k = node.kind;
    if ((k === "wood" || k === "fruit_tree") && decorTex.tree.length) {
      shadow(cx, base + TILE_SIZE * 0.2, TILE_SIZE * 0.62);
      propSprite(pickById(decorTex.tree, node.id), base, cx, 2.3, 0.95);          // palm
    } else if (k === "thicket" && decorTex.decoBush.length) {
      propSprite(pickById(decorTex.decoBush, node.id), base, cx, 0.98, 0.86);
    } else if (k === "thicket" && bushFrames.length) {
      shadow(cx, base - TILE_SIZE * 0.36, TILE_SIZE * 0.24);   // smaller, tucked under
      const frames = bushFrames[Math.floor(hashStr(node.id) * bushFrames.length) % bushFrames.length];
      const s = new Sprite(frames[0]);
      s.anchor.set(0.5, 0.9); s.x = cx; s.y = base - TILE_SIZE * 0.24;   // raised off the ground
      s.scale.set((0.82 * TILE_SIZE) / 128); s.zIndex = base;
      objectLayer.addChild(s); propSprites.push(s);
      bushSprites.push({ sprite: s, frames });
    } else if (k === "rocks" && decorTex.decoRock.length) {
      propSprite(pickById(decorTex.decoRock, node.id), base, cx, 1.05, 0.86);
    } else if (k === "rocks" && decorTex.rock.length) {
      shadow(cx, base, TILE_SIZE * 0.42);
      propSprite(pickById(decorTex.rock, node.id), base, cx, 1.05, 0.85);
    } else if (k === "orerock" && decorTex.orerock.length) {
      shadow(cx, base, TILE_SIZE * 0.42);
      propSprite(pickById(decorTex.orerock, node.id), base, cx, 1.2, 0.9);
    } else if (k === "spring") pool(base, cx, 0.5);
    else if (k === "fishing") pool(base, cx, 0.42);
  }
}

// Pick the 9-slice piece: `isEdge(nx,ny)` = true when that neighbour is OUTSIDE
// this terrain layer (so a fringe should be drawn on that side).
function autoSlice(isEdge: (x: number, y: number) => boolean, x: number, y: number): string {
  const N = isEdge(x, y - 1), S = isEdge(x, y + 1), W = isEdge(x - 1, y), E = isEdge(x + 1, y);
  if (N && W) return "tl";
  if (N && E) return "tr";
  if (S && W) return "bl";
  if (S && E) return "br";
  if (N) return "t";
  if (S) return "b";
  if (W) return "l";
  if (E) return "r";
  return "c";
}

async function renderIslandTerrain(seq: number): Promise<boolean> {
  const state = store.state;
  if (!state) return false;
  if (!(await loadIslandTerrain()) || !waterTex) return false;
  if (seq !== renderSeq) return true;
  const n = state.map.size;
  const grid = state.map.grid;
  const isWater = (x: number, y: number) =>
    x < 0 || y < 0 || x >= n || y >= n || grid[y][x].includes("water");

  // One large tiling ocean stretching far past the island in every direction.
  const pad = OCEAN_PAD * TILE_SIZE;
  const span = n * TILE_SIZE + pad * 2;
  const ocean = new TilingSprite({ texture: waterTex, width: span, height: span });
  ocean.x = -pad; ocean.y = -pad;
  ocean.tileScale.set(TILE_SIZE / waterTex.frame.width);
  worldLayer.addChild(ocean);
  // Animated shoreline foam on coastal land tiles (behind sand/grass).
  foamSprites.length = 0;
  if (await loadFoam()) {
    const foamTex = foamFrames[foamIdx];
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        if (isWater(x, y)) continue;
        if (!(isWater(x - 1, y) || isWater(x + 1, y) || isWater(x, y - 1) || isWater(x, y + 1))) continue;
        const f = new Sprite(foamTex);
        f.anchor.set(0.5);
        f.x = x * TILE_SIZE + TILE_SIZE / 2;
        f.y = y * TILE_SIZE + TILE_SIZE / 2;
        f.width = TILE_SIZE * 3; f.height = TILE_SIZE * 3;
        worldLayer.addChild(f);
        foamSprites.push(f);
      }
    }
  }
  // ── Bake all land layers into ONE texture (no seams at any zoom) ────────────
  if (terrainDirty || !bakedTerrain) {
    const isGrassy = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < n && y < n && !grid[y][x].includes("water") && !grid[y][x].includes("sand");
    const notGrassy = (x: number, y: number) => !isGrassy(x, y);

    const buf = new Container();
    const put = (tex: Texture, x: number, y: number) => {
      const s = new Sprite(tex);
      s.x = x * TILE_SIZE; s.y = y * TILE_SIZE; s.width = TILE_SIZE; s.height = TILE_SIZE;
      buf.addChild(s);
    };

    // Sand base (fringe against water — the beach)
    for (let y = 0; y < n; y += 1)
      for (let x = 0; x < n; x += 1)
        if (!isWater(x, y)) { const t = sandTex[autoSlice(isWater, x, y)]; if (t) put(t, x, y); }

    // Grass interior, sandy fringe at the beach
    for (let y = 0; y < n; y += 1)
      for (let x = 0; x < n; x += 1)
        if (isGrassy(x, y)) { const t = grassTex[autoSlice(notGrassy, x, y)]; if (t) put(t, x, y); }

    // Jungle: darker-green grass laid over the meadow on dense-foliage tiles.
    if (grass2Tex.c) {
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
      const isJungle = (x: number, y: number) => x >= 0 && y >= 0 && x < n && y < n && sm[y][x];
      const notJungle = (x: number, y: number) => !isJungle(x, y);
      for (let y = 0; y < n; y += 1)
        for (let x = 0; x < n; x += 1)
          if (isJungle(x, y)) { const t = grass2Tex[autoSlice(notJungle, x, y)]; if (t) put(t, x, y); }
    }

    if (bakedTerrain) bakedTerrain.destroy(true);
    bakedTerrain = RenderTexture.create({ width: n * TILE_SIZE, height: n * TILE_SIZE, resolution: 1 });
    bakedTerrain.source.scaleMode = "nearest";
    app.renderer.render({ container: buf, target: bakedTerrain });
    buf.destroy({ children: true });
    terrainDirty = false;
  }

  const land = new Sprite(bakedTerrain);
  land.x = 0; land.y = 0;
  worldLayer.addChild(land);
  return true;
}

export async function render() {
  const state = store.state;
  if (!state) return;

  // 3D mode: three.js owns the frame; Pixi canvas hides, HTML overlay stays.
  if (mode3d()) {
    sync3d(state, stageEl);
    app.canvas.style.display = "none";
    syncAgentDom(state);
    return;
  }
  setActive3d(false);
  app.canvas.style.display = "";
  // Ink-black sea for the noir vector island; original tones elsewhere.
  app.renderer.background.color = vectorMode() ? V.seaDeep
    : state.scenario === "island" ? OCEAN_COLOR : VOID_COLOR;

  const seq = ++renderSeq;
  worldLayer.removeChildren();
  // Destroy last frame's props (nodes + structures); agents persist & animate.
  for (const p of propSprites) p.destroy();
  propSprites.length = 0;
  updateCamera();

  let islandDrawn = false;
  if (state.scenario === "island") {
    if (vectorMode()) {
      // Procedural diorama: cached container of smoothed polygons, no assets.
      worldLayer.addChild(buildVectorTerrain(state));
      islandDrawn = true;
    } else {
      islandDrawn = await renderIslandTerrain(seq);
    }
  }
  if (seq !== renderSeq) return;

  if (!islandDrawn) {
    for (let y = 0; y < state.map.grid.length; y += 1) {
      for (let x = 0; x < state.map.grid[y].length; x += 1) {
        const terrain = state.map.grid[y][x];
        const base = new Graphics()
          .rect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE)
          .fill(terrainColor(terrain));
        worldLayer.addChild(base);
      }
    }
    const terrains = new Map<string, Texture>();
    for (const row of state.map.grid) {
      for (const terrain of row) {
        if (!terrains.has(terrain)) {
          const t = await maybeTexture(`tiles/${terrain}.png`);
          if (seq !== renderSeq) return;
          if (t) terrains.set(terrain, t);
        }
      }
    }
    for (let y = 0; y < state.map.grid.length; y += 1) {
      for (let x = 0; x < state.map.grid[y].length; x += 1) {
        const t = terrains.get(state.map.grid[y][x]);
        if (!t) continue;
        const sprite = new Sprite(t);
        sprite.x = x * TILE_SIZE;
        sprite.y = y * TILE_SIZE;
        sprite.width = TILE_SIZE;
        sprite.height = TILE_SIZE;
        sprite.alpha = 0.92;
        worldLayer.addChild(sprite);
      }
    }
  }

  if (state.scenario === "island") {
    if (vectorMode()) {
      // Directional contact shadow shared by all noir props (falls SE, hard).
      const propShadow = (cx: number, base: number, w: number) => {
        const g = new Graphics()
          .ellipse(0, 0, TILE_SIZE * w, TILE_SIZE * w * 0.32)
          .fill({ color: 0x050606, alpha: 0.3 });
        g.x = cx + TILE_SIZE * w * 0.35; g.y = base - 2; g.zIndex = base - 0.5;
        objectLayer.addChild(g); propSprites.push(g);
      };
      for (const node of state.resources) {
        if (node.quantity <= 0) continue;
        const base = node.y * TILE_SIZE + TILE_SIZE;
        const cx = node.x * TILE_SIZE + TILE_SIZE / 2;
        // hand-cut prop sprites (palms, boulders, bushes, springs)
        const spec = vectorPropSpec(node.kind, node.id);
        if (spec) {
          const tex = await vectorPropTexture(spec.file);
          if (seq !== renderSeq) return;
          if (tex) {
            propShadow(cx, base, spec.shadowW);
            const sprite = new Sprite(tex);
            sprite.anchor.set(0.5, spec.anchorY);
            const s = (spec.size * TILE_SIZE) / tex.height;
            sprite.scale.set(spec.flip ? -s : s, s);
            sprite.x = cx; sprite.y = base;
            sprite.tint = 0xf2eee3;
            sprite.zIndex = base;
            objectLayer.addChild(sprite); propSprites.push(sprite);
            continue;
          }
        }
        if (node.kind === "orerock") {
          const tex = await vectorStructureTexture("ore_rock.png");
          if (seq !== renderSeq) return;
          if (tex) {
            propShadow(cx, base, 0.5);
            const sprite = new Sprite(tex);
            sprite.anchor.set(0.5, 1);
            sprite.scale.set(Math.min((TILE_SIZE * 1.45) / tex.width, (TILE_SIZE * 1.45) / tex.height));
            sprite.x = cx; sprite.y = base;
            sprite.tint = 0xf2eee3;
            sprite.zIndex = base;
            objectLayer.addChild(sprite); propSprites.push(sprite);
            continue;
          }
        }
        const prop = buildVectorProp(node);
        if (!prop) continue;
        prop.x = cx;
        prop.y = base;
        prop.zIndex = base;
        objectLayer.addChild(prop);
        propSprites.push(prop);
      }
    } else {
      await renderNodes();
    }
    if (seq !== renderSeq) return;
  } else {
    for (const node of state.resources.filter((n) => n.quantity > 0)) {
      const t = await maybeTexture(`items/${itemSpriteName(node.yield_item)}`);
      if (seq !== renderSeq) return;
      const base = node.y * TILE_SIZE + TILE_SIZE;
      if (!t) {
        const marker = new Graphics()
          .circle(node.x * TILE_SIZE + 12, node.y * TILE_SIZE + 12, 5).fill(0xf2b544);
        marker.zIndex = base; objectLayer.addChild(marker); propSprites.push(marker);
        continue;
      }
      const sprite = new Sprite(t);
      sprite.x = node.x * TILE_SIZE + 4;
      sprite.y = node.y * TILE_SIZE + 4;
      sprite.width = 16; sprite.height = 16; sprite.alpha = 0.9;
      sprite.zIndex = base; objectLayer.addChild(sprite); propSprites.push(sprite);
    }
  }

  glowSprites.length = 0;
  beamSprites.length = 0;
  for (const s of state.structures) {
    const w = Math.max(1, s.w || 1);
    const h = Math.max(1, s.h || 1);
    // footprint: w x h tiles, bottom-centre tile is (s.x, s.y)
    const x0 = s.x - Math.floor((w - 1) / 2);
    const y0 = s.y - (h - 1);
    const px = x0 * TILE_SIZE;
    const py = y0 * TILE_SIZE;
    const pw = w * TILE_SIZE;
    const ph = h * TILE_SIZE;

    // Contact shadow grounding the structure. In the noir vector world every
    // shadow falls the same way — long, hard, to the south-east.
    const vecShadow = vectorMode();
    const shadow = new Graphics()
      .ellipse(0, 0, pw * (vecShadow ? 0.44 : 0.36), pw * (vecShadow ? 0.14 : 0.16))
      .fill({ color: 0x050606, alpha: vecShadow ? 0.34 : 0.28 });
    const shadowLift = STRUCT_SHADOW_LIFT[s.kind] ?? 3;
    shadow.x = px + pw / 2 + (vecShadow ? pw * 0.16 : 0);
    shadow.y = py + ph - shadowLift; shadow.zIndex = py + ph - 0.5;
    objectLayer.addChild(shadow); propSprites.push(shadow);

    // Warm additive glow over a lit campfire.
    const st = s.state ?? {};
    if (glowTex && s.kind === "campfire" && st.complete && (st.fuel as number ?? 0) > 0) {
      const glow = new Sprite(glowTex);
      glow.anchor.set(0.5, 0.5);
      glow.blendMode = "add";
      glow.width = glow.height = TILE_SIZE * 2.8;
      glow.x = px + pw / 2;
      glow.y = py + ph - TILE_SIZE * 0.7;
      glow.alpha = 0.6;
      glow.zIndex = py + ph + 1;
      objectLayer.addChild(glow); propSprites.push(glow);
      glowSprites.push({ sprite: glow, base: 0.6 });
    }
    // Beacon glow at the top of a relit lighthouse.
    if (glowTex && s.kind === "lighthouse" && st.active) {
      const glow = new Sprite(glowTex);
      glow.anchor.set(0.5, 0.5);
      glow.blendMode = "add";
      glow.width = glow.height = TILE_SIZE * 3.2;
      glow.x = px + pw / 2;
      glow.y = py + ph * 0.16;                       // near the lamp room (top)
      glow.alpha = 0.7;
      glow.zIndex = py + ph + 1;
      objectLayer.addChild(glow); propSprites.push(glow);
      glowSprites.push({ sprite: glow, base: 0.7 });
    }

    let t: Texture | null = null;
    if (vectorMode()) {
      for (const cand of vectorStructureSpriteCandidates(s)) {
        t = await vectorStructureTexture(cand);
        if (seq !== renderSeq) return;
        if (t) break;
      }
    } else {
      for (const cand of structureSpriteCandidates(s)) {
        t = await silentTexture(`structures/${cand}`);
        if (seq !== renderSeq) return;
        if (t) break;
      }
    }

    let node: Sprite | Graphics;
    if (t) {
      const sprite = new Sprite(t);
      const scale = STRUCT_RENDER_SCALE[s.kind] ?? 1.0;
      sprite.anchor.set(0.5, 1);                       // bottom-centre on the footprint
      if (vectorMode()) {
        const fit = Math.min((pw * scale) / t.width, (ph * scale) / t.height);
        sprite.scale.set(fit);
        sprite.tint = 0xf2eee3;   // near-white: keep the assets' own contrast
      } else {
        sprite.width = pw * scale; sprite.height = ph * scale;
      }
      sprite.x = px + pw / 2; sprite.y = py + ph;
      node = sprite;
    } else {
      const drawn = vectorMode() ? buildVectorStructure(s, pw, ph) : null;
      if (drawn) {
        drawn.x = px + pw / 2;
        drawn.y = py + ph;
        node = drawn;
      } else {
        node = structurePlaceholder(s, px, py, pw, ph);
      }
    }
    node.eventMode = "static";
    node.cursor = "pointer";
    node.on("pointertap", () => {
      store.selectedStructureId = store.selectedStructureId === s.id ? null : s.id;
      if (store.selectedStructureId) openStructModal(s);
      else closeModal();
      void render();
    });
    node.zIndex = py + ph;                    // depth-sort by the structure's base
    objectLayer.addChild(node);
    propSprites.push(node);

    // The shot the whole style builds toward: a white beam sweeping from the
    // relit lighthouse, barely-there by day, cutting the dark at night.
    if (glowTex && vectorMode() && s.kind === "lighthouse" && st.active) {
      const lampY = node instanceof Sprite
        ? py + ph - node.height * 0.86
        : py + ph - Math.max(pw, TILE_SIZE * 1.4) * 1.02;
      const beam = new Container();
      for (const dir of [0, Math.PI]) {
        const ray = new Sprite(glowTex);
        ray.anchor.set(0, 0.5);
        ray.rotation = dir;
        ray.width = TILE_SIZE * 10;
        ray.height = TILE_SIZE * 1.35;
        ray.blendMode = "add";
        beam.addChild(ray);
      }
      beam.x = px + pw / 2;
      beam.y = lampY;
      beam.rotation = hashStr(s.id) * Math.PI;
      beam.alpha = 0.1;
      beam.zIndex = 1e8;                      // above everything but selection
      beam.eventMode = "none";
      objectLayer.addChild(beam);
      propSprites.push(beam);
      beamSprites.push({ c: beam, v: 0.4 });
    }

    if (s.id === store.selectedStructureId) {
      const hl = new Graphics().rect(px, py, pw, ph)
        .fill({ color: 0x2bd1c4, alpha: 0.16 })
        .stroke({ width: 2, color: 0x2bd1c4 });
      for (let gx = 1; gx < w; gx += 1) hl.moveTo(px + gx * TILE_SIZE, py).lineTo(px + gx * TILE_SIZE, py + ph);
      for (let gy = 1; gy < h; gy += 1) hl.moveTo(px, py + gy * TILE_SIZE).lineTo(px + pw, py + gy * TILE_SIZE);
      hl.stroke({ width: 1, color: 0x2bd1c4, alpha: 0.5 });
      hl.zIndex = 1e9;                        // selection always on top
      objectLayer.addChild(hl);
      propSprites.push(hl);
    }
  }

  if (vectorMode()) {
    // meeples are code-drawn — no textures to load
  } else if (state.scenario === "island") {
    for (const c of PAWN_COLORS) await loadPawn(c);
  } else {
    await ensureAgentTextures(agentPrefix());
  }
  if (seq !== renderSeq) return;
  syncAgents();
}

function terrainColor(terrain: string): number {
  if (terrain.includes("mars_regolith")) return 0x9e5a3d;
  if (terrain.includes("mars_rock")) return 0x69574e;
  if (terrain.includes("mars_dune")) return 0xbb7044;
  if (terrain.includes("ice")) return 0xbadce2;
  if (terrain.includes("sand")) return 0xdcc766;
  if (terrain.includes("jungle")) return 0x4f7f4d;
  if (terrain.includes("foliage")) return 0x2f633f;
  if (terrain.includes("water")) return 0x5ca8a5;
  if (terrain.includes("rock")) return 0x77776f;
  return 0x8a946e;
}
