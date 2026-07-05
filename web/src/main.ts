import { Application, Assets, Container, Graphics, Rectangle, RenderTexture, Sprite, Text, Texture, TilingSprite } from "pixi.js";
import "./styles.css";

type AgentState = {
  id: string;
  name: string;
  gender?: "female" | "male" | "unspecified" | string;
  persona: string;
  model: string;
  x: number;
  y: number;
  status: string;
  physiology: Record<string, number>;
  inventory: Record<string, number>;
  goals: string[];
  allies: number;
  rivals: number;
  diary: [number, string][];
  thought: string;
  action: string;
  said: string;
  decision_source?: string;   // llm | emergency | llm_fallback_stub | repair_stub | stub | wait
  relationships?: { id: string; name: string; label: string; score: number }[];
  best_ally?: string | null;
  following?: string | null;
  followers?: number;
  skills?: Record<string, number>;
  role?: string | null;
  beliefs?: { name: string; trust: number; note: string; tags: string[] }[];
};

type FeedEntry = {
  tick: number;
  day: number;
  agent_id: string;
  agent: string;
  kind: "action" | "speech" | "social";
  thought: string;
  tool: string;
  result: string;
};

type ChronicleEntry = {
  tick: number;
  day: number;
  kind: string;
  text: string;
  importance: number;
  agents: string[];
};

type ResourceState = {
  id: string;
  kind: string;
  yield_item: string;
  x: number;
  y: number;
  quantity: number;
  max_quantity: number;
};

type StructureState = {
  id: string;
  kind: string;
  role: string;
  x: number;
  y: number;
  w: number;
  h: number;
  state: Record<string, number | boolean | string>;
};

type WorldState = {
  tick: number;
  day: number;
  is_night: boolean;
  weather: string | null;
  escaped: boolean;
  escape_winner: string | null;
  escape_progress: number;
  scenario: "mars" | "island";
  map: { size: number; grid: string[][] };
  agents: AgentState[];
  resources: ResourceState[];
  structures: StructureState[];
  feed: FeedEntry[];
  chronicle?: ChronicleEntry[];
  saga?: { tick: number; day: number; text: string }[];
  claims?: { node_id: string; owner_id: string; owner: string }[];
  metrics: {
    indicators: Record<string, number>;
    gini_inventory: number;
    tool_usage: Record<string, number>;
    barter_count: number;
  };
  // Decision provenance: share of actions authored by each brain this run.
  provenance?: {
    total: number;
    heuristic_share: number;
    by_source: Record<string, number>;
  } | null;
};

// Backend-authoritative per-structure knowledge (footprint, build cost/progress).
// Fetched from /manifest so the frontend stops hardcoding these in several places.
type Manifest = {
  scenario: string;
  map_size: number;
  structures: Record<string, {
    w: number; h: number;
    buildable?: boolean;
    required_progress?: number;
    cost?: Record<string, number>;
  }>;
};

type ForgeConfig = {
  scenario: "mars" | "island";
  seed: number;
  provider?: string;
  sim: {
    max_days: number;
    api_tick_seconds?: number;
    emergency_multiplier?: number;
  };
  llm?: {
    fallback_policy?: string;
  };
  agents: {
    count: number;
    model_override?: string | null;
    persona_mode?: string;
    roster?: { name: string; model?: string }[];
  };
  budget: {
    usd_cap: number;
    tokens_per_agent_tick?: number;
    context_tokens_per_agent_tick?: number;
    max_output_tokens?: number;
  };
};

type SimMeta = {
  sim_id: string;
  scenario?: string;
  day?: number;
  alive?: number;
  paused?: boolean;
  status?: string;
};

const API_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000";
const WS_BASE = API_URL.replace(/^http/, "ws") + "/ws";
const TILE_SIZE = 24;
const OCEAN_PAD = 80;          // tiles of open sea drawn around the island (endless-ocean feel)
const OCEAN_COLOR = 0x2c5f70;  // deep teal — canvas backdrop beyond the tiled water
const VOID_COLOR = 0x140e12;   // mars / fallback backdrop

// ── Multi-sim state ───────────────────────────────────────────────────────────
const simStates = new Map<string, WorldState>();   // sim_id -> latest world snapshot
const simSockets = new Map<string, WebSocket>();   // sim_id -> live websocket
const simMetaMap = new Map<string, SimMeta>();     // sim_id -> lightweight meta
let activeSimId = "default";

// Backend-authoritative structure manifest (per scenario). Fetched lazily so a
// new buildable/cost only has to change on the backend, not in the frontend.
const manifestByScenario = new Map<string, Manifest>();

async function ensureManifest(sim_id: string, scenario: string): Promise<void> {
  if (manifestByScenario.has(scenario)) return;
  const url = sim_id === "default" ? `${API_URL}/manifest` : `${API_URL}/sims/${sim_id}/manifest`;
  try {
    const res = await fetch(url);
    if (res.ok) manifestByScenario.set(scenario, (await res.json()) as Manifest);
  } catch { /* offline — helpers fall back to defaults */ }
}

// Required build progress for a structure kind: manifest first (source of truth),
// then a conservative default. Replaces the value that used to be hardcoded in
// two render paths and the scenario yaml.
function requiredProgress(kind: string): number {
  const scen = simStates.get(activeSimId)?.scenario;
  const fromManifest = scen ? manifestByScenario.get(scen)?.structures?.[kind]?.required_progress : undefined;
  if (typeof fromManifest === "number") return fromManifest;
  return kind === "tent" ? 40 : kind === "water_still" ? 25 : kind === "store" ? 25 : 30;
}

const stageEl = document.querySelector<HTMLDivElement>("#stage")!;
const titleEl = document.querySelector<HTMLHeadingElement>("#world-title")!;
const statsEl = document.querySelector<HTMLDivElement>("#world-stats")!;
const legendEl = document.querySelector<HTMLDivElement>("#legend")!;
const forgeForm = document.querySelector<HTMLFormElement>("#forge-form")!;
const metricsEl = document.querySelector<HTMLDivElement>("#metrics-dashboard")!;
const eventsEl = document.querySelector<HTMLElement>("#event-log")!;
const chronicleEl = document.querySelector<HTMLDivElement>("#chronicle");
const viewportTools = document.querySelector<HTMLDivElement>("#viewport-tools")!;

