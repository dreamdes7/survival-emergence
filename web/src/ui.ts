// DOM chrome: modals, panels, forge, sim bar, event ticker. No Pixi in here.
// Navigation actions that live in net.ts are injected via `nav` (wired in main.ts)
// to keep the module graph acyclic: ui never imports net or render.

import { applyConfigReq, fetchProviderModels } from "./api";
import { requiredProgress, store } from "./store";
import { setInterviewAgent } from "./interview";
import { agentCssInk, escapeAttr, escapeHtml, genderLabel, intentIcon } from "./utils";
import { applyPreset, FILM_LABELS, FILM_PROFILES, gfx, PRESETS, saveGfx } from "./gfx";
import { enhanceNumberInputs, enhanceSelects } from "./widgets";
import type { AgentState, FeedEntry, ForgeConfig, StructureState, WorldState } from "./types";

// ── injected navigation (main.ts assigns the real implementations) ────────────
export const nav = {
  switchSim: (_id: string): void => { /* wired in main */ },
  deleteSim: (_id: string): Promise<void> => Promise.resolve(),
  createSim: (_overrides: Record<string, unknown>): Promise<void> => Promise.resolve(),
  loadForgeConfig: (): Promise<void> => Promise.resolve(),
  applyState: (_s: WorldState): void => { /* wired in main */ },
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
export const stageEl = document.querySelector<HTMLDivElement>("#stage")!;
const titleEl = document.querySelector<HTMLHeadingElement>("#world-title")!;
const statsEl = document.querySelector<HTMLDivElement>("#world-stats")!;
const forgeForm = document.querySelector<HTMLFormElement>("#forge-form")!;
const metricsEl = document.querySelector<HTMLDivElement>("#metrics-dashboard")!;
const eventsEl = document.querySelector<HTMLElement>("#event-log")!;
const chronicleEl = document.querySelector<HTMLDivElement>("#chronicle");
export const viewportTools = document.querySelector<HTMLDivElement>("#viewport-tools")!;

// Character modal elements
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

// Live inspector (bottom-center HUD for the selected/followed survivor)
const inspectorEl = document.querySelector<HTMLDivElement>("#inspector")!;
const inspSwatch = document.querySelector<HTMLSpanElement>("#insp-swatch")!;
const inspIntent = document.querySelector<HTMLSpanElement>("#insp-intent")!;
const inspName = document.querySelector<HTMLSpanElement>("#insp-name")!;
const inspChips = document.querySelector<HTMLSpanElement>("#insp-chips")!;
const inspCog = document.querySelector<HTMLDivElement>("#insp-cog")!;
const inspBars = document.querySelector<HTMLDivElement>("#insp-bars")!;

let modalAgentId: string | null = null;
export let modalIsOpen = false;

// ── modal lifecycle ───────────────────────────────────────────────────────────
export function openAgentModal(id: string) {
  modalAgentId = id;
  modalIsOpen = true;
  ccAgentView.hidden = false;
  ccStructView.hidden = true;
  charModal.hidden = false;
  setInterviewAgent(id);
  refreshModal();
}

export function openStructModal(s: StructureState) {
  modalAgentId = null;
  modalIsOpen = true;
  ccAgentView.hidden = true;
  ccStructView.hidden = false;
  charModal.hidden = false;
  renderStructureModal(s);
}

export function closeModal() {
  modalIsOpen = false;
  charModal.hidden = true;
  modalAgentId = null;
}

export function refreshModal() {
  if (!modalIsOpen || !store.state) return;
  if (modalAgentId) {
    const agent = store.state.agents.find((a) => a.id === modalAgentId);
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
    agent.plan ? `<div class="cc-cog-line cc-plan">🗺 ${escapeHtml(agent.plan.goal)}${agent.plan.steps.length ? ` <span class="cc-plan-steps">(${escapeHtml(agent.plan.steps.join(" → "))})</span>` : ""}</div>` : "",
    agent.decision_source ? `<div class="cc-cog-line cc-source">${sourceBadge(agent.decision_source)}</div>` : "",
  ].join("") || `<div class="cc-empty">No activity yet.</div>`;

  const oldScrollTop = ccDiary.scrollTop;
  const psy = agent.psyche ?? {};
  const psyLabel: Record<string, string> = { belonging: "belonging", esteem: "esteem", purpose: "purpose" };
  ccBars.innerHTML = Object.entries(agent.physiology).map(([k, v]) => statBar(k, v)).join("")
    + (Object.keys(psy).length
        ? `<div class="cc-drives-label">Drives (beyond survival)</div>`
          + Object.entries(psy).map(([k, v]) => statBar(psyLabel[k] ?? k, v)).join("")
        : "");
  ccInv.innerHTML = Object.keys(agent.inventory).length
    ? Object.entries(agent.inventory).map(([k, v]) => `<div class="cc-chip">${escapeHtml(k)}: ${Math.round(v)}</div>`).join("")
    : `<div class="cc-empty">Empty.</div>`;

  const skills = agent.skills ?? {};
  const skEntries = Object.entries(skills).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  ccSkills.innerHTML = skEntries.length
    ? skEntries.map(([k, v]) => `<div class="cc-chip">${escapeHtml(k)} · ${Math.round(v)}</div>`).join("")
    : `<div class="cc-empty">Hasn't found a craft yet.</div>`;

  const beliefs = agent.beliefs ?? [];
  ccBeliefs.innerHTML = beliefs.length
    ? beliefs.map((b) => {
        const cls = b.trust > 0.3 ? "trust-pos" : b.trust < -0.3 ? "trust-neg" : "trust-neu";
        const tags = b.tags?.length ? `<span class="cc-belief-tags">${escapeHtml(b.tags.join(", "))}</span>` : "";
        return `<div class="cc-belief ${cls}"><span class="cc-belief-name">${escapeHtml(b.name)}</span><span class="cc-belief-note">${escapeHtml(b.note)}</span>${tags}</div>`;
      }).join("")
    : `<div class="cc-empty">Hasn't formed opinions about others yet.</div>`;

  const rels = agent.relationships ?? [];
  ccRels.innerHTML = rels.length
    ? rels.map((r) => `<div class="cc-rel cc-rel-${r.label}"><span class="cc-rel-name">${escapeHtml(r.name)}</span><span class="cc-rel-label">${r.label}</span><span class="cc-rel-score">${Math.round(r.score * 100)}%</span></div>`).join("")
    : `<div class="cc-empty">No relationships yet.</div>`;

  ccDiary.innerHTML = agent.diary.length
    ? [...agent.diary].reverse().map(([tick, text]) => `<div class="cc-diary-line">T${tick}: ${escapeHtml(text)}</div>`).join("")
    : `<div class="cc-empty">No diary entries.</div>`;
  ccDiary.scrollTop = oldScrollTop;
  setInterviewAgent(agent.id);
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
    llm: "🧠 model", emergency: "⚠ auto-survival", llm_fallback_stub: "↩ heuristic (LLM failed)",
    repair_stub: "🔧 heuristic (repair)", stub: "⚙ heuristic", wait: "⏸ waiting",
  };
  const heuristic = source !== "llm";
  const cls = heuristic ? "src-heuristic" : "src-model";
  return `<span class="cc-source-badge ${cls}" title="who made this decision">${escapeHtml(label[source] ?? source)}</span>`;
}

