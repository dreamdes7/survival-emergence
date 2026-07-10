// Live-tunable visual settings + style presets. A leaf module (imports nothing
// app-side) shared by the renderer — which reads these into shader uniforms and
// camera state every frame — and the UI graphics panel, which mutates them.
// Persisted to localStorage so a chosen look survives reloads.

export type Gfx = {
  preset: string;
  // ── paint / grade (fed to the GradeShader) ──────────────────────────────────
  ink: number;          // outline weight
  inkWidth: number;     // outline thickness (contour dilation)
  inkSilhouette: boolean; // outline whole objects only (silhouette) vs every edge
  comic: number;        // 0 watercolour · 1 comic (gates solid ink + flat fills)
  posterLevels: number; // luminance bands
  posterAmt: number;    // 0 soft wash · 1 hard cel steps
  halftone: number;     // Ben-Day screentone strength in the shadows
  halftoneScale: number;// dot pitch, px
  saturation: number;
  paper: number;        // paper tooth / granulation amount
  vignette: number;
  barrel: number;       // lens barrel distortion (optics)
  bloom: number;        // halation strength
  focus: number;        // depth-of-field / tilt-shift amount
  sepia: number;        // vintage warm/aged duotone (0 = off)
  flicker: number;      // old-film brightness density flicker
  weave: number;        // projector gate weave (subtle whole-frame drift)
  // ── camera / optics (independent of the paint preset) ───────────────────────
  letterbox: boolean;   // 2.35:1 bars
  viewfinder: boolean;  // optical viewfinder overlay while following
  handheld: number;     // 0..1 operator micro-drift while following
  // ── film stock emulation (independent of the art preset) ────────────────────
  film: string;         // FILM_PROFILES key — the "capture medium" on top
  // ── render quality (independent of the paint preset) ─────────────────────────
  renderScale: number;  // internal super-sample factor over CSS px (SSAA), 1..2
  // ── low-fi pass (independent of the paint preset) ────────────────────────────
  pixel: number;        // block size in display px; 1 = off (A Short Hike look)
  colorBits: number;    // colour depth per channel in bits; 8 = off (full colour)
  dither: number;       // 0 = hard bands … 1 = full ordered dither (needs colorBits < 8)
  // ── world palette (island MATERIAL colours, not a post filter) ───────────────
  palette: string;      // WORLD_PALETTES key — rebuilds the terrain on switch
};

// A world palette recolours the island itself — plate tops, cliff walls, the
// submerged shelf, the canopy — where film profiles only grade the captured
// frame. Together they give authored "looks" instead of one stock render.
export type WorldPalette = {
  beach: number;                         // plate-0 top (the sand ring)
  tops: [number, number, number, number]; // plate 1..4 tops (low grass → summit)
  wallLow: number; wallHigh: number;     // cliff walls: wet base / rock above
  shelf: [number, number];               // glowing shallows pair
  tuft: number; dressRock: number;       // rim grass / wall-foot rocks
  canopy: number; canopySnag: number;    // jungle blob green / dead snag
  meadow: number;                        // scattered undergrowth tufts
};

export const WORLD_PALETTES: Record<string, WorldPalette> = {
  // the shipped look — bright tropical lagoon
  lagoon: {
    beach: 0xe9ddb6, tops: [0x9fc37e, 0x93bb74, 0x89ad84, 0xaaa69e],
    wallLow: 0xcfbf9a, wallHigh: 0x9aa1a5, shelf: [0x83c9be, 0x63a9a0],
    tuft: 0x7ba763, dressRock: 0x9d9890, canopy: 0x628f54, canopySnag: 0x6b5a44,
    meadow: 0x86a86a,
  },
  // golden hour, always — warm dry grass, honeyed rock (A Short Hike mood)
  gloaming: {
    beach: 0xf0dca6, tops: [0xc4b168, 0xb3a25c, 0x998e55, 0xa89a80],
    wallLow: 0xd8b183, wallHigh: 0x8f7c68, shelf: [0x8fd0b8, 0x5fae9d],
    tuft: 0xb8a45a, dressRock: 0xa08a72, canopy: 0x8a8f45, canopySnag: 0x7c5236,
    meadow: 0xc0aa58,
  },
  // cold northern greens under a pale sky — the Bad North key
  boreal: {
    beach: 0xded6c2, tops: [0x8aa878, 0x7d9b73, 0x71886f, 0x9aa0a2],
    wallLow: 0xb5ab97, wallHigh: 0x7e878c, shelf: [0x7fb9b4, 0x5f9799],
    tuft: 0x6f8f68, dressRock: 0x8f8f8c, canopy: 0x4e7350, canopySnag: 0x5f5346,
    meadow: 0x74936b,
  },
  // ash-grey volcanic gloom — the island at its grimmest (blood reads loudest here)
  ashfall: {
    beach: 0xcabfa8, tops: [0x7e8a6b, 0x74806a, 0x6a7369, 0x8a8a86],
    wallLow: 0x9a9182, wallHigh: 0x5f6467, shelf: [0x6fa8a2, 0x4d8683],
    tuft: 0x6b7d5c, dressRock: 0x77746d, canopy: 0x44584a, canopySnag: 0x4a4038,
    meadow: 0x5f7355,
  },
};

