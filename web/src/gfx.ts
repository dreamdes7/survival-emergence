// Live-tunable visual settings + style presets. A leaf module (imports nothing
// app-side) shared by the renderer — which reads these into shader uniforms and
// camera state every frame — and the UI graphics panel, which mutates them.
// Persisted to localStorage so a chosen look survives reloads.

export type Gfx = {
  preset: string;
  // ── paint / grade (fed to the GradeShader) ──────────────────────────────────
  ink: number;          // outline weight
  inkWidth: number;     // outline thickness (contour dilation)
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
};

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
  none: "Без плёнки", portra: "Kodak Portra", fuji: "Fuji", ektachrome: "Ektachrome",
  bw: "Ч/б (Tri-X)", faded: "Выцветшая печать", technicolor: "Technicolor",
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
  ink: 0.85, inkWidth: 0, comic: 0, posterLevels: 6, posterAmt: 0.13,
  halftone: 0, halftoneScale: 5, saturation: 1.14, paper: 1, vignette: 0.14,
  barrel: 0, bloom: 0.22, focus: 1, sepia: 0, flicker: 0, weave: 0,
  letterbox: false, viewfinder: true, handheld: 0.5, film: "none",
};

// Old-film cartoon: keeps the painterly base but ages it — warm faded duotone,
// a deeper vignette, density flicker, a hair of projector gate weave and dust.
// Built ON watercolour (soft, not the hard cel of comic).
const VINTAGE: Gfx = {
  preset: "vintage",
  ink: 1.0, inkWidth: 0.3, comic: 0, posterLevels: 5, posterAmt: 0.3,
  halftone: 0, halftoneScale: 5, saturation: 0.84, paper: 0.9, vignette: 0.36,
  barrel: 0.07, bloom: 0.36, focus: 1, sepia: 0.62, flicker: 0.5, weave: 0.4,
  letterbox: false, viewfinder: true, handheld: 0.5, film: "none",
};

// Bold cel + ink + Ben-Day dots: comic / old-cartoon. Flatter fills, fewer,
// harder light steps, a solid confident outline, screentone in the shadows, a
// punchier limited-feeling palette, and a whisper of lens barrel.
const COMIC: Gfx = {
  preset: "comic",
  ink: 1.5, inkWidth: 1.15, comic: 1, posterLevels: 4, posterAmt: 0.9,
  halftone: 0.6, halftoneScale: 5, saturation: 1.34, paper: 0.4, vignette: 0.2,
  barrel: 0.1, bloom: 0.26, focus: 1, sepia: 0, flicker: 0, weave: 0,
  letterbox: false, viewfinder: true, handheld: 0.5, film: "none",
};

export const PRESETS: Record<string, Gfx> = {
  watercolor: WATERCOLOR, vintage: VINTAGE, comic: COMIC,
};

function load(): Gfx {
  const base: Gfx = { ...WATERCOLOR };
  try {
    const saved = JSON.parse(localStorage.getItem("gfx") || "null");
    if (saved && typeof saved === "object") Object.assign(base, saved);
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