// ── sim bar ───────────────────────────────────────────────────────────────────
export function renderSimBar(): void {
  const simbarEl = document.getElementById("simbar");
  if (!simbarEl) return;
  const sims = [...store.simMetaMap.values()];
  const canDelete = sims.length > 1;
  simbarEl.innerHTML =
    sims.map((m) => {
      const isActive = m.sim_id === store.activeSimId;
      const label = m.scenario ? `${m.scenario} D${m.day ?? 0}` : m.sim_id;
      return `
        <div class="sim-tab${isActive ? " active" : ""}" data-simid="${escapeAttr(m.sim_id)}">
          <span class="sim-tab-dot"></span>
          <span>${escapeHtml(label)}</span>
          <span class="sim-tab-alive">${m.alive ?? "?"} ♥</span>
          ${canDelete ? `<button class="sim-tab-close" data-close="${escapeAttr(m.sim_id)}" title="Delete simulation">✕</button>` : ""}
        </div>`;
    }).join("") +
    `<button class="btn-new-sim" id="btn-new-sim" title="New simulation" aria-label="New simulation"></button>`;

  simbarEl.querySelectorAll<HTMLElement>(".sim-tab").forEach((tab) => {
    tab.addEventListener("click", (e) => {
      const close = (e.target as HTMLElement).closest(".sim-tab-close");
      if (close) return;
      nav.switchSim(tab.dataset.simid!);
    });
  });
  simbarEl.querySelectorAll<HTMLElement>(".sim-tab-close").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      void nav.deleteSim(btn.dataset.close!);
    });
  });
  document.getElementById("btn-new-sim")?.addEventListener("click", () => openNewSim());
}

// ── model autocomplete (per provider) ─────────────────────────────────────────
const modelDatalist = (() => {
  const dl = document.createElement("datalist");
  dl.id = "model-options";
  document.body.appendChild(dl);
  return dl;
})();
const modelCache = new Map<string, string[]>();

export async function loadProviderModels(provider: string): Promise<void> {
  if (!provider || provider === "stub") { modelDatalist.innerHTML = ""; return; }
  let models = modelCache.get(provider);
  if (!models) {
    models = await fetchProviderModels(provider);
    modelCache.set(provider, models);
  }
  modelDatalist.innerHTML = models.map((m) => `<option value="${escapeAttr(m)}"></option>`).join("");
}

// ── World Forge ───────────────────────────────────────────────────────────────
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

// Sensible defaults for a brand-new simulation (used by the "+" launcher when
// no config has loaded yet).
const DEFAULT_FORGE: ForgeConfig = {
  scenario: "island", seed: 0, provider: "openrouter",
  sim: { max_days: 4, api_tick_seconds: 1, emergency_multiplier: 1.0 },
  llm: { fallback_policy: "stub", thinking: "full" },
  agents: { count: 5, model_override: "", persona_mode: "blank", roster: [] },
  budget: { usd_cap: 0, context_tokens_per_agent_tick: 32000, max_output_tokens: 1024 },
};