export const PALETTE_LABELS: Record<string, string> = {
  lagoon: "Lagoon", gloaming: "Gloaming", boreal: "Boreal", ashfall: "Ashfall",
};

// Palette-change hook: the renderer registers a terrain-rebuild here and the UI
// pings it after mutating gfx.palette. Lives in this leaf module so ui.ts never
// has to import the renderer (render3d imports ui — a direct import would cycle).
const paletteListeners: (() => void)[] = [];
export function onPaletteChange(fn: () => void): void { paletteListeners.push(fn); }
export function notifyPaletteChange(): void { for (const fn of paletteListeners) fn(); }

// A film stock (Dehancer-style): a tone curve (toe lift / shoulder rolloff /
// contrast / S), a channel colour response (how the dye layers push shadows vs
// highlights), the stock's saturation, halation glow, and its grain.
export type FilmProfile = {
  strength: number; contrast: number; sCurve: number; toe: number; shoulder: number;
  shadow: [number, number, number]; high: [number, number, number];
  sat: number; halo: number; haloTint: [number, number, number]; grain: number;
};

export const FILM_PROFILES: Record<string, FilmProfile> = {
  none:        { strength: 0,    contrast: 1,    sCurve: 0,    toe: 0,    shoulder: 0,    shadow: [1, 1, 1],        high: [1, 1, 1],          sat: 1,    halo: 0,    haloTint: [1, 1, 1],       grain: 0 },
  // warm, soft, creamy — the portrait negative
  portra:      { strength: 0.85, contrast: 0.92, sCurve: 0.20, toe: 0.03, shoulder: 0.05, shadow: [1.02, 1.00, 0.96], high: [1.05, 1.00, 0.90], sat: 0.98, halo: 0.05, haloTint: [1.0, 0.7, 0.5], grain: 0.020 },
  // cool, green-leaning, crisp — the Fuji look
  fuji:        { strength: 0.85, contrast: 1.06, sCurve: 0.30, toe: 0.02, shoulder: 0.03, shadow: [0.96, 1.02, 1.04], high: [0.97, 1.03, 0.99], sat: 1.08, halo: 0.03, haloTint: [0.6, 0.8, 1.0], grain: 0.020 },
  // vivid reversal slide — snappy, saturated
  ektachrome:  { strength: 0.90, contrast: 1.12, sCurve: 0.35, toe: 0.00, shoulder: 0.02, shadow: [0.97, 1.00, 1.06], high: [1.03, 1.02, 0.97], sat: 1.20, halo: 0.04, haloTint: [1.0, 0.8, 0.6], grain: 0.015 },
  // black & white — desaturated, contrasty, grainy (Tri-X)
  bw:          { strength: 1.00, contrast: 1.10, sCurve: 0.30, toe: 0.05, shoulder: 0.04, shadow: [1, 1, 1],          high: [1, 1, 1],          sat: 0.0,  halo: 0.0,  haloTint: [1, 1, 1],       grain: 0.050 },
  // old faded print — milky lifted blacks, low sat, warm
  faded:       { strength: 0.90, contrast: 0.84, sCurve: 0.00, toe: 0.13, shoulder: 0.07, shadow: [1.03, 1.00, 0.96], high: [1.00, 0.98, 0.93], sat: 0.80, halo: 0.06, haloTint: [1.0, 0.75, 0.55], grain: 0.030 },
  // technicolor — cyan shadows, warm-red highlights, heavy saturation
  technicolor: { strength: 0.90, contrast: 1.15, sCurve: 0.40, toe: 0.02, shoulder: 0.02, shadow: [0.94, 1.00, 1.07], high: [1.09, 0.98, 0.88], sat: 1.30, halo: 0.05, haloTint: [1.0, 0.6, 0.5], grain: 0.020 },
};

export const FILM_LABELS: Record<string, string> = {
  none: "No film", portra: "Kodak Portra", fuji: "Fuji", ektachrome: "Ektachrome",
  bw: "B&W (Tri-X)", faded: "Faded print", technicolor: "Technicolor",
};

// Which fields a preset owns. Camera/optics fields are deliberately excluded so
// switching the paint look doesn't clobber the user's camera preferences.
export const PAINT_KEYS: (keyof Gfx)[] = [
  "ink", "inkWidth", "comic", "posterLevels", "posterAmt", "halftone",
  "halftoneScale", "saturation", "paper", "vignette", "barrel", "bloom", "focus",
  "sepia", "flicker", "weave",
];

