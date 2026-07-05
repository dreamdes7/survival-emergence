// HTTP client: every fetch to the backend lives here (websockets live in net.ts).

import { API_URL } from "./constants";
import type { ForgeConfig, SimMeta, WorldState } from "./types";

export async function responseErrorMessage(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (typeof data?.detail === "string") return data.detail;
    return JSON.stringify(data);
  } catch {
    return `${res.status} ${res.statusText}`.trim();
  }
}

export function stateUrl(simId: string): string {
  return simId === "default" ? `${API_URL}/state` : `${API_URL}/sims/${simId}/state`;
}

export async function fetchSims(): Promise<{ sims: SimMeta[] }> {
  const res = await fetch(`${API_URL}/sims`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchState(simId: string): Promise<WorldState> {
  return fetch(stateUrl(simId)).then((r) => r.json());
}

export async function fetchForgeConfig(simId: string): Promise<ForgeConfig> {
  return fetch(`${API_URL}/sims/${simId}/config`).then((r) => r.json());
}

export async function fetchProviderModels(provider: string): Promise<string[]> {
  try {
    const res = await fetch(`${API_URL}/providers/${provider}/models`);
    return (await res.json()).models ?? [];
  } catch {
    return [];
  }
}

export async function applyConfigReq(simId: string, payload: unknown): Promise<WorldState> {
  const res = await fetch(`${API_URL}/sims/${simId}/config/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function createSimReq(overrides: Record<string, unknown>): Promise<SimMeta> {
  const res = await fetch(`${API_URL}/sims`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ overrides }),
  });
  if (!res.ok) throw new Error(await responseErrorMessage(res));
  return res.json();
}

export async function deleteSimReq(simId: string): Promise<void> {
  try {
    await fetch(`${API_URL}/sims/${simId}`, { method: "DELETE" });
  } catch { /* ignore if already gone */ }
}

export async function controlSim(simId: string, action: string): Promise<{ paused: boolean }> {
  const res = await fetch(`${API_URL}/sims/${simId}/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  return res.json();
}

// ── Sprint 2 features ─────────────────────────────────────────────────────────

export async function fetchReplay(simId: string): Promise<WorldState[]> {
  const url = simId === "default" ? `${API_URL}/replay` : `${API_URL}/sims/${simId}/replay`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(await responseErrorMessage(res));
  return (await res.json()).snapshots ?? [];
}

export type InterviewTurn = { role: string; text: string };

export async function interviewAgent(
  simId: string, agentId: string, question: string, history: InterviewTurn[],
): Promise<{ agent: string; status: string; answer: string }> {
  const res = await fetch(`${API_URL}/sims/${simId}/agents/${agentId}/interview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, history }),
  });
  if (!res.ok) throw new Error(await responseErrorMessage(res));
  return res.json();
}