// The full parameter form — the SINGLE set of controls, used both by the World
// Forge (reconfigure the running sim) and the New-sim launcher (create a fresh
// one). No more "4 fields at creation, everything else only after launch".
function forgeFieldsHtml(cfg: ForgeConfig): string {
  const count = cfg.agents.count;
  const prov = cfg.provider ?? "openrouter";
  return `
    <div class="forge-section">
      <div class="forge-section-title">World</div>
      ${field("Scenario", "scenario", `<select name="scenario">
        <option value="mars"${cfg.scenario === "mars" ? " selected" : ""}>Mars</option>
        <option value="island"${cfg.scenario === "island" ? " selected" : ""}>Island</option>
      </select>`)}
      ${field("Seed", "seed", `<input name="seed" type="number" min="0" value="${cfg.seed}">`)}
      ${field("Days", "days", `<input name="days" type="number" min="1" max="30" value="${cfg.sim.max_days}">`)}
      ${field("Agents", "agents", `<input name="agents" type="number" min="1" max="12" value="${count}">`)}
      ${field("Persona mode", "persona_mode", `<select name="persona_mode">
        ${["blank", "library", "self_select", "custom", "mixed"].map((m) =>
          `<option value="${m}"${(cfg.agents.persona_mode ?? "blank") === m ? " selected" : ""}>${m}</option>`).join("")}
      </select>`)}
      ${field("Anomaly", "anomaly", `<select name="anomaly">
        <option value="none">None</option>
        <option value="random">Random (1)</option>
        <option value="hatch">Hatch — button ritual</option>
        <option value="monolith">Monolith — dread altar</option>
        <option value="idol">Idol — offerings</option>
        <option value="whisperzone">Whispering zone</option>
        <option value="relic">Cursed relic</option>
      </select>`)}
    </div>
    <div class="forge-section">
      <div class="forge-section-title">Agents &amp; AI</div>
      ${field("Provider", "provider", `<select name="provider">
        <option value="openrouter"${prov === "openrouter" ? " selected" : ""}>OpenRouter</option>
        <option value="megallm"${prov === "megallm" ? " selected" : ""}>MegaLLM</option>
        <option value="stub"${prov === "stub" ? " selected" : ""}>Stub (free)</option>
      </select>`)}
      ${field("Model (all)", "model", `<input name="model" type="text" list="model-options" value="${escapeAttr(cfg.agents.model_override ?? "")}" placeholder="blank = use per-agent below">`, true)}
      <div class="field wide roster-block">
        <label>Per-agent model <span class="hint">— blank uses model (all) above, names are auto</span></label>
        <div id="roster-rows">${rosterRowsHtml(count, cfg)}</div>
      </div>
      ${field("Thinking", "thinking", `<select name="thinking" title="split = cheap ticks + a day-plan every N ticks">
        <option value="full"${(cfg.llm?.thinking ?? "full") === "full" ? " selected" : ""}>full (every tick)</option>
        <option value="split"${(cfg.llm?.thinking ?? "full") === "split" ? " selected" : ""}>split (plan + fast)</option>
      </select>`)}
      ${field("Emergency override ×", "emergency_multiplier", `<input name="emergency_multiplier" type="number" min="0" max="3" step="0.1" value="${cfg.sim.emergency_multiplier ?? 1.0}" title="crit×N band where the heuristic overrides the brain; 1.0 = deathbed only, 0 = pure/off">`)}
      ${field("On LLM failure", "fallback_policy", `<select name="fallback_policy">
        <option value="stub"${(cfg.llm?.fallback_policy ?? "stub") === "stub" ? " selected" : ""}>stub (never stall)</option>
        <option value="wait"${(cfg.llm?.fallback_policy ?? "stub") === "wait" ? " selected" : ""}>wait (clean data)</option>
      </select>`)}
    </div>
    <details class="forge-advanced">
      <summary>Advanced budget</summary>
      <div class="forge-section">
        ${field("API tick (s)", "api_tick_seconds", `<input name="api_tick_seconds" type="number" min="0" step="0.25" value="${cfg.sim.api_tick_seconds ?? 1}">`)}
        ${field("USD cap", "usd_cap", `<input name="usd_cap" type="number" min="0" step="0.01" value="${cfg.budget.usd_cap ?? 0}">`)}
        ${field("Context tokens", "context_tokens_per_agent_tick", `<input name="context_tokens_per_agent_tick" type="number" min="1024" step="1024" value="${cfg.budget.context_tokens_per_agent_tick ?? cfg.budget.tokens_per_agent_tick ?? 32000}">`)}
        ${field("Output tokens", "max_output_tokens", `<input name="max_output_tokens" type="number" min="128" step="128" value="${cfg.budget.max_output_tokens ?? 1024}">`)}
      </div>
    </details>
  `;
}