// Character modal elements (B2: these replace the old inline inspector sections)
const charModal = document.querySelector<HTMLDivElement>("#char-modal")!;
const ccClose = document.querySelector<HTMLButtonElement>("#cc-close")!;
const ccAgentView = document.querySelector<HTMLDivElement>("#cc-agent-view")!;
const ccStructView = document.querySelector<HTMLDivElement>("#cc-struct-view")!;
const ccName = document.querySelector<HTMLDivElement>("#cc-name")!;
const ccSwatch = document.querySelector<HTMLDivElement>("#cc-swatch")!;
const ccChips = document.querySelector<HTMLDivElement>("#cc-chips")!;
const ccCognition = document.querySelector<HTMLDivElement>("#cc-cognition")!;
const ccBars = document.querySelector<HTMLDivElement>("#cc-bars")!;
const ccInv = document.querySelector<HTMLDivElement>("#cc-inv")!;
const ccRels = document.querySelector<HTMLDivElement>("#cc-rels")!;
const ccSkills = document.querySelector<HTMLDivElement>("#cc-skills")!;
const ccBeliefs = document.querySelector<HTMLDivElement>("#cc-beliefs")!;
const ccDiary = document.querySelector<HTMLDivElement>("#cc-diary")!;
const ccStructBody = document.querySelector<HTMLDivElement>("#cc-struct-body")!;

let modalAgentId: string | null = null;
let modalIsOpen = false;

function openAgentModal(id: string) {
  modalAgentId = id;
  modalIsOpen = true;
  ccAgentView.hidden = false;
  ccStructView.hidden = true;
  charModal.hidden = false;
  refreshModal();
}

function openStructModal(s: StructureState) {
  modalAgentId = null;
  modalIsOpen = true;
  ccAgentView.hidden = true;
  ccStructView.hidden = false;
  charModal.hidden = false;
  renderStructureModal(s);
}

function closeModal() {
  modalIsOpen = false;
  charModal.hidden = true;
  modalAgentId = null;
}

function refreshModal() {
  if (!modalIsOpen || !state) return;
  if (modalAgentId) {
    const agent = state.agents.find((a) => a.id === modalAgentId);
    if (agent) renderAgentModal(agent);
  }
}

function renderAgentModal(agent: AgentState) {
  ccSwatch.style.background = agentCssInk(agent.id);
  ccName.textContent = agent.name;
  ccChips.innerHTML = [
    agent.role ? `<span class="cc-chip cc-chip-role">${escapeHtml(agent.role)}</span>` : "",
    chip(genderLabel(agent.gender)),
    chip(agent.persona),
    chip(agent.status),
    chip(`${agent.x},${agent.y}`),
    chip(`A${agent.allies} R${agent.rivals}`),
    agent.following ? chip(`→ ${agent.following}`) : "",
    agent.followers ? chip(`${agent.followers} follower${agent.followers !== 1 ? "s" : ""}`) : "",
  ].join("");

  ccCognition.innerHTML = [
    agent.thought ? `<div class="cc-cog-line cc-thought">💭 ${escapeHtml(agent.thought)}</div>` : "",
    agent.action ? `<div class="cc-cog-line cc-action">▶ ${escapeHtml(agent.action)}</div>` : "",
    agent.said ? `<div class="cc-cog-line cc-said">💬 ${escapeHtml(agent.said)}</div>` : "",
    agent.decision_source ? `<div class="cc-cog-line cc-source">${sourceBadge(agent.decision_source)}</div>` : "",
  ].join("") || `<div class="cc-empty">No activity yet.</div>`;

  const oldScrollTop = ccDiary.scrollTop;
  ccBars.innerHTML = Object.entries(agent.physiology).map(([k, v]) => statBar(k, v)).join("");
  ccInv.innerHTML = Object.keys(agent.inventory).length
    ? Object.entries(agent.inventory).map(([k, v]) => `<div class="cc-chip">${escapeHtml(k)}: ${Math.round(v)}</div>`).join("")
    : `<div class="cc-empty">Empty.</div>`;

  const skills = agent.skills ?? {};
  const skEntries = Object.entries(skills).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  ccSkills.innerHTML = skEntries.length
    ? skEntries.map(([k, v]) => `<div class="cc-chip">${escapeHtml(k)} · ${Math.round(v)}</div>`).join("")
    : `<div class="cc-empty">Ещё не нашёл своего ремесла.</div>`;

  const beliefs = agent.beliefs ?? [];
  ccBeliefs.innerHTML = beliefs.length
    ? beliefs.map((b) => {
        const cls = b.trust > 0.3 ? "trust-pos" : b.trust < -0.3 ? "trust-neg" : "trust-neu";
        const tags = b.tags?.length ? `<span class="cc-belief-tags">${escapeHtml(b.tags.join(", "))}</span>` : "";
        return `<div class="cc-belief ${cls}"><span class="cc-belief-name">${escapeHtml(b.name)}</span><span class="cc-belief-note">${escapeHtml(b.note)}</span>${tags}</div>`;
      }).join("")
    : `<div class="cc-empty">Пока не составил мнения о людях.</div>`;

  const rels = agent.relationships ?? [];
  ccRels.innerHTML = rels.length
    ? rels.map((r) => `<div class="cc-rel cc-rel-${r.label}"><span class="cc-rel-name">${escapeHtml(r.name)}</span><span class="cc-rel-label">${r.label}</span><span class="cc-rel-score">${Math.round(r.score * 100)}%</span></div>`).join("")
    : `<div class="cc-empty">No relationships yet.</div>`;

  ccDiary.innerHTML = agent.diary.length
    ? [...agent.diary].reverse().map(([tick, text]) => `<div class="cc-diary-line">T${tick}: ${escapeHtml(text)}</div>`).join("")
    : `<div class="cc-empty">No diary entries.</div>`;
  ccDiary.scrollTop = oldScrollTop;
}

function renderStructureModal(s: StructureState) {
  const st = s.state ?? {};
  const building = st.buildable_kind !== undefined && !st.complete;
  const req = requiredProgress((st.buildable_kind as string) ?? s.kind);
  const progress = st.progress as number ?? 0;
  const rows: string[] = [];
  rows.push(`<div class="cc-name">${escapeHtml(s.kind.replace(/_/g, " "))}</div>`);
  rows.push(`<div class="cc-chips">${chip(s.role || "—")}${chip(building ? "building" : st.complete !== undefined ? "complete" : "placed")}${chip(`${s.x},${s.y}`)}</div>`);
  if (building) {
    const pct = Math.round((progress / req) * 100);
    rows.push(`<div class="cc-bars">${statBar("progress", pct)}</div>`);
  }
  if (st.complete && typeof st.fuel === "number") {
    rows.push(`<div class="cc-bars">${statBar("fuel", st.fuel as number)}</div>`);
  }
  if (st.complete && st.cache && typeof st.cache === "object") {
    const cache = st.cache as Record<string, number>;
    const entries = Object.entries(cache);
    if (entries.length) rows.push(`<div class="cc-inv">${entries.map(([k, v]) => `<div class="cc-chip">${escapeHtml(k)}: ${Math.round(v)}</div>`).join("")}</div>`);
  }
  ccStructBody.innerHTML = rows.join("");
}

