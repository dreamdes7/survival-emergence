// Composition root. The old 2000-line monolith now lives in focused modules:
//   types.ts      — backend/UI type contracts
//   constants.ts  — endpoints + world-scale knobs
//   utils.ts      — pure helpers (escaping, agent colours)
//   store.ts      — shared mutable state + manifest cache
//   api.ts        — every HTTP call
//   interview.ts  — survivor interview chat (Sprint 2)
//   ui.ts         — DOM chrome: modals, panels, forge, sim bar
//   render.ts     — the Pixi renderer (camera, terrain, agents, structures)
//   replay.ts     — replay scrubber over GET /replay (Sprint 2)
//   net.ts        — websockets + sim lifecycle + snapshot application
// main.ts wires the injection points and boots.

import "./styles.css";
import { initPixi } from "./render";
import { bindForgeSubmit, bindInspector, bindModalClose, bindNewSimModal, nav, pushEvent } from "./ui";
import { applyState, connectSim, createSim, deleteSim, initSims, loadForgeConfig, switchSim } from "./net";
import { initInterview } from "./interview";
import { initReplay } from "./replay";
import { showSnapshot } from "./net";

// ui.ts never imports net/render (keeps the module graph acyclic); the real
// navigation actions are injected here.
nav.switchSim = switchSim;
nav.deleteSim = deleteSim;
nav.createSim = createSim;
nav.loadForgeConfig = loadForgeConfig;
nav.applyState = applyState;

async function init() {
  await initPixi();
  bindModalClose();
  bindNewSimModal();
  bindForgeSubmit();
  bindInspector();
  initInterview();
  initReplay(showSnapshot);

  try {
    await initSims();
    await loadForgeConfig();
  } catch {
    pushEvent("API offline — retrying…");
    setTimeout(() => connectSim("default"), 2000);
  }
}

void init();