// Keep the per-agent rows + model autocomplete live inside whichever form hosts
// the fields (the dock forge or the new-sim launcher).
function wireForgeForm(formEl: HTMLFormElement, cfg: ForgeConfig): void {
  const agentsInput = formEl.querySelector<HTMLInputElement>('input[name="agents"]')!;
  const rowsEl = formEl.querySelector<HTMLDivElement>("#roster-rows")!;
  agentsInput.addEventListener("input", () => {
    const n = Math.max(1, Math.min(12, Number(agentsInput.value) || 1));
    rowsEl.innerHTML = rosterRowsHtml(n, cfg);
  });
  const provSel = formEl.querySelector<HTMLSelectElement>('select[name="provider"]')!;
  void loadProviderModels(provSel.value);
  provSel.addEventListener("change", () => void loadProviderModels(provSel.value));
  enhanceSelects(formEl);
  enhanceNumberInputs(formEl);
}

// Build the full overrides payload from a filled forge form — shared by
// "apply to current" and "launch new", so both carry EVERY parameter.
function forgePayload(formEl: HTMLFormElement): Record<string, unknown> {
  const form = new FormData(formEl);
  const count = Math.max(1, Math.min(12, Number(form.get("agents")) || 1));
  const roster: { name: string; model: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    roster.push({ name: "", model: String(form.get(`rmodel_${i}`) ?? "stub").trim() || "stub" });
  }
  return {
    scenario: form.get("scenario"), seed: form.get("seed"), days: form.get("days"),
    agents: count, provider: String(form.get("provider") ?? "openrouter"),
    api_tick_seconds: form.get("api_tick_seconds"), usd_cap: form.get("usd_cap"),
    context_tokens_per_agent_tick: form.get("context_tokens_per_agent_tick"),
    max_output_tokens: form.get("max_output_tokens"),
    model: String(form.get("model") ?? "").trim(),
    anomaly: String(form.get("anomaly") ?? "none"),
    persona_mode: String(form.get("persona_mode") ?? "blank"),
    emergency_multiplier: form.get("emergency_multiplier"),
    fallback_policy: String(form.get("fallback_policy") ?? "stub"),
    thinking: String(form.get("thinking") ?? "full"),
    roster,
  };
}

export function renderForge(cfg: ForgeConfig) {
  forgeCfg = cfg;
  forgeForm.innerHTML = forgeFieldsHtml(cfg)
    + `<button class="forge-submit" type="submit">Apply to current</button>`;
  wireForgeForm(forgeForm, cfg);
}

function field(label: string, name: string, control: string, wide = false) {
  return `<div class="field${wide ? " wide" : ""}"><label for="${name}">${label}</label>${control}</div>`;
}

export function bindForgeSubmit(): void {
  forgeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = forgeForm.querySelector<HTMLButtonElement>("button")!;
    button.disabled = true;
    const payload = forgePayload(forgeForm);
    try {
      store.selectedAgentId = null;
      const snap = await applyConfigReq(store.activeSimId, payload);
      nav.applyState(snap);
      await nav.loadForgeConfig();
      pushEvent("world applied");
    } catch {
      pushEvent("forge apply failed");
    } finally {
      button.disabled = false;
    }
  });
}

// ── new-sim launcher (full forge in a modal) ───────────────────────────────────
const newSimModalEl = () => document.getElementById("newsim-modal") as HTMLDivElement;
const newSimFormEl = () => document.getElementById("newsim-form") as HTMLFormElement;

/** Open the launcher pre-filled with the full parameter set (from the current
 *  config, or defaults) so a new sim can be started with ANY option up front. */
export function openNewSim(): void {
  const cfg = forgeCfg ?? DEFAULT_FORGE;
  const form = newSimFormEl();
  form.innerHTML = forgeFieldsHtml(cfg)
    + `<div id="newsim-status" class="newsim-status" role="status" aria-live="polite"></div>`
    + `<div class="newsim-actions">`
    + `<button type="button" class="btn-cancel" data-newsim-cancel>Cancel</button>`
    + `<button type="submit" class="btn-create">Launch ✦</button></div>`;
  wireForgeForm(form, cfg);
  newSimModalEl().hidden = false;
}

export function bindNewSimModal(): void {
  const modal = newSimModalEl();
  const form = newSimFormEl();
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });
  document.getElementById("newsim-close")?.addEventListener("click", () => { modal.hidden = true; });
  form.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("[data-newsim-cancel]")) modal.hidden = true;
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = document.getElementById("newsim-status");
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const payload = forgePayload(form);
    if (status) { status.textContent = "Starting simulation…"; status.classList.remove("error"); }
    if (submit) submit.disabled = true;
    try {
      await nav.createSim(payload);
      modal.hidden = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (status) { status.textContent = `Failed to start: ${message}`; status.classList.add("error"); }
      pushEvent(`create sim failed: ${message}`);
    } finally {
      if (submit) submit.disabled = false;
    }
  });
}