function chip(text: string) {
  return text ? `<span class="cc-chip">${escapeHtml(text)}</span>` : "";
}

// Provenance badge: at a glance, is the MODEL driving this agent, or the heuristic?
function sourceBadge(source: string): string {
  const label: Record<string, string> = {
    llm: "🧠 модель", emergency: "⚠ авто-выживание", llm_fallback_stub: "↩ эвристика (сбой LLM)",
    repair_stub: "🔧 эвристика (починка)", stub: "⚙ эвристика", wait: "⏸ ждёт",
  };
  const heuristic = source !== "llm";
  const cls = heuristic ? "src-heuristic" : "src-model";
  return `<span class="cc-source-badge ${cls}" title="кто принял решение">${escapeHtml(label[source] ?? source)}</span>`;
}

function genderLabel(gender?: string | null): string {
  if (gender === "female") return "женщина";
  if (gender === "male") return "мужчина";
  return "";
}

const app = new Application();
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
let glowT = 0;
let state: WorldState | null = null;
let previous: WorldState | null = null;
let selectedAgentId: string | null = null;
let selectedStructureId: string | null = null;
let simPaused = false;
let renderSeq = 0;
let fittedMapKey = "";
let isDragging = false;
let dragStart = { x: 0, y: 0 };
let cameraStart = { x: 0, y: 0 };
const camera = { x: 12, y: 12, scale: 1 };
const textureCache = new Map<string, Texture>();
const events: string[] = [];

async function init() {
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
  glowTex = makeGlowTexture();
  bindViewportControls();
  // Modal close bindings
  ccClose.addEventListener("click", closeModal);
  charModal.addEventListener("click", (e) => { if (e.target === charModal) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && modalIsOpen) closeModal(); });
  new ResizeObserver(() => {
    fitCamera(true);
    void render();
  }).observe(stageEl);

  // New-sim modal bindings
  const newSimModal = document.getElementById("newsim-modal") as HTMLDivElement;
  const newSimForm = document.getElementById("newsim-form") as HTMLFormElement;
  const newSimStatus = document.getElementById("newsim-status") as HTMLDivElement;
  const newSimCancel = document.getElementById("newsim-cancel") as HTMLButtonElement;
  const newSimSubmit = newSimForm.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  document.getElementById("newsim-cancel")!.addEventListener("click", () => { newSimModal.hidden = true; });
  newSimModal.addEventListener("click", (e) => { if (e.target === newSimModal) newSimModal.hidden = true; });
  // Model autocomplete in the new-sim modal follows its provider select.
  const nsProvider = document.getElementById("ns-provider") as HTMLSelectElement;
  nsProvider.addEventListener("change", () => void loadProviderModels(nsProvider.value));
  void loadProviderModels(nsProvider.value);
  newSimForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(newSimForm);
    const overrides: Record<string, unknown> = {
      scenario: fd.get("scenario"),
      seed: Number(fd.get("seed")),
      agents: Number(fd.get("agents")),
      days: Number(fd.get("days")),
      model: String(fd.get("model") ?? "").trim() || undefined,
      provider: fd.get("provider"),
    };
    newSimStatus.textContent = "Launching simulation...";
    newSimStatus.classList.remove("error");
    newSimCancel.disabled = true;
    newSimSubmit.disabled = true;
    try {
      await createSim(overrides);
      newSimModal.hidden = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      newSimStatus.textContent = `Launch failed: ${message}`;
      newSimStatus.classList.add("error");
      pushEvent(`create sim failed: ${message}`);
    } finally {
      newSimCancel.disabled = false;
      newSimSubmit.disabled = false;
    }
  });

  try {
    await initSims();
    await loadForgeConfig();
  } catch {
    pushEvent("API offline — retrying…");
    setTimeout(() => connectSim("default"), 2000);
  }
}

