// Survivor interviews (Sprint 2, FRONTIER_IDEAS 4.2): a chat box inside the
// agent modal. The agent answers from its own memories/beliefs via its own
// brain (POST /sims/{id}/agents/{aid}/interview). History is kept client-side
// per agent and sent along so the conversation threads.

import { interviewAgent, type InterviewTurn } from "./api";
import { store } from "./store";
import { escapeHtml } from "./utils";

const histories = new Map<string, InterviewTurn[]>();   // agentId -> turns
let currentAgentId: string | null = null;
let busy = false;

let logEl: HTMLDivElement;
let formEl: HTMLFormElement;
let inputEl: HTMLInputElement;
let sendBtn: HTMLButtonElement;

export function initInterview(): void {
  logEl = document.querySelector<HTMLDivElement>("#cc-iv-log")!;
  formEl = document.querySelector<HTMLFormElement>("#cc-iv-form")!;
  inputEl = document.querySelector<HTMLInputElement>("#cc-iv-input")!;
  sendBtn = formEl.querySelector<HTMLButtonElement>("button")!;
  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    void ask();
  });
}

// Called by the agent modal when it opens/refreshes for an agent.
export function setInterviewAgent(agentId: string): void {
  if (agentId === currentAgentId) return;
  currentAgentId = agentId;
  renderLog();
}

function renderLog(): void {
  if (!currentAgentId) return;
  const turns = histories.get(currentAgentId) ?? [];
  logEl.innerHTML = turns.length
    ? turns.map((t) =>
        `<div class="iv-turn iv-${t.role === "observer" ? "q" : "a"}">${escapeHtml(t.text)}</div>`,
      ).join("")
    : `<div class="cc-empty">Ask the survivor anything — they'll answer from their own memory.</div>`;
  logEl.scrollTop = logEl.scrollHeight;
}

async function ask(): Promise<void> {
  const agentId = currentAgentId;
  const question = inputEl.value.trim();
  if (!agentId || !question || busy) return;
  busy = true;
  sendBtn.disabled = true;
  inputEl.value = "";

  const turns = histories.get(agentId) ?? [];
  turns.push({ role: "observer", text: question });
  histories.set(agentId, turns);
  renderLog();
  logEl.insertAdjacentHTML("beforeend", `<div class="iv-turn iv-a iv-wait">…</div>`);
  logEl.scrollTop = logEl.scrollHeight;

  try {
    const r = await interviewAgent(store.activeSimId, agentId, question, turns.slice(0, -1));
    turns.push({ role: r.agent, text: r.answer });
  } catch (err) {
    turns.push({ role: "system", text: `failed to ask: ${err instanceof Error ? err.message : err}` });
  } finally {
    histories.set(agentId, turns);
    busy = false;
    sendBtn.disabled = false;
    renderLog();
  }
}