export function bindModalClose(): void {
  ccClose.addEventListener("click", closeModal);
  charModal.addEventListener("click", (e) => { if (e.target === charModal) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && modalIsOpen) closeModal(); });
  // Click-to-copy for any [data-copy] chip (e.g. the run-id pill).
  document.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-copy]");
    if (!el) return;
    const text = el.getAttribute("data-copy") || "";
    const done = () => {
      el.classList.add("copied");
      setTimeout(() => el.classList.remove("copied"), 1100);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(done);
    else {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      ta.remove(); done();
    }
  });
}

// ── chrome / panels ───────────────────────────────────────────────────────────
export function renderChrome() {
  const state = store.state;
  if (!state) return;
  const scenarioName = state.scenario.charAt(0).toUpperCase() + state.scenario.slice(1);
  titleEl.textContent = store.activeSimId === "default" ? scenarioName : `${scenarioName} · ${store.activeSimId}`;
  statsEl.innerHTML = `
    <div class="ws-pills">
      <div class="stat-pill ws-title-pill">world
        <strong class="ws-title-val">
          <span>${escapeHtml(store.activeSimId === "default" ? scenarioName : `${scenarioName} · ${store.activeSimId}`)}</span>
          ${state.run_id ? copyIcon(state.run_id) : ""}
        </strong>
      </div>
      ${pill("day", `${state.day}`)}
      ${pill("tick", `${state.tick}`)}
      ${pill("phase", state.is_night ? "night" : "day")}
      ${pill("weather", state.weather ?? "clear")}
      ${pill("escape", `${Math.round(state.escape_progress)}`)}
      ${pill("agents", `${state.agents.filter((a) => a.status !== "dead").length}/${state.agents.length}`)}
    </div>
  `;

  renderMetrics();
  renderChronicle();
  renderEvents();
  refreshModal();
  renderInspector();
}

// The live inspector: a compact always-on card for whoever is selected (and the
// camera is following in 3D). It's the glanceable read on one survivor —
// thought, current action, plan, vitals — without the full modal covering the
// scene. Double-click / "Details →" still opens the deep card.
export function renderInspector() {
  const id = store.selectedAgentId;
  const agent = id ? store.state?.agents.find((a) => a.id === id) : null;
  if (!agent) { inspectorEl.hidden = true; return; }
  inspectorEl.hidden = false;

  inspSwatch.style.background = agentCssInk(agent.id);
  inspIntent.textContent = intentIcon(agent.status, agent.action);
  inspName.textContent = agent.name;
  inspChips.innerHTML = [
    agent.role ? `<span class="cc-chip cc-chip-role">${escapeHtml(agent.role)}</span>` : "",
    agent.status !== "active" ? chip(agent.status) : "",
    agent.following ? chip(`→ ${agent.following}`) : "",
  ].join("");

  inspCog.innerHTML = [
    agent.thought ? `<div class="cc-cog-line cc-thought">💭 ${escapeHtml(agent.thought)}</div>` : "",
    agent.action ? `<div class="cc-cog-line cc-action">▶ ${escapeHtml(agent.action)}</div>` : "",
    agent.plan?.goal ? `<div class="cc-cog-line cc-plan">🗺 ${escapeHtml(agent.plan.goal)}</div>` : "",
  ].join("") || `<div class="cc-empty">Still thinking…</div>`;

  // The three survival vitals that matter at a glance (skip niche physiology).
  const order = ["health", "hunger", "thirst", "energy", "oxygen", "warmth", "morale"];
  const phys = agent.physiology;
  const keys = order.filter((k) => k in phys).concat(
    Object.keys(phys).filter((k) => !order.includes(k)));
  inspBars.innerHTML = keys.slice(0, 4).map((k) => statBar(k, phys[k])).join("");
}

export function bindInspector(): void {
  document.querySelector<HTMLButtonElement>("#insp-close")!.addEventListener("click", () => {
    store.selectedAgentId = null;
    store.selectedStructureId = null;
    renderChrome();
  });
  document.querySelector<HTMLButtonElement>("#insp-more")!.addEventListener("click", () => {
    if (store.selectedAgentId) openAgentModal(store.selectedAgentId);
  });
}

// ── graphics / style panel ────────────────────────────────────────────────────
const gfxPanel = document.querySelector<HTMLDivElement>("#gfx-panel")!;
const gfxPresetsEl = document.querySelector<HTMLDivElement>("#gfx-presets")!;
const gfxControlsEl = document.querySelector<HTMLDivElement>("#gfx-controls")!;
const gfxBtn = document.querySelector<HTMLButtonElement>("#gfx-btn")!;

