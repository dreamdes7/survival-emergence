// Shared mutable application state. One place owns it; every module reads and
// writes through `store` so the split modules stay honest about what they share.

import { API_URL } from "./constants";
import type { Manifest, SimMeta, WorldState } from "./types";

export const store = {
  // Multi-sim
  activeSimId: "default",
  simStates: new Map<string, WorldState>(),   // sim_id -> latest world snapshot
  simSockets: new Map<string, WebSocket>(),   // sim_id -> live websocket
  simMetaMap: new Map<string, SimMeta>(),     // sim_id -> lightweight meta

  // Live world + selection
  state: null as WorldState | null,
  previous: null as WorldState | null,
  selectedAgentId: null as string | null,
  selectedStructureId: null as string | null,
  simPaused: false,

  // Replay mode: while active, live websocket snapshots update simStates but the
  // screen shows the scrubbed snapshot instead.
  replayMode: false,

  // Render style: "3d" = low-poly three.js diorama, "vector" = procedural 2D
  // (both asset-free, island only), "tiles" = the original tileset renderer.
  renderStyle: ((): "tiles" | "vector" | "3d" => {
    const saved = localStorage.getItem("renderStyle");
    return saved === "tiles" || saved === "vector" || saved === "3d" ? saved : "3d";
  })(),

  // System event ticker (left dock)
  events: [] as string[],

  // Backend-authoritative structure manifest (per scenario). Fetched lazily so a
  // new buildable/cost only has to change on the backend, not in the frontend.
  manifestByScenario: new Map<string, Manifest>(),
};

export async function ensureManifest(sim_id: string, scenario: string): Promise<void> {
  if (store.manifestByScenario.has(scenario)) return;
  const url = sim_id === "default" ? `${API_URL}/manifest` : `${API_URL}/sims/${sim_id}/manifest`;
  try {
    const res = await fetch(url);
    if (res.ok) store.manifestByScenario.set(scenario, (await res.json()) as Manifest);
  } catch { /* offline — helpers fall back to defaults */ }
}

// Required build progress for a structure kind: manifest first (source of truth),
// then a conservative default.
export function requiredProgress(kind: string): number {
  const scen = store.simStates.get(store.activeSimId)?.scenario;
  const fromManifest = scen
    ? store.manifestByScenario.get(scen)?.structures?.[kind]?.required_progress
    : undefined;
  if (typeof fromManifest === "number") return fromManifest;
  return kind === "tent" ? 40 : kind === "water_still" ? 25 : kind === "store" ? 25 : 30;
}