// The current watercolour look, value-for-value, so preset "watercolor" is a
// no-op relative to how the frame looked before presets existed.
const WATERCOLOR: Gfx = {
  preset: "watercolor",
  ink: 0.85, inkWidth: 0, inkSilhouette: true, comic: 0, posterLevels: 6, posterAmt: 0.13,
  halftone: 0, halftoneScale: 5, saturation: 1.14, paper: 1, vignette: 0.14,
  barrel: 0, bloom: 0.22, focus: 1, sepia: 0, flicker: 0, weave: 0,
  letterbox: false, viewfinder: true, handheld: 0.5, film: "none", renderScale: 1.5, pixel: 1, colorBits: 8, dither: 0.95, palette: "lagoon",
};

// Old-film cartoon: keeps the painterly base but ages it — warm faded duotone,
// a deeper vignette, density flicker, a hair of projector gate weave and dust.
// Built ON watercolour (soft, not the hard cel of comic).
const VINTAGE: Gfx = {
  preset: "vintage",
  ink: 1.0, inkWidth: 0.3, inkSilhouette: true, comic: 0, posterLevels: 5, posterAmt: 0.3,
  halftone: 0, halftoneScale: 5, saturation: 0.84, paper: 0.9, vignette: 0.36,
  barrel: 0.07, bloom: 0.36, focus: 1, sepia: 0.62, flicker: 0.5, weave: 0.4,
  letterbox: false, viewfinder: true, handheld: 0.5, film: "none", renderScale: 1.5, pixel: 1, colorBits: 8, dither: 0.95, palette: "lagoon",
};

// Bold cel + ink + Ben-Day dots: comic / old-cartoon. Flatter fills, fewer,
// harder light steps, a solid confident outline, screentone in the shadows, a
// punchier limited-feeling palette, and a whisper of lens barrel.
const COMIC: Gfx = {
  preset: "comic",
  ink: 1.5, inkWidth: 1.15, inkSilhouette: true, comic: 1, posterLevels: 4, posterAmt: 0.9,
  halftone: 0.6, halftoneScale: 5, saturation: 1.34, paper: 0.4, vignette: 0.2,
  barrel: 0.1, bloom: 0.26, focus: 1, sepia: 0, flicker: 0, weave: 0,
  letterbox: false, viewfinder: true, handheld: 0.5, film: "none", renderScale: 1.5, pixel: 1, colorBits: 8, dither: 0.95, palette: "lagoon",
};

export const PRESETS: Record<string, Gfx> = {
  watercolor: WATERCOLOR, vintage: VINTAGE, comic: COMIC,
};

// The look the app OPENS with — a tuned custom grade, deliberately NOT any of the
// three presets. preset:"custom" so no preset pill is highlighted by default.
// Kept separate from the WATERCOLOR preset so "what it opens with" and "what the
// Watercolor pill does" are decoupled (they used to be conflated).
const DEFAULTS: Gfx = {
  preset: "custom",
  ink: 1.0, inkWidth: 0, inkSilhouette: true, comic: 0, posterLevels: 2, posterAmt: 0,
  halftone: 0, halftoneScale: 5, saturation: 1.0, paper: 0.2, vignette: 0,
  barrel: 0, bloom: 0.14, focus: 0, sepia: 0, flicker: 0, weave: 0.1,
  letterbox: false, viewfinder: true, handheld: 0, film: "none", renderScale: 1.5, pixel: 1, colorBits: 3, dither: 0.5, palette: "lagoon",
};

// Bumped when a default changes in a way that should override an existing saved
// value once (rather than being masked by stale localStorage). v2: silhouette
// outline default. v3: dither on by default. v4: restore the original watercolour
// preset. v5: the initial look is the tuned DEFAULTS with no preset selected.
// v6: colour depth crushed to 2 bits. v7: 3 bits + dither 0.5.
const GFX_VERSION = "7";

function load(): Gfx {
  const base: Gfx = { ...DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem("gfx") || "null");
    if (saved && typeof saved === "object") Object.assign(base, saved);
    // one-time migrations for anyone whose saved settings predate this version
    if (localStorage.getItem("gfx_v") !== GFX_VERSION) {
      // reset to the tuned default look with no preset selected (undo an earlier
      // build that had baked the tuned values into the WATERCOLOR preset)
      for (const k of PAINT_KEYS) (base as Record<string, unknown>)[k] = DEFAULTS[k];
      base.preset = "custom";
      base.inkSilhouette = true;
      base.dither = 0.5;
      base.colorBits = 3;
      localStorage.setItem("gfx_v", GFX_VERSION);
      // persist now: the version marker is already bumped, so without writing the
      // migrated value back the stale saved one would win on the next load.
      localStorage.setItem("gfx", JSON.stringify(base));
    }
  } catch { /* ignore corrupt storage */ }
  return base;
}

export const gfx: Gfx = load();

export function saveGfx(): void {
  try { localStorage.setItem("gfx", JSON.stringify(gfx)); } catch { /* quota */ }
}

/** Swap the paint look, keeping camera/optics preferences intact. */
export function applyPreset(name: string): void {
  const p = PRESETS[name];
  if (!p) return;
  for (const k of PAINT_KEYS) (gfx as Record<string, unknown>)[k] = p[k];
  gfx.preset = name;
  saveGfx();
}
