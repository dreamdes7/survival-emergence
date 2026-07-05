// Sim lifecycle: websockets, snapshot application, create/switch/delete.

import { createSimReq, deleteSimReq, fetchForgeConfig, fetchSims, fetchState } from "./api";
import { WS_BASE } from "./constants";
import { ensureManifest, store } from "./store";
import { deriveEvents, pushEvent, renderChrome, renderForge, renderSimBar } from "./ui";
import { handleWorldChange, render, resetForSimSwitch } from "./render";
import type { SimMeta, WorldState } from "./types";

export function connectSim(simId: string): void {
  if (store.simSockets.has(simId)) return;
  const ws = new WebSocket(`${WS_BASE}/${simId}`);
  store.simSockets.set(simId, ws);
  ws.onmessage = (msg) => {
    const snap = JSON.parse(msg.data) as WorldState;
    store.simStates.set(simId, snap);
    // Update lightweight meta for tab display
    store.simMetaMap.set(simId, {
      sim_id: simId,
      scenario: snap.scenario,
      day: snap.day,
      alive: snap.agents.filter((a) => a.status !== "dead").length,
    });
    // In replay mode the live stream keeps updating the store, but the screen
    // stays on the scrubbed snapshot until the user exits replay.
    if (simId === store.activeSimId && !store.replayMode) applyState(snap);
    else renderSimBar();
  };
  ws.onclose = () => {
    store.simSockets.delete(simId);
    setTimeout(() => {
      if (store.simMetaMap.has(simId)) connectSim(simId);
    }, 2000);
  };
  ws.onerror = () => pushEvent(`sim ${simId} stream error`);
}

export function applyState(next: WorldState) {
  store.previous = store.state;
  store.state = next;
  if (next.scenario && !store.manifestByScenario.has(next.scenario)) {
    void ensureManifest(store.activeSimId, next.scenario);   // fire-and-forget
  }
  // Update simbar meta for the active sim
  store.simMetaMap.set(store.activeSimId, {
    sim_id: store.activeSimId,
    scenario: next.scenario,
    day: next.day,
    alive: next.agents.filter((a) => a.status !== "dead").length,
  });
  renderSimBar();
  handleWorldChange(next);
  if (!store.selectedAgentId && next.agents.length) {
    store.selectedAgentId = next.agents[0].id;
  }
  deriveEvents(store.previous, next);
  void render();
  renderChrome();
}

// Replay scrubbing: show a historical snapshot without touching sim meta or the
// system event ticker — a pure re-render of the world at that tick.
export function showSnapshot(snap: WorldState) {
  store.previous = store.state;
  store.state = snap;
  handleWorldChange(snap);
  void render();
  renderChrome();
}

export function switchSim(simId: string): void {
  if (simId === store.activeSimId) return;
  store.activeSimId = simId;
  resetForSimSwitch();
  store.selectedAgentId = null;
  store.selectedStructureId = null;
  const snap = store.simStates.get(simId);
  if (snap) applyState(snap);
  renderSimBar();
  void loadForgeConfig();
}

export async function createSim(overrides: Record<string, unknown>): Promise<void> {
  const meta: SimMeta = await createSimReq(overrides);
  store.simMetaMap.set(meta.sim_id, meta);
  try {
    const snap = await fetchState(meta.sim_id);
    store.simStates.set(meta.sim_id, snap);
  } catch { /* websocket will hydrate shortly */ }
  connectSim(meta.sim_id);
  switchSim(meta.sim_id);
  pushEvent(`sim '${meta.sim_id}' launched`);
}

export async function deleteSim(simId: string): Promise<void> {
  await deleteSimReq(simId);
  store.simSockets.get(simId)?.close();
  store.simSockets.delete(simId);
  store.simStates.delete(simId);
  store.simMetaMap.delete(simId);
  if (store.activeSimId === simId) {
    const next = [...store.simMetaMap.keys()][0] ?? "default";
    switchSim(next);
  } else {
    renderSimBar();
  }
  pushEvent(`sim '${simId}' deleted`);
}

export async function initSims(): Promise<void> {
  const data = await fetchSims();
  if (data.sims.length > 0) {
    store.activeSimId = data.sims.some((meta) => meta.sim_id === "default")
      ? "default" : data.sims[0].sim_id;
  }
  const snap0 = await fetchState(store.activeSimId);
  store.simStates.set(store.activeSimId, snap0);
  await ensureManifest(store.activeSimId, snap0.scenario);
  applyState(snap0);
  for (const meta of data.sims) {
    store.simMetaMap.set(meta.sim_id, meta);
    connectSim(meta.sim_id);
  }
  renderSimBar();
}

export async function loadForgeConfig(): Promise<void> {
  renderForge(await fetchForgeConfig(store.activeSimId));
}
