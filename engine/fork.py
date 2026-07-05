"""Counterfactual fork — causal probing of a run (Sprint 5, FRONTIER_IDEAS 3.1).

The question no other agent framework answers: *why* did an emergent event
happen? A fork reconstructs a completed run up to tick T, applies an
INTERVENTION (kill an agent, remove the campfire, force a choice, change the
weather), then lets the world continue — and diffs the branch against the
original. The divergence IS the causal footprint of the intervention.

How reconstruction stays faithful:

- **Stub (deterministic) runs** re-simulate from the seed. The stub path is
  bit-for-bit reproducible (golden-tested), so re-running to T reproduces the
  original exactly; after T the intervention makes it diverge. This is the
  first-class, free, fully-verifiable path — and it also closes the old
  snapshot-restore gap (a fork *is* a restore-and-continue).
- **Real-LLM runs** use a PlaybackLLM that feeds each agent its RECORDED
  decision (from events.jsonl, which now carries full args) up to T, so the
  trajectory reconstructs without re-calling the API; after T the chosen brain
  runs live so the model can react to the intervention. Environmental RNG
  (weather) may drift for real-LLM runs — documented, best-effort.

Everything the fork does is itself a proper run under logs/runs/, so a fork is
forkable and diffable like any run.

    py -3.12 -m engine.fork <run_dir> --at 20 --kill Борис --ticks 20
    py -3.12 -m engine.fork <run_dir> --at 12 --remove-structure campfire --ticks 24
"""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

import yaml

from engine.events import EventScheduler
from engine.event_log import RUNS_DIR, RunRecorder
from engine.orchestrator import (advance_tick, apply_runtime_policy, build_llm,
                                 resolve_names, spawn_agents)
from engine.world import World

ROOT = Path(__file__).resolve().parent.parent


# ── loading a recorded run ────────────────────────────────────────────────────
def load_run(run_dir: Path) -> dict:
    """Read a run's manifest + typed event stream into memory."""
    meta = json.loads((run_dir / "meta.json").read_text(encoding="utf-8"))
    events: list[dict] = []
    ev_path = run_dir / "events.jsonl"
    if ev_path.exists():
        for line in ev_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                events.append(json.loads(line))
    # decisions indexed by tick -> agent_id -> payload (for playback)
    decisions: dict[int, dict[str, dict]] = {}
    for e in events:
        if e["kind"] == "decision":
            decisions.setdefault(e["tick"], {})[e["actor"]] = e["payload"]
    return {"meta": meta, "events": events, "decisions": decisions, "dir": run_dir}


# ── playback brain (real-LLM faithful reconstruction) ─────────────────────────
class PlaybackLLM:
    """Replays recorded decisions before the fork tick, then hands control to a
    live brain so the world reacts to the intervention after it."""

    def __init__(self, decisions: dict[int, dict[str, dict]], fork_tick: int, live) -> None:
        self.decisions = decisions
        self.fork_tick = fork_tick
        self.live = live
        self.openrouter = getattr(live, "openrouter", None)

    def brain_for(self, agent):
        getter = getattr(self.live, "brain_for", None)
        return getter(agent) if callable(getter) else self.live

    def decide(self, agent, world) -> dict:
        if world.tick < self.fork_tick:
            rec = self.decisions.get(world.tick, {}).get(agent.id)
            if rec and rec.get("tool"):
                return {"tool": rec["tool"], "args": dict(rec.get("args") or {}),
                        "thought": rec.get("thought", ""), "_source": "playback"}
        return self.live.decide(agent, world)


# ── world reconstruction ──────────────────────────────────────────────────────
def rebuild_world(meta: dict):
    """Rebuild the exact world the run started from (same config + seed). Returns
    (world, cfg, scenario, events, is_stub)."""
    cfg = meta["config"]
    scen_name = cfg["scenario"]
    scenario = yaml.safe_load(
        (ROOT / "scenarios" / f"{scen_name}.yaml").read_text(encoding="utf-8"))
    day_len = int(cfg["sim"]["day_length_ticks"])
    world = World(scenario, int(cfg["seed"]), day_len)
    world.move_speed = int(cfg["sim"].get("move_speed", 1))
    spawn_agents(world, cfg)
    apply_runtime_policy(world, cfg)
    is_stub = all(a.get("model") == "stub" for a in meta.get("agents", []))
    return world, cfg, scenario, is_stub