async function initSims(): Promise<void> {
  const res = await fetch(`${API_URL}/sims`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data: { sims: SimMeta[] } = await res.json();
  if (data.sims.length > 0) {
    activeSimId = data.sims.some((meta) => meta.sim_id === "default") ? "default" : data.sims[0].sim_id;
  }
  const snapUrl = activeSimId === "default" ? `${API_URL}/state` : `${API_URL}/sims/${activeSimId}/state`;
  const snap0 = await fetch(snapUrl).then((r) => r.json());
  simStates.set(activeSimId, snap0 as WorldState);
  await ensureManifest(activeSimId, (snap0 as WorldState).scenario);
  applyState(snap0 as WorldState);
  for (const meta of data.sims) {
    simMetaMap.set(meta.sim_id, meta);
    connectSim(meta.sim_id);
  }
  renderSimBar();
}

async function loadForgeConfig() {
  const res = await fetch(`${API_URL}/sims/${activeSimId}/config`);
  renderForge(await res.json());
}

// ── Model autocomplete (per provider) ─────────────────────────────────────────
const modelDatalist = (() => {
  const dl = document.createElement("datalist");
  dl.id = "model-options";
  document.body.appendChild(dl);
  return dl;
})();
const modelCache = new Map<string, string[]>();

async function loadProviderModels(provider: string): Promise<void> {
  if (!provider || provider === "stub") { modelDatalist.innerHTML = ""; return; }
  let models = modelCache.get(provider);
  if (!models) {
    try {
      const res = await fetch(`${API_URL}/providers/${provider}/models`);
      models = (await res.json()).models ?? [];
    } catch {
      models = [];
    }
    modelCache.set(provider, models!);
  }
  modelDatalist.innerHTML = models!.map((m) => `<option value="${escapeAttr(m)}"></option>`).join("");
}

let forgeCfg: ForgeConfig | null = null;

function rosterRowsHtml(count: number, cfg: ForgeConfig): string {
  const roster = cfg.agents.roster ?? [];
  let html = "";
  for (let i = 0; i < count; i += 1) {
    const model = roster[i]?.model ?? "stub";
    html += `
      <div class="roster-row">
        <span class="roster-label">#${i + 1}</span>
        <input name="rmodel_${i}" type="text" value="${escapeAttr(model)}" placeholder="stub / OpenRouter id">
      </div>`;
  }
  return html;
}

function renderForge(cfg: ForgeConfig) {
  forgeCfg = cfg;
  const count = cfg.agents.count;
  const prov = cfg.provider ?? "openrouter";
  forgeForm.innerHTML = `
    ${field("scenario", "scenario", `<select name="scenario">
      <option value="mars"${cfg.scenario === "mars" ? " selected" : ""}>mars</option>
      <option value="island"${cfg.scenario === "island" ? " selected" : ""}>island</option>
    </select>`)}
    ${field("seed", "seed", `<input name="seed" type="number" min="0" value="${cfg.seed}">`)}
    ${field("days", "days", `<input name="days" type="number" min="1" max="30" value="${cfg.sim.max_days}">`)}
    ${field("agents", "agents", `<input name="agents" type="number" min="1" max="12" value="${count}">`)}
    ${field("persona mode", "persona_mode", `<select name="persona_mode">
      ${["blank", "library", "self_select", "custom", "mixed"].map((m) =>
        `<option value="${m}"${(cfg.agents.persona_mode ?? "blank") === m ? " selected" : ""}>${m}</option>`).join("")}
    </select>`)}
    ${field("emergency gate ×", "emergency_multiplier", `<input name="emergency_multiplier" type="number" min="0" max="3" step="0.1" value="${cfg.sim.emergency_multiplier ?? 2.0}" title="crit×N band where the heuristic overrides the brain; research: ~1.2, 0 = off">`)}
    ${field("LLM fail →", "fallback_policy", `<select name="fallback_policy">
      <option value="stub"${(cfg.llm?.fallback_policy ?? "stub") === "stub" ? " selected" : ""}>stub (never stall)</option>
      <option value="wait"${(cfg.llm?.fallback_policy ?? "stub") === "wait" ? " selected" : ""}>wait (clean data)</option>
    </select>`)}
    ${field("anomaly", "anomaly", `<select name="anomaly">
      <option value="none">none</option>
      <option value="random">random (1)</option>
      <option value="hatch">hatch — button ritual</option>
      <option value="monolith">monolith — dread altar</option>
      <option value="idol">idol — offerings</option>
      <option value="whisperzone">whispering zone</option>
      <option value="relic">cursed relic</option>
    </select>`)}
    ${field("provider", "provider", `<select name="provider">
      <option value="openrouter"${prov === "openrouter" ? " selected" : ""}>OpenRouter</option>
      <option value="megallm"${prov === "megallm" ? " selected" : ""}>MegaLLM</option>
      <option value="stub"${prov === "stub" ? " selected" : ""}>Stub (free)</option>
    </select>`)}
    ${field("api tick", "api_tick_seconds", `<input name="api_tick_seconds" type="number" min="0" step="0.25" value="${cfg.sim.api_tick_seconds ?? 1}">`)}
    ${field("usd cap", "usd_cap", `<input name="usd_cap" type="number" min="0" step="0.01" value="${cfg.budget.usd_cap ?? 0}">`)}
    ${field("context", "context_tokens_per_agent_tick", `<input name="context_tokens_per_agent_tick" type="number" min="1024" step="1024" value="${cfg.budget.context_tokens_per_agent_tick ?? cfg.budget.tokens_per_agent_tick ?? 32000}">`)}
    ${field("output", "max_output_tokens", `<input name="max_output_tokens" type="number" min="128" step="128" value="${cfg.budget.max_output_tokens ?? 1024}">`)}
    ${field("model (all)", "model", `<input name="model" type="text" list="model-options" value="${escapeAttr(cfg.agents.model_override ?? "")}" placeholder="blank = use per-agent below">`, true)}
    <div class="field wide roster-block">
      <label>per-agent model — blank = use model (all) above (names are auto)</label>
      <div id="roster-rows">${rosterRowsHtml(count, cfg)}</div>
    </div>
    <button class="forge-submit" type="submit">Apply world</button>
  `;
  // Keep the per-agent rows in sync with the agent count.
  const agentsInput = forgeForm.querySelector<HTMLInputElement>('input[name="agents"]')!;
  const rowsEl = forgeForm.querySelector<HTMLDivElement>("#roster-rows")!;
  agentsInput.addEventListener("input", () => {
    const n = Math.max(1, Math.min(12, Number(agentsInput.value) || 1));
    rowsEl.innerHTML = rosterRowsHtml(n, forgeCfg!);
  });
  // Populate model autocomplete for the selected provider, refresh on change.
  const provSel = forgeForm.querySelector<HTMLSelectElement>('select[name="provider"]')!;
  void loadProviderModels(provSel.value);
  provSel.addEventListener("change", () => void loadProviderModels(provSel.value));
}

function field(label: string, name: string, control: string, wide = false) {
  return `<div class="field${wide ? " wide" : ""}"><label for="${name}">${label}</label>${control}</div>`;
}

forgeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = forgeForm.querySelector<HTMLButtonElement>("button")!;
  button.disabled = true;
  const form = new FormData(forgeForm);
  const count = Math.max(1, Math.min(12, Number(form.get("agents")) || 1));
  const roster: { name: string; model: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    // name left blank on purpose — each agent picks its own (see resolve_names).
    roster.push({ name: "", model: String(form.get(`rmodel_${i}`) ?? "stub").trim() || "stub" });
  }
  const payload = {
    scenario: form.get("scenario"),
    seed: form.get("seed"),
    days: form.get("days"),
    agents: count,
    provider: String(form.get("provider") ?? "openrouter"),
    api_tick_seconds: form.get("api_tick_seconds"),
    usd_cap: form.get("usd_cap"),
    context_tokens_per_agent_tick: form.get("context_tokens_per_agent_tick"),
    max_output_tokens: form.get("max_output_tokens"),
    model: String(form.get("model") ?? "").trim(),
    anomaly: String(form.get("anomaly") ?? "none"),
    persona_mode: String(form.get("persona_mode") ?? "blank"),
    emergency_multiplier: form.get("emergency_multiplier"),
    fallback_policy: String(form.get("fallback_policy") ?? "stub"),
    roster,
  };
  try {
    selectedAgentId = null;
    const res = await fetch(`${API_URL}/sims/${activeSimId}/config/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    applyState(await res.json());
    await loadForgeConfig();
    pushEvent("world applied");
  } catch {
    pushEvent("forge apply failed");
  } finally {
    button.disabled = false;
  }
});

function connectSim(simId: string): void {
  if (simSockets.has(simId)) return;
  const ws = new WebSocket(`${WS_BASE}/${simId}`);
  simSockets.set(simId, ws);
  ws.onmessage = (msg) => {
    const snap = JSON.parse(msg.data) as WorldState;
    simStates.set(simId, snap);
    // Update lightweight meta for tab display
    simMetaMap.set(simId, {
      sim_id: simId,
      scenario: snap.scenario,
      day: snap.day,
      alive: snap.agents.filter((a) => a.status !== "dead").length,
    });
    if (simId === activeSimId) applyState(snap);
    else renderSimBar();
  };
  ws.onclose = () => {
    simSockets.delete(simId);
    setTimeout(() => {
      if (simMetaMap.has(simId)) connectSim(simId);
    }, 2000);
  };
  ws.onerror = () => pushEvent(`sim ${simId} stream error`);
}

function renderSimBar(): void {
  const simbarEl = document.getElementById("simbar");
  if (!simbarEl) return;
  const sims = [...simMetaMap.values()];
  const canDelete = sims.length > 1;
  simbarEl.innerHTML =
    sims.map((m) => {
      const isActive = m.sim_id === activeSimId;
      const label = m.scenario ? `${m.scenario} D${m.day ?? 0}` : m.sim_id;
      return `
        <div class="sim-tab${isActive ? " active" : ""}" data-simid="${escapeAttr(m.sim_id)}">
          <span class="sim-tab-dot"></span>
          <span>${escapeHtml(label)}</span>
          <span class="sim-tab-alive">${m.alive ?? "?"} ♥</span>
          ${canDelete ? `<button class="sim-tab-close" data-close="${escapeAttr(m.sim_id)}" title="Delete simulation">✕</button>` : ""}
        </div>`;
    }).join("") +
    `<button class="btn-new-sim" id="btn-new-sim" title="New simulation">+</button>`;

  simbarEl.querySelectorAll<HTMLElement>(".sim-tab").forEach((tab) => {
    tab.addEventListener("click", (e) => {
      const close = (e.target as HTMLElement).closest(".sim-tab-close");
      if (close) return;
      switchSim(tab.dataset.simid!);
    });
  });
  simbarEl.querySelectorAll<HTMLElement>(".sim-tab-close").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      void deleteSim(btn.dataset.close!);
    });
  });
  document.getElementById("btn-new-sim")?.addEventListener("click", () => {
    const modal = document.getElementById("newsim-modal") as HTMLDivElement;
    const status = document.getElementById("newsim-status") as HTMLDivElement;
    status.textContent = "";
    status.classList.remove("error");
    modal.hidden = false;
  });
}

function switchSim(simId: string): void {
  if (simId === activeSimId) return;
  activeSimId = simId;
  // Reset pixi world state
  for (const vis of agentVis.values()) vis.container.destroy({ children: true });
  agentVis.clear();
  for (const id of [...agentDom.keys()]) removeAgentDom(id);
  fittedMapKey = "";
  selectedAgentId = null;
  selectedStructureId = null;
  cloudsForScenario = "";
  const snap = simStates.get(simId);
  if (snap) applyState(snap);
  renderSimBar();
  void loadForgeConfig();
}

async function createSim(overrides: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${API_URL}/sims`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ overrides }),
  });
  if (!res.ok) throw new Error(await responseErrorMessage(res));
  const meta: SimMeta = await res.json();
  simMetaMap.set(meta.sim_id, meta);
  try {
    const snap = await fetch(`${API_URL}/sims/${meta.sim_id}/state`).then((r) => r.json());
    simStates.set(meta.sim_id, snap as WorldState);
  } catch { /* websocket will hydrate shortly */ }
  connectSim(meta.sim_id);
  switchSim(meta.sim_id);
  pushEvent(`sim '${meta.sim_id}' launched`);
}