const PRESET_LABELS: Record<string, string> = { watercolor: "Watercolor", vintage: "Vintage", comic: "Comic", custom: "Custom" };
const GFX_SLIDERS: { key: string; label: string; min: number; max: number; step: number }[] = [
  { key: "ink", label: "Outline", min: 0, max: 2.5, step: 0.05 },
  { key: "inkWidth", label: "Outline thickness", min: 0, max: 3, step: 0.05 },
  { key: "posterAmt", label: "Cel shading (flat light)", min: 0, max: 1, step: 0.02 },
  { key: "posterLevels", label: "Light steps", min: 2, max: 8, step: 1 },
  { key: "halftone", label: "Shadow screentone (Ben-Day)", min: 0, max: 1, step: 0.02 },
  { key: "saturation", label: "Saturation", min: 0, max: 2, step: 0.02 },
  { key: "paper", label: "Paper grain", min: 0, max: 1.5, step: 0.02 },
  { key: "bloom", label: "Bloom", min: 0, max: 1, step: 0.02 },
  { key: "focus", label: "Depth of field", min: 0, max: 2, step: 0.05 },
  { key: "vignette", label: "Vignette", min: 0, max: 0.5, step: 0.01 },
  { key: "barrel", label: "Lens distortion", min: 0, max: 0.35, step: 0.01 },
  { key: "handheld", label: "Camera shake", min: 0, max: 2, step: 0.05 },
];
const GFX_FILM: { key: string; label: string; min: number; max: number; step: number }[] = [
  { key: "sepia", label: "Vintage (warm tone)", min: 0, max: 1, step: 0.02 },
  { key: "flicker", label: "Film flicker", min: 0, max: 1, step: 0.02 },
  { key: "weave", label: "Frame weave (gate)", min: 0, max: 1, step: 0.02 },
];
const GFX_TOGGLES: { key: string; label: string }[] = [
  { key: "viewfinder", label: "Viewfinder while following" },
];
// Render quality — a global, not a paint look (excluded from presets). Higher =
// more internal resolution super-sampled down = crisper, but more GPU load.
const GFX_QUALITY: { key: string; label: string; min: number; max: number; step: number }[] = [
  { key: "renderScale", label: "Render sharpness", min: 1, max: 2, step: 0.25 },
];
// Low-fi "A Short Hike" pass: chunky pixels + ordered dither. Also a global,
// not a paint look (excluded from presets). pixel=1 / dither=0 = off.
const GFX_PIXEL: { key: string; label: string; min: number; max: number; step: number }[] = [
  { key: "pixel", label: "Pixel size", min: 1, max: 8, step: 1 },
  { key: "colorBits", label: "Colour bits", min: 1, max: 8, step: 1 },
  { key: "dither", label: "Dither", min: 0, max: 1, step: 0.05 },
];

const fmtNum = (v: number, step: number) => (step >= 1 ? String(Math.round(v)) : v.toFixed(2));
const gfxNum = gfx as unknown as Record<string, number>;
const gfxBool = gfx as unknown as Record<string, boolean>;

function renderGfxPanel(): void {
  gfxPresetsEl.innerHTML = Object.keys(PRESETS).map((name) =>
    `<button type="button" class="gfx-preset ${gfx.preset === name ? "sel" : ""}" data-preset="${name}">`
    + `${escapeHtml(PRESET_LABELS[name] ?? name)}</button>`).join("");
  const sliderRow = (s: { key: string; label: string; min: number; max: number; step: number }) => {
    const v = gfxNum[s.key] ?? 0;
    const pct = ((v - s.min) / (s.max - s.min)) * 100;
    return `<div class="gfx-row"><label>${s.label}</label>`
      + `<span class="gfx-val" data-val="${s.key}">${fmtNum(v, s.step)}</span>`
      + `<input type="range" data-gfx="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${v}" style="--pct:${pct}%"></div>`;
  };
  const toggleRow = (key: string, label: string) =>
    `<button type="button" class="gfx-toggle-row${gfxBool[key] ? " on" : ""}" data-gfxt="${key}">`
    + `<span>${label}</span>`
    + `<span class="gfx-toggle-switch"><span class="gfx-toggle-knob"></span></span>`
    + `</button>`;
  const toggles = GFX_TOGGLES.map((t) => toggleRow(t.key, t.label)).join("");
  const filmOpts = Object.keys(FILM_PROFILES).map((k) =>
    `<option value="${k}" ${gfx.film === k ? "selected" : ""}>${FILM_LABELS[k] ?? k}</option>`).join("");
  const filmSelect = `<div class="gfx-row gfx-selrow"><label>Film profile</label>`
    + `<select id="gfx-film" class="gfx-select">${filmOpts}</select></div>`;
  gfxControlsEl.innerHTML = `<div class="gfx-sec">Quality</div>${GFX_QUALITY.map(sliderRow).join("")}`
    + `<div class="gfx-sec">Pixel / dither</div>${GFX_PIXEL.map(sliderRow).join("")}`
    + `<div class="gfx-sec">Style</div>${GFX_SLIDERS.map(sliderRow).join("")}`
    + toggleRow("inkSilhouette", "Outline whole objects only")
    + `<div class="gfx-sec">Film / vintage</div>${filmSelect}${GFX_FILM.map(sliderRow).join("")}${toggles}`;
  enhanceSelects(gfxControlsEl);
}