# ── interventions ─────────────────────────────────────────────────────────────
def apply_intervention(world, spec: dict) -> str:
    """Mutate the world at the fork tick. Returns a human description."""
    kind = spec["kind"]
    if kind == "kill":
        a = world.agent_by_name(spec["name"])
        if a is None:
            return f"(kill: no agent '{spec['name']}')"
        a.status = "dead"
        a.incap_ticks = 99
        world.log_event("death", f"[форк] {a.name} исчез из этой ветки", 3.0, [a.name])
        return f"killed {a.name}"
    if kind == "remove_structure":
        target = spec["what"]
        matches = [s for s in world.structures if s.kind == target or s.id == target
                   or s.role == target]
        if not matches:
            return f"(remove_structure: none matching '{target}')"
        s = matches[0]
        world.structures.remove(s)
        return f"removed {s.kind}#{s.id}"
    if kind == "spawn_structure":
        from engine.models import Structure
        cx, cy = world.camp_center
        world.structures.append(Structure(
            id=f"forked_{spec['what']}", kind=spec["what"], x=cx, y=cy,
            role=spec.get("role", ""), state={"complete": True, "fuel": 100}))
        return f"spawned {spec['what']} at camp"
    if kind == "weather":
        world.weather = spec["what"]
        world.weather_ticks_left = int(spec.get("ticks", 6))
        return f"weather -> {spec['what']}"
    if kind == "give":
        a = world.agent_by_name(spec["name"])
        if a is None:
            return f"(give: no agent '{spec['name']}')"
        a.inventory[spec["item"]] = a.inventory.get(spec["item"], 0) + float(spec.get("qty", 5))
        return f"gave {a.name} {spec.get('qty', 5)} {spec['item']}"
    if kind == "goal":
        a = world.agent_by_name(spec["name"])
        if a is None:
            return f"(goal: no agent '{spec['name']}')"
        a.goals.insert(0, spec["text"])
        return f"set {a.name}'s goal: {spec['text']}"
    return f"(unknown intervention '{kind}')"


# ── the fork ──────────────────────────────────────────────────────────────────
def run_fork(run_dir: Path, fork_tick: int, intervention: dict | None,
             extra_ticks: int, *, live_after: bool = True, quiet: bool = True) -> dict:
    """Reconstruct `run_dir` to `fork_tick`, apply `intervention`, continue for
    `extra_ticks`, record the branch, and diff it against the original. Returns
    {recorder, dir, diff, intervention_desc}."""
    run = load_run(run_dir)
    meta = run["meta"]
    world, cfg, scenario, is_stub = rebuild_world(meta)

    stub_llm = build_llm(world, cfg)
    if is_stub:
        llm = stub_llm                       # deterministic re-run reproduces exactly
        resolve_names(world, llm, scenario)  # same rng + names as the original
    else:
        # Real-LLM: playback recorded decisions to T, live after; force names to
        # the recorded ones (name resolution is non-deterministic on real models).
        live = stub_llm
        llm = PlaybackLLM(run["decisions"], fork_tick if live_after else 10 ** 9, live)
        for m, a in zip(meta["agents"], world.agents):
            a.name = m["name"]

    events = EventScheduler(world)
    reflect_with_llm = bool(cfg.get("llm", {}).get("reflect_with_llm", True))
    reflect_every = int(cfg["sim"].get("reflect_every", 6))

    label = intervention.get("kind", "noop") if intervention else "noop"
    if intervention and intervention.get("name"):
        label += "_" + str(intervention["name"])
    recorder = RunRecorder(world, cfg, scenario,
                           run_id=f"{meta['run_id']}__fork@{fork_tick}_{label}",
                           log_llm=bool(cfg.get("research", {}).get("log_llm", True)))
    world.recorder = recorder

    # 1) reconstruct up to the fork tick
    for t in range(fork_tick):
        advance_tick(world, llm, events, t, reflect_every, reflect_with_llm)
        recorder.tick_metrics(world)

    # 2) intervene
    desc = apply_intervention(world, intervention) if intervention else "no intervention"
    world.emit("intervention", payload={"tick": fork_tick, "desc": desc})

    # 3) continue the branch
    for t in range(fork_tick, fork_tick + extra_ticks):
        advance_tick(world, llm, events, t, reflect_every, reflect_with_llm)
        recorder.tick_metrics(world)
        if world.escaped or not world.living_agents():
            break

    recorder.close(world)
    diff = diff_branches(run, load_run(recorder.dir), fork_tick)
    return {"recorder": recorder, "dir": recorder.dir, "diff": diff,
            "intervention_desc": desc}


# ── diffing two branches ──────────────────────────────────────────────────────
def _summ(events: list[dict]):
    """Fold an event stream into a comparable summary."""
    tools = {}                 # tick -> {agent_id: tool}
    chronicle = set()          # {(kind, text)}
    last = {}                  # agent_id -> last decision payload
    for e in events:
        if e["kind"] == "decision":
            p = e["payload"]
            tools.setdefault(e["tick"], {})[e["actor"]] = p.get("tool")
            last[e["actor"]] = p
        elif e["kind"] == "chronicle":
            p = e["payload"]
            chronicle.add((p.get("kind"), p.get("text")))
    return {"tools": tools, "chronicle": chronicle, "last": last}