async function responseErrorMessage(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (typeof data?.detail === "string") return data.detail;
    return JSON.stringify(data);
  } catch {
    return `${res.status} ${res.statusText}`.trim();
  }
}

async function deleteSim(simId: string): Promise<void> {
  try {
    await fetch(`${API_URL}/sims/${simId}`, { method: "DELETE" });
  } catch { /* ignore if already gone */ }
  simSockets.get(simId)?.close();
  simSockets.delete(simId);
  simStates.delete(simId);
  simMetaMap.delete(simId);
  if (activeSimId === simId) {
    const next = [...simMetaMap.keys()][0] ?? "default";
    switchSim(next);
  } else {
    renderSimBar();
  }
  pushEvent(`sim '${simId}' deleted`);
}

function applyState(next: WorldState) {
  previous = state;
  state = next;
  if (next.scenario && !manifestByScenario.has(next.scenario)) {
    void ensureManifest(activeSimId, next.scenario);   // fire-and-forget; helpers fall back meanwhile
  }
  // Update simbar meta for the active sim
  simMetaMap.set(activeSimId, {
    sim_id: activeSimId,
    scenario: next.scenario,
    day: next.day,
    alive: next.agents.filter((a) => a.status !== "dead").length,
  });
  renderSimBar();
  const mapKey = `${next.scenario}:${next.map.size}`;
  if (mapKey !== fittedMapKey) {
    fittedMapKey = mapKey;
    fitCamera(true);
    // New world: drop persistent agent sprites so they respawn in place
    // instead of gliding across the map from their old tiles.
    for (const vis of agentVis.values()) vis.container.destroy({ children: true });
    agentVis.clear();
    for (const id of [...agentDom.keys()]) removeAgentDom(id);
    cloudsForScenario = "";          // rebuild clouds for the new world
    terrainDirty = true;             // re-bake land for the new world
    void setupClouds();
    sizeNight();
    app.renderer.background.color = next.scenario === "island" ? OCEAN_COLOR : VOID_COLOR;
  }
  if (!selectedAgentId && next.agents.length) {
    selectedAgentId = next.agents[0].id;
  }
  deriveEvents(previous, next);
  void render();
  renderChrome();
}

function bindViewportControls() {
  viewportTools.addEventListener("click", async (event) => {
    const target = event.target as HTMLButtonElement;
    const action = target.dataset.zoom;
    if (action === "in") zoomAt(1.2, stageEl.clientWidth / 2, stageEl.clientHeight / 2);
    if (action === "out") zoomAt(1 / 1.2, stageEl.clientWidth / 2, stageEl.clientHeight / 2);
    if (action === "reset") fitCamera(true);
    if (target.dataset.control === "pause") {
      const next = !simPaused;
      try {
        const res = await fetch(`${API_URL}/sims/${activeSimId}/control`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: next ? "pause" : "resume" }),
        });
        simPaused = (await res.json()).paused;
        target.textContent = simPaused ? "▶ Resume" : "⏸ Pause";
        target.classList.toggle("paused", simPaused);
        pushEvent(simPaused ? "paused — model calls stopped" : "resumed");
      } catch {
        pushEvent("pause/resume failed");
      }
    }
  });

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

