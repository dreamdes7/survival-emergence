// Replay scrubber (Sprint 2): rewind the current sim through the snapshots the
// backend already keeps (GET /replay). Entering replay freezes the screen on
// the scrubbed snapshot; the live stream keeps flowing into the store, and
// exiting jumps back to the newest live state.

import { fetchReplay } from "./api";
import { store } from "./store";
import { pushEvent } from "./ui";
import type { WorldState } from "./types";

let snapshots: WorldState[] = [];
let barEl: HTMLDivElement;
let sliderEl: HTMLInputElement;
let labelEl: HTMLSpanElement;
let showSnapshotCb: (s: WorldState) => void = () => {};

export function initReplay(showSnapshot: (s: WorldState) => void): void {
  showSnapshotCb = showSnapshot;
  barEl = document.querySelector<HTMLDivElement>("#replay-bar")!;
  sliderEl = document.querySelector<HTMLInputElement>("#replay-slider")!;
  labelEl = document.querySelector<HTMLSpanElement>("#replay-label")!;
  document.querySelector<HTMLButtonElement>("#replay-btn")!
    .addEventListener("click", () => void toggleReplay());
  document.querySelector<HTMLButtonElement>("#replay-close")!
    .addEventListener("click", exitReplay);
  sliderEl.addEventListener("input", () => showIndex(Number(sliderEl.value)));
}

async function toggleReplay(): Promise<void> {
  if (store.replayMode) { exitReplay(); return; }
  try {
    snapshots = await fetchReplay(store.activeSimId);
  } catch (err) {
    pushEvent(`replay failed: ${err instanceof Error ? err.message : err}`);
    return;
  }
  if (snapshots.length < 2) {
    pushEvent("replay: history is still too short");
    return;
  }
  store.replayMode = true;
  barEl.hidden = false;
  sliderEl.min = "0";
  sliderEl.max = String(snapshots.length - 1);
  sliderEl.value = String(snapshots.length - 1);
  showIndex(snapshots.length - 1);
  pushEvent(`replay: ${snapshots.length} snapshots — scrub the slider`);
}

function showIndex(i: number): void {
  const snap = snapshots[Math.max(0, Math.min(snapshots.length - 1, i))];
  if (!snap) return;
  labelEl.textContent = `Day ${snap.day} · T${snap.tick}`;
  showSnapshotCb(snap);
}

export function exitReplay(): void {
  if (!store.replayMode) return;
  store.replayMode = false;
  barEl.hidden = true;
  snapshots = [];
  // Snap back to the freshest live state of the active sim.
  const live = store.simStates.get(store.activeSimId);
  if (live) showSnapshotCb(live);
  pushEvent("replay: back to live");
}