def diff_branches(original: dict, fork: dict, fork_tick: int) -> dict:
    """Attribute the fork's downstream differences to the intervention."""
    o, f = _summ(original["events"]), _summ(fork["events"])

    # first tick at/after the fork where the two branches choose differently
    first_div = None
    shared = sorted(set(o["tools"]) & set(f["tools"]))
    for t in shared:
        if t < fork_tick:
            continue
        if o["tools"][t] != f["tools"][t]:
            first_div = t
            break

    om, fm = original["meta"], fork["meta"]
    only_original = sorted(t for (_, t) in (o["chronicle"] - f["chronicle"]) if t)
    only_fork = sorted(t for (_, t) in (f["chronicle"] - o["chronicle"]) if t)

    return {
        "fork_tick": fork_tick,
        "first_divergence_tick": first_div,
        "outcome": {
            "original": {"survivors": om.get("survivors", []),
                         "escaped": om.get("escaped"),
                         "structures": om.get("structures", [])},
            "fork": {"survivors": fm.get("survivors", []),
                     "escaped": fm.get("escaped"),
                     "structures": fm.get("structures", [])},
        },
        "chronicle_only_in_original": only_original,   # events the intervention PREVENTED
        "chronicle_only_in_fork": only_fork,           # events the intervention CAUSED
        "survivor_delta": len(fm.get("survivors", [])) - len(om.get("survivors", [])),
    }


def print_diff(res: dict) -> None:
    d = res["diff"]
    print("\n" + "=" * 70)
    print(f"  COUNTERFACTUAL FORK  @ tick {d['fork_tick']}")
    print(f"  intervention: {res['intervention_desc']}")
    print(f"  branch dir  : {res['dir']}")
    print("=" * 70)
    fd = d["first_divergence_tick"]
    print(f"  first divergence   : {'tick ' + str(fd) if fd is not None else 'none (identical)'}")
    o, f = d["outcome"]["original"], d["outcome"]["fork"]
    print(f"  survivors  original : {len(o['survivors'])}  {o['survivors']}")
    print(f"  survivors  fork     : {len(f['survivors'])}  {f['survivors']}  "
          f"(delta {d['survivor_delta']:+d})")
    print(f"  escaped    orig/fork: {o['escaped']} / {f['escaped']}")
    if d["chronicle_only_in_original"]:
        print("  intervention PREVENTED:")
        for t in d["chronicle_only_in_original"][:8]:
            print(f"     - {t}")
    if d["chronicle_only_in_fork"]:
        print("  intervention CAUSED:")
        for t in d["chronicle_only_in_fork"][:8]:
            print(f"     + {t}")
    if not d["chronicle_only_in_original"] and not d["chronicle_only_in_fork"]:
        print("  no chronicle-level differences")
    print("=" * 70)


# ── CLI ───────────────────────────────────────────────────────────────────────
def main() -> None:
    try:                                    # UTF-8 console so Cyrillic doesn't crash
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="Counterfactual fork of a recorded run.")
    ap.add_argument("run_dir", help="A logs/runs/<id> directory (or run id).")
    ap.add_argument("--at", type=int, required=True, help="Fork tick T.")
    ap.add_argument("--ticks", type=int, default=24, help="Ticks to continue after T.")
    ap.add_argument("--kill", help="Intervention: kill this agent at T.")
    ap.add_argument("--remove-structure", help="Intervention: remove a structure (kind/role/id).")
    ap.add_argument("--spawn-structure", help="Intervention: spawn a completed structure at camp.")
    ap.add_argument("--weather", help="Intervention: force weather (e.g. storm).")
    ap.add_argument("--give", nargs=3, metavar=("NAME", "ITEM", "QTY"),
                    help="Intervention: give an item.")
    ap.add_argument("--goal", nargs=2, metavar=("NAME", "TEXT"),
                    help="Intervention: set an agent's top goal.")
    args = ap.parse_args()

    run_dir = Path(args.run_dir)
    if not run_dir.is_absolute() and not run_dir.exists():
        run_dir = RUNS_DIR / args.run_dir
    if not (run_dir / "meta.json").exists():
        print(f"No run at {run_dir}")
        return

    intervention = None
    if args.kill:
        intervention = {"kind": "kill", "name": args.kill}
    elif args.remove_structure:
        intervention = {"kind": "remove_structure", "what": args.remove_structure}
    elif args.spawn_structure:
        intervention = {"kind": "spawn_structure", "what": args.spawn_structure}
    elif args.weather:
        intervention = {"kind": "weather", "what": args.weather}
    elif args.give:
        intervention = {"kind": "give", "name": args.give[0],
                        "item": args.give[1], "qty": float(args.give[2])}
    elif args.goal:
        intervention = {"kind": "goal", "name": args.goal[0], "text": args.goal[1]}

    res = run_fork(run_dir, args.at, intervention, args.ticks)
    print_diff(res)


if __name__ == "__main__":
    sys.exit(main())