function fitCamera(force = false) {
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

// ── animated agents ───────────────────────────────────────────────────────────
// Persistent per-agent sprite that smoothly walks tile-to-tile and plays the
// directional walk cycle, instead of teleporting and recreating sprites.
type Dir = "down" | "up" | "left" | "right";

type AgentVis = {
  container: Container;
  sprite: Sprite;
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

// ── per-agent colour (stable hue from id) ─────────────────────────────────────
function agentHue(id: string): number {
  const n = parseInt(id.replace(/[^0-9]/g, ""), 10);
  return ((Number.isFinite(n) ? n : 0) * 360) / 12 % 360;   // 12 distinct slots
}

function hslToRgbInt(h: number, s: number, l: number): number {
  const sn = s / 100, ln = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => ln - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  const r = Math.round(f(0) * 255), g = Math.round(f(8) * 255), b = Math.round(f(4) * 255);
  return (r << 16) | (g << 8) | b;
}

function agentTint(id: string): number { return hslToRgbInt(agentHue(id), 62, 66); }
function agentCss(id: string): string { return `hsl(${agentHue(id)} 80% 70%)`; }       // on dark
function agentCssInk(id: string): string { return `hsl(${agentHue(id)} 70% 38%)`; }    // on light

function agentPrefix(): string {
  return state?.scenario === "island" ? "castaway" : "suit";
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
      if (island) {
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
      sprite.eventMode = "static";
      sprite.cursor = "pointer";
      let lastTapId = "";
      let lastTapT = 0;
      sprite.on("pointertap", () => {
        const now = Date.now();
        const dbl = now - lastTapT < 280 && lastTapId === a.id;
        lastTapT = now; lastTapId = a.id;
        selectedAgentId = a.id;
        selectedStructureId = null;
        if (dbl) { openAgentModal(a.id); return; }
        renderChrome();
        syncAgents();
      });
      container.addChild(shadow, ring, sprite);
      container.x = px;
      container.y = py;
      agentLayer.addChild(container);
      vis = {
        container, sprite, ring,
        px, py, sx: px, sy: py, tx: px, ty: py,
        lx: a.x, ly: a.y, dir: "down", moving: false, moveElapsed: 0, moveDur: MOVE_DURATION,
        frame: 0, frameT: 0, status: a.status, isPawn: island, pawnColor,
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
    vis.ring.visible = a.id === selectedAgentId;
    vis.sprite.alpha = a.status === "dead" ? 0.5 : 1;
    if (a.status === "dead" || a.status === "incapacitated") {
      vis.moving = false;
    }

    // Name + speech bubble are HTML overlay elements (crisp, zoom-independent).
    const dom = ensureAgentDom(a.id, a.name);
    if (a.status === "dead") dom.wrap.classList.add("dead");
    else dom.wrap.classList.remove("dead");
    if (a.said && a.said !== dom.lastSaid) {
      dom.lastSaid = a.said;
      dom.bubbleEl.textContent = a.said;
      dom.bubbleEl.classList.add("show");
      dom.ttl = 6;
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
type AgentDom = { wrap: HTMLDivElement; nameEl: HTMLDivElement; bubbleEl: HTMLDivElement; ttl: number; lastSaid: string };
const agentDom = new Map<string, AgentDom>();

function ensureAgentDom(id: string, name: string): AgentDom {
  let d = agentDom.get(id);
  if (!d) {
    const wrap = document.createElement("div");
    wrap.className = "agent-ov";
    const bubbleEl = document.createElement("div");
    bubbleEl.className = "agent-bubble";
    const nameEl = document.createElement("div");
    nameEl.className = "agent-name";
    nameEl.style.background = agentCssInk(id);
    wrap.append(bubbleEl, nameEl);
    overlayEl.appendChild(wrap);
    d = { wrap, nameEl, bubbleEl, ttl: 0, lastSaid: "" };
    agentDom.set(id, d);
  }
  d.nameEl.textContent = name;
  return d;
}

function removeAgentDom(id: string): void {
  const d = agentDom.get(id);
  if (d) { d.wrap.remove(); agentDom.delete(id); }
}

// Position each agent's name + bubble just above its head, in screen space.
function updateOverlay(): void {
  const dt = app.ticker.deltaMS / 1000;
  const sc = camera.scale;
  for (const [id, d] of agentDom) {
    const vis = agentVis.get(id);
    if (!vis) continue;
    if (d.ttl > 0) {
      d.ttl -= dt;
      if (d.ttl <= 0) d.bubbleEl.classList.remove("show");
    }
    const sx = mapRoot.position.x + (vis.px + 16) * sc;
    const sy = mapRoot.position.y + (vis.py + (vis.isPawn ? -14 : -2)) * sc;
    d.wrap.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -100%)`;
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

    if (vis.isPawn) {
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

function structureSpriteName(kind: string): string {
  return `${state?.scenario ?? "mars"}_${kind}.png`;
}

// Render scale for structure sprites (small props shouldn't fill their footprint).
const STRUCT_RENDER_SCALE: Record<string, number> = {
  campfire: 1.3, signal_fire: 0.85, tent: 0.9, lean_to: 0.9,
  water_still: 0.85, store: 0.85,
  // new functional / natural / anomaly structures
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
  const sc = state?.scenario ?? "mars";
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

async function silentTexture(path: string): Promise<Texture | null> {
  try {
    return await texture(path);
  } catch {
    return null;
  }
}

// Themed placeholder for a structure with no sprite yet (works before art lands).
function structurePlaceholder(s: StructureState, px: number, py: number, pw: number, ph: number): Graphics {
  const st = s.state || {};
  const building = st.buildable_kind !== undefined && !st.complete;
  let color = 0x3f6c53;
  if (s.kind === "campfire") color = building ? 0x6b5230 : ((st.fuel as number ?? 0) > 0 ? 0xe2641f : 0x555048);
  else if (s.kind === "tent") color = building ? 0x7a6a3a : 0xb89a5a;
  const g = new Graphics().roundRect(px + 2, py + 2, pw - 4, ph - 4, 4)
    .fill({ color, alpha: building ? 0.55 : 0.9 })
    .stroke({ width: 2, color: 0x1a2a22 });
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

function agentIndex(id: string): number {
  const n = parseInt(id.replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
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

async function setupClouds(): Promise<void> {
  if (!state || cloudsForScenario === state.scenario) return;
  cloudsForScenario = state.scenario;
  cloudLayer.removeChildren();
  cloudSprites.length = 0;
  if (state.scenario !== "island") return;           // clouds only on the island for now
  if (!cloudTex.length) {
    for (let i = 1; i <= 8; i += 1) {
      const t = await tinyTexture(`cloud${i}.png`);
      if (t) cloudTex.push(t);
    }
  }
  if (!cloudTex.length) return;
  const mapPx = state.map.size * TILE_SIZE;
  for (let i = 0; i < ISLAND_CLOUD_COUNT; i += 1) {
    const tex = cloudTex[Math.floor(Math.random() * cloudTex.length)];
    const s = new Sprite(tex);
    s.alpha = 0.26 + Math.random() * 0.08;
    s.scale.set((TILE_SIZE * 11) / tex.frame.width);  // ~11 tiles wide — big & soft
    s.scale.set((TILE_SIZE * (8 + Math.random() * 5)) / tex.frame.width);
    s.x = Math.random() * mapPx;
    s.y = Math.random() * mapPx;
    cloudLayer.addChild(s);
    cloudSprites.push({ sprite: s, vx: 4 + Math.random() * 6 });
  }
}

function animateClouds(): void {
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
  g.addColorStop(0, "rgba(255,220,140,0.95)");
  g.addColorStop(0.35, "rgba(255,160,50,0.55)");
  g.addColorStop(1, "rgba(255,120,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return Texture.from(c);
}

// Warm flicker on every lit fire's glow sprite.
function animateGlow(): void {
  if (!glowSprites.length) return;
  glowT += app.ticker.deltaMS / 1000;
  const f = 0.8 + Math.sin(glowT * 7) * 0.12 + Math.sin(glowT * 13) * 0.06;
  for (const g of glowSprites) g.sprite.alpha = g.base * f;
}

function sizeNight(): void {
  if (!state) return;
  // Cover the whole tiled ocean, not just the island grid, so night falls on the sea too.
  const pad = OCEAN_PAD * TILE_SIZE;
  const span = state.map.size * TILE_SIZE + pad * 2;
  nightOverlay.clear().rect(-pad, -pad, span, span).fill(0x0a1838);
}

// Smoothly darken to a blue night (and dim a little during storms).
function animateNight(): void {
  if (!state) { nightOverlay.alpha = 0; return; }
  const dt = app.ticker.deltaMS / 1000;
  const target = state.is_night ? 0.5 : (state.weather === "storm" ? 0.22 : 0);
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
// props in the object layer. What you see IS what you harvest — when a node is
// chopped/mined out the backend drops it and it stops being drawn.
async function renderNodes(): Promise<void> {
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
  if (!state) return false;
  if (!(await loadIslandTerrain()) || !waterTex) return false;
  if (seq !== renderSeq) return true;
  const n = state.map.size;
  const grid = state.map.grid;
  const isWater = (x: number, y: number) =>
    x < 0 || y < 0 || x >= n || y >= n || grid[y][x].includes("water");

  // One large tiling ocean stretching far past the island in every direction, so
  // the land reads as a lonely island in an endless sea instead of a square of water.
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
  // ── Bake all land layers into ONE texture ──────────────────────────────────
  // Drawing hundreds of tile sprites and letting the camera scale them by a
  // fractional factor leaves 1px gaps between tiles (the white seams). A single
  // baked texture can't seam at any zoom. Terrain is static per world, so we
  // build it once and just re-add the cached sprite each frame.
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

    // Jungle: darker-green grass laid over the meadow on dense-foliage tiles,
    // using the SAME single-edge tiles so its boundary is one clean wavy line
    // (no inward double border). Smooth the mask so it makes no lone 1-tile fingers.
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

async function render() {
  if (!state) return;
  const seq = ++renderSeq;
  worldLayer.removeChildren();
  // Destroy last frame's props (nodes + structures); agents persist & animate.
  for (const p of propSprites) p.destroy();
  propSprites.length = 0;
  updateCamera();

  const islandDrawn = state.scenario === "island" ? await renderIslandTerrain(seq) : false;
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
    await renderNodes();
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

    // Contact shadow grounding the structure.
    const shadow = new Graphics()
      .ellipse(0, 0, pw * 0.36, pw * 0.16).fill({ color: 0x10240f, alpha: 0.22 });
    const shadowLift = STRUCT_SHADOW_LIFT[s.kind] ?? 3;
    shadow.x = px + pw / 2; shadow.y = py + ph - shadowLift; shadow.zIndex = py + ph - 0.5;
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
    for (const cand of structureSpriteCandidates(s)) {
      t = await silentTexture(`structures/${cand}`);
      if (seq !== renderSeq) return;
      if (t) break;
    }

    let node: Sprite | Graphics;
    if (t) {
      const sprite = new Sprite(t);
      const scale = STRUCT_RENDER_SCALE[s.kind] ?? 1.0;
      sprite.anchor.set(0.5, 1);                       // bottom-centre on the footprint
      sprite.width = pw * scale; sprite.height = ph * scale;
      sprite.x = px + pw / 2; sprite.y = py + ph;
      node = sprite;
    } else {
      node = structurePlaceholder(s, px, py, pw, ph);
    }
    node.eventMode = "static";
    node.cursor = "pointer";
    node.on("pointertap", () => {
      selectedStructureId = selectedStructureId === s.id ? null : s.id;
      if (selectedStructureId) openStructModal(s);
      else closeModal();
      void render();
    });
    node.zIndex = py + ph;                    // depth-sort by the structure's base
    objectLayer.addChild(node);
    propSprites.push(node);

    if (s.id === selectedStructureId) {
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

  if (state.scenario === "island") {
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

function renderChrome() {
  if (!state) return;
  const scenarioName = state.scenario.charAt(0).toUpperCase() + state.scenario.slice(1);
  titleEl.textContent = activeSimId === "default" ? scenarioName : `${scenarioName} · ${activeSimId}`;
  statsEl.innerHTML = [
    pill("day", `${state.day} · T${state.tick}`),
    pill("phase", state.is_night ? "night" : "day"),
    pill("weather", state.weather ?? "clear"),
    pill("escape", `${Math.round(state.escape_progress)}`),
    pill("agents", `${state.agents.filter((a) => a.status !== "dead").length}/${state.agents.length}`),
  ].join("");
  legendEl.innerHTML = [
    legend("resources", state.resources.filter((r) => r.quantity > 0).length),
    legend("structures", state.structures.length),
    legend("winner", state.escape_winner ?? "-"),
  ].join("");

  const struct = selectedStructureId
    ? state.structures.find((s) => s.id === selectedStructureId) ?? null
    : null;
  const agent = state.agents.find((a) => a.id === selectedAgentId) ?? state.agents[0];
  renderMetrics();
  renderChronicle();
  renderEvents();
  refreshModal();
}

function renderChronicle() {
  if (!chronicleEl) return;
  const ch = state?.chronicle ?? [];
  const saga = state?.saga ?? [];
  if (!ch.length && !saga.length) {
    chronicleEl.innerHTML = `<div class="chronicle-empty">Сага ещё не началась…</div>`;
    return;
  }
  // Narrator's literary voice on top (newest fragment first), then raw chronicle.
  const sagaHtml = [...saga].reverse().slice(0, 3).map((s) =>
    `<div class="saga-entry"><span class="ch-day">Дн.${s.day}</span>` +
    `<span class="saga-text">${escapeHtml(s.text)}</span></div>`).join("");
  const chHtml = [...ch].reverse().slice(0, 16).map((e) =>
    `<div class="chronicle-entry ch-${escapeAttr(e.kind)}">` +
      `<span class="ch-day">Дн.${e.day}</span>` +
      `<span class="ch-text">${escapeHtml(e.text)}</span>` +
    `</div>`).join("");
  chronicleEl.innerHTML = sagaHtml + chHtml;
}

function pill(label: string, value: string) {
  return `<div class="stat-pill">${label}<strong>${escapeHtml(value)}</strong></div>`;
}

function legend(label: string, value: string | number) {
  return `<div class="legend-item">${label}: ${escapeHtml(String(value))}</div>`;
}

// renderAgent / renderStructure are now handled by the character modal (B2 fix).
// Left as no-ops so any lingering call sites don't throw.
function renderAgent(_agent: AgentState | undefined) { /* content lives in modal */ }
function renderStructure(_s: StructureState) { /* content lives in modal */ }

function renderMetrics() {
  if (!state) return;
  const labels: Record<string, string> = {
    population_survival_rate: "survival",
    safety: "safety",
    map_exploration_coverage: "exploration",
    tool_usage_diversity: "tools",
    governance_participation_rate: "governance",
    cultural_output: "culture",
    social_graph_density: "social graph",
    economic_activity: "economy",
    escape_progress: "escape",
  };
  const rows = Object.entries(labels)
    .map(([key, label]) => metricRow(label, state!.metrics.indicators[key] ?? 0))
    .join("");
  metricsEl.innerHTML = `
    ${rows}
    ${metricRow("gini inventory", state.metrics.gini_inventory)}
    <div class="line-item">barter: ${state.metrics.barter_count}</div>
    <div class="line-item">tools: ${Object.keys(state.metrics.tool_usage).length}</div>
    ${provenanceLine(state.provenance)}
  `;
}

// The headline research indicator: how much of this run the MODEL actually drove.
// A high heuristic share means the emergent behaviour is the stub's, not the LLM's.
function provenanceLine(p: WorldState["provenance"]): string {
  if (!p || !p.total) return "";
  const modelPct = Math.round((1 - p.heuristic_share) * 100);
  const heurPct = 100 - modelPct;
  const cls = p.heuristic_share > 0.2 ? "prov-warn" : "prov-ok";
  return `<div class="line-item prov-line ${cls}" title="доля решений от модели vs эвристики">`
    + `авторство: 🧠 ${modelPct}% · ⚙ ${heurPct}%</div>`;
}

function metricRow(label: string, value: number) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return `
    <div class="metric-row">
      <div>
        <div class="metric-label">${escapeHtml(label)}</div>
        <div class="metric-track"><span style="width:${pct}%"></span></div>
      </div>
      <div class="metric-value">${pct}%</div>
    </div>
  `;
}

function statBar(label: string, value: number) {
  const v = Math.max(0, Math.min(100, value));
  const danger = v < 30 ? " danger" : "";
  return `
    <div class="bar-row">
      <span>${escapeHtml(label)}</span>
      <div class="bar${danger}"><span style="width:${v}%"></span></div>
      <span>${Math.round(v)}</span>
    </div>
  `;
}

function deriveEvents(prev: WorldState | null, next: WorldState) {
  if (!prev) {
    pushEvent(`D${next.day} T${next.tick}: ${next.scenario} stream opened`);
    return;
  }
  if (prev.weather !== next.weather) {
    pushEvent(`D${next.day} T${next.tick}: weather ${next.weather ?? "clear"}`);
  }
  if (!prev.escaped && next.escaped) {
    pushEvent(`D${next.day} T${next.tick}: escape by ${next.escape_winner ?? "unknown"}`);
  }
  for (const agent of next.agents) {
    const old = prev.agents.find((a) => a.id === agent.id);
    if (!old) continue;
    if (old.status !== agent.status) {
      pushEvent(`D${next.day} T${next.tick}: ${agent.name} ${agent.status}`);
    }
  }
}

function pushEvent(text: string) {
  events.unshift(text);
  events.splice(18);
  renderEvents();
}

function renderEvents() {
  // A typeset transcript: system notes first, then the feed oldest→newest so the
  // latest line lands at the bottom. No cards, no stripes — just a script column.
  const atBottom = eventsEl.scrollHeight - eventsEl.scrollTop - eventsEl.clientHeight < 48;
  const sys = events.slice(0, 3).reverse().map((e) => `<div class="log-sys">${escapeHtml(e)}</div>`).join("");
  const feed = (state?.feed ?? []).slice(-26).map(feedLine).join("");
  eventsEl.innerHTML = (sys + feed) || `<p class="empty">Тихо. Пока ничего не произошло.</p>`;
  if (atBottom) eventsEl.scrollTop = eventsEl.scrollHeight;
}

function feedLine(f: FeedEntry): string {
  const sel = f.agent_id === selectedAgentId ? " is-sel" : "";
  const t = `<span class="log-t">${f.tick}</span>`;
  const name = `<span class="log-name" style="color:${agentCssInk(f.agent_id)}">${escapeHtml(f.agent)}</span>`;
  if (f.kind === "speech") {
    return `<div class="log-entry${sel}">${t}<div class="log-body">${name}<span class="log-quote">«${escapeHtml(f.result)}»</span></div></div>`;
  }
  const think = f.thought ? `<span class="log-quote">${escapeHtml(f.thought)}</span>` : "";
  const act = `<span class="log-do">${escapeHtml(f.tool)} · ${escapeHtml(f.result)}</span>`;
  return `<div class="log-entry log-act-entry${sel}">${t}<div class="log-body">${name}${think}${act}</div></div>`;
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (ch) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return map[ch];
  });
}

function escapeAttr(text: string) {
  return escapeHtml(text).replace(/`/g, "&#096;");
}

void init();