// Collapsible docks: one toggle handle per side (see .dock-toggle in
// styles.css) that stays at the panel's edge open or closed, plus the
// chronicle/activity tab switch.
export function bindDockUI(): void {
  const leftdock = document.getElementById("leftdock")!;
  const rightdock = document.getElementById("rightdock")!;
  const toggles: Record<string, HTMLButtonElement> = {
    left: document.querySelector<HTMLButtonElement>(".dock-toggle-l")!,
    right: document.querySelector<HTMLButtonElement>(".dock-toggle-r")!,
  };
  const setCollapsed = (side: string, collapsed: boolean) => {
    (side === "left" ? leftdock : rightdock).classList.toggle("collapsed", collapsed);
    toggles[side].classList.toggle("collapsed", collapsed);
  };
  document.querySelectorAll<HTMLButtonElement>("[data-toggle]").forEach((b) =>
    b.addEventListener("click", () => {
      const side = b.dataset.toggle!;
      setCollapsed(side, !b.classList.contains("collapsed"));
    }));

  const tabs = document.getElementById("left-tabs")!;
  tabs.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLButtonElement>(".dock-tab");
    if (!t) return;
    const name = t.dataset.tab!;
    tabs.querySelectorAll(".dock-tab").forEach((el) => el.classList.toggle("is-active", el === t));
    document.querySelectorAll<HTMLElement>(".tab-pane").forEach((p) =>
      p.classList.toggle("is-active", p.dataset.pane === name));
  });
}

export function bindGfxPanel(): void {
  const setOpen = (open: boolean) => {
    gfxPanel.hidden = !open;
    gfxBtn.classList.toggle("on", open);
    if (open) renderGfxPanel();
  };
  gfxBtn.addEventListener("click", () => setOpen(gfxPanel.hidden));
  document.querySelector<HTMLButtonElement>("#gfx-close")!.addEventListener("click", () => setOpen(false));
  gfxPresetsEl.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-preset]");
    if (!b) return;
    applyPreset(b.dataset.preset!);
    renderGfxPanel();
  });
  gfxControlsEl.addEventListener("input", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.gfx) {
      const key = t.dataset.gfx;
      gfxNum[key] = Number(t.value);
      const valEl = gfxControlsEl.querySelector(`[data-val="${key}"]`);
      if (valEl) valEl.textContent = fmtNum(Number(t.value), Number(t.step));
      const pct = ((Number(t.value) - Number(t.min)) / (Number(t.max) - Number(t.min))) * 100;
      t.style.setProperty("--pct", `${pct}%`);
      // render scale + low-fi pass are global knobs, not paint looks — don't
      // drop the active preset selection when one of them is the thing changed.
      if (key !== "renderScale" && key !== "pixel" && key !== "colorBits" && key !== "dither") {
        gfx.preset = "custom";
        gfxPresetsEl.querySelectorAll(".gfx-preset").forEach((el) => el.classList.remove("sel"));
      }
      saveGfx();
    } else if (t.id === "gfx-film") {
      gfx.film = t.value;
      saveGfx();
    }
  });
  gfxControlsEl.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-gfxt]");
    if (!btn) return;
    const key = btn.dataset.gfxt!;
    gfxBool[key] = !gfxBool[key];
    btn.classList.toggle("on", gfxBool[key]);
    saveGfx();
  });
}

function renderChronicle() {
  if (!chronicleEl) return;
  const ch = store.state?.chronicle ?? [];
  const saga = store.state?.saga ?? [];
  if (!ch.length && !saga.length) {
    chronicleEl.innerHTML = `<div class="chronicle-empty">The saga hasn't begun yet…</div>`;
    return;
  }
  // Narrator's literary voice on top (newest fragment first), then raw chronicle.
  const sagaHtml = [...saga].reverse().slice(0, 3).map((s) =>
    `<div class="saga-entry"><span class="ch-day">Day ${s.day}</span>` +
    `<span class="saga-text">${escapeHtml(s.text)}</span></div>`).join("");
  const chHtml = [...ch].reverse().slice(0, 16).map((e) =>
    `<div class="chronicle-entry ch-${escapeAttr(e.kind)}">` +
      `<span class="ch-day">Day ${e.day}</span>` +
      `<span class="ch-text">${escapeHtml(e.text)}</span>` +
    `</div>`).join("");
  chronicleEl.innerHTML = sagaHtml + chHtml;
}

function pill(label: string, value: string) {
  const cap = value.charAt(0).toUpperCase() + value.slice(1);
  return `<div class="stat-pill">${label}<strong>${escapeHtml(cap)}</strong></div>`;
}

// Icon-only copy button for the run id — the full id is rarely worth reading
// at a glance, only grabbing (to hand to an agent: "look at run <id>").
function copyIcon(value: string) {
  return `<button type="button" class="ws-copy" data-copy="${escapeAttr(value)}" `
    + `title="Copy run ID: ${escapeAttr(value)}" aria-label="Copy run ID">`
    + `<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>`
    + `</button>`;
}

function fact(label: string, value: string | number, note?: string) {
  return `<div class="fact-row"><span class="fact-label">${escapeHtml(label)}</span>`
    + `<span class="fact-val">${escapeHtml(String(value))}`
    + (note ? `<span class="fact-note"> ${escapeHtml(note)}</span>` : "") + `</span></div>`;
}

function sectionLabel(text: string) {
  return `<div class="stats-sec">${escapeHtml(text)}</div>`;
}

function renderMetrics() {
  const state = store.state;
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
    .map(([key, label]) => metricRow(label, state.metrics.indicators[key] ?? 0))
    .join("");
  metricsEl.innerHTML = `
    ${sectionLabel("Indicators")}
    ${rows}
    ${metricRow("gini inventory", state.metrics.gini_inventory)}
    ${sectionLabel("World")}
    ${fact("Resources", state.resources.filter((r) => r.quantity > 0).length)}
    ${fact("Structures", state.structures.length)}
    ${fact("Winner", state.escape_winner ?? "—")}
    ${fact("Barter trades", state.metrics.barter_count)}
    ${fact("Tools used", Object.keys(state.metrics.tool_usage).length)}
    ${cultureFacts(state.metrics.culture)}
    ${provenanceFacts(state.provenance)}
  `;
}

// Culture as data: memes that provably travelled, story chains + drift, beads.
function cultureFacts(c: WorldState["metrics"]["culture"]): string {
  if (!c) return "";
  const parts: string[] = [sectionLabel("Culture")];
  parts.push(fact("Memes", c.memes.count, c.memes.transmissions ? `(${c.memes.transmissions} spread)` : undefined));
  if (c.stories.chains) {
    parts.push(fact("Story chains", c.stories.chains));
    parts.push(fact("Retellings", c.stories.retellings, `(drift ${Math.round(c.stories.max_drift * 100)}%)`));
    if (c.stories.myths) parts.push(fact("Myths", c.stories.myths));
  }
  if (c.currency) {
    const item = c.currency.item.charAt(0).toUpperCase() + c.currency.item.slice(1);
    parts.push(fact(`${item} transfers`, c.currency.transfers));
    parts.push(fact(`${item} holders`, c.currency.holders));
  }
  const top = c.memes.top[0];
  if (top && top.carriers > 0) {
    parts.push(`<div class="meme-card" title="the most persistent meme">`
      + `<div class="meme-quote">"${escapeHtml(top.text)}"</div>`
      + `<div class="meme-meta">${escapeHtml(top.author)} · ${top.carriers} carrier${top.carriers !== 1 ? "s" : ""}</div>`
      + `</div>`);
  }
  return parts.join("");
}

// The headline research indicator: how much of this run the MODEL actually drove.
function provenanceFacts(p: WorldState["provenance"]): string {
  if (!p || !p.total) return "";
  const modelPct = Math.round((1 - p.heuristic_share) * 100);
  const heurPct = 100 - modelPct;
  const cls = p.heuristic_share > 0.2 ? "prov-warn" : "prov-ok";
  return sectionLabel("Provenance")
    + `<div class="prov-row ${cls}" title="share of decisions made by the model vs the heuristic">`
    + `<span class="prov-badge prov-model">🧠 Model <strong>${modelPct}%</strong></span>`
    + `<span class="prov-badge prov-heuristic">⚙ Heuristic <strong>${heurPct}%</strong></span>`
    + `</div>`;
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

// ── event ticker + feed ───────────────────────────────────────────────────────
export function deriveEvents(prev: WorldState | null, next: WorldState) {
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

export function pushEvent(text: string) {
  store.events.unshift(text);
  store.events.splice(18);
  renderEvents();
}

export function renderEvents() {
  // A typeset transcript: system notes first, then the feed oldest→newest so the
  // latest line lands at the bottom.
  const atBottom = eventsEl.scrollHeight - eventsEl.scrollTop - eventsEl.clientHeight < 48;
  const sys = store.events.slice(0, 3).reverse().map((e) => `<div class="log-sys">${escapeHtml(e)}</div>`).join("");
  const feed = (store.state?.feed ?? []).slice(-26).map(feedLine).join("");
  eventsEl.innerHTML = (sys + feed) || `<p class="empty">Quiet. Nothing has happened yet.</p>`;
  if (atBottom) eventsEl.scrollTop = eventsEl.scrollHeight;
}

function feedLine(f: FeedEntry): string {
  const sel = f.agent_id === store.selectedAgentId ? " is-sel" : "";
  const t = `<span class="log-t">${f.tick}</span>`;
  const name = `<span class="log-name" style="color:${agentCssInk(f.agent_id)}">${escapeHtml(f.agent)}</span>`;
  if (f.kind === "speech") {
    return `<div class="log-entry${sel}">${t}<div class="log-body">${name}<span class="log-quote">«${escapeHtml(f.result)}»</span></div></div>`;
  }
  const think = f.thought ? `<span class="log-quote">${escapeHtml(f.thought)}</span>` : "";
  const act = `<span class="log-do">${escapeHtml(f.tool)} · ${escapeHtml(f.result)}</span>`;
  return `<div class="log-entry log-act-entry${sel}">${t}<div class="log-body">${name}${think}${act}</div></div>`;
}
