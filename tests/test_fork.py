"""Sprint 5: counterfactual fork — determinism of reconstruction and the causal
diff. All on the free, deterministic stub path."""
from __future__ import annotations

import pytest

from engine.orchestrator import load_config, run_config
from engine.fork import load_run, run_fork


@pytest.fixture(scope="module")
def recorded_run():
    """A short recorded stub run to fork (module-scoped: built once)."""
    import shutil
    from engine.event_log import RUNS_DIR
    cfg, scen = load_config({"scenario": "island", "seed": 5, "agents": 5})
    cfg["sim"]["max_days"] = 2                      # 24 ticks
    rec = run_config(cfg, scen, quiet=True)
    yield rec
    # tidy up this run and every fork branched off it
    for d in RUNS_DIR.glob(f"{rec.run_id}*"):
        shutil.rmtree(d, ignore_errors=True)


def _names(meta):
    return [a["name"] for a in meta["agents"]]


def test_noop_fork_reproduces_original(recorded_run):
    # Reconstructing to T and continuing with NO intervention must be identical
    # to the original — this is the determinism the whole probe rests on.
    res = run_fork(recorded_run.dir, fork_tick=12, intervention=None, extra_ticks=12)
    assert res["diff"]["first_divergence_tick"] is None
    assert res["diff"]["survivor_delta"] == 0
    assert not res["diff"]["chronicle_only_in_fork"]
    assert not res["diff"]["chronicle_only_in_original"]


def test_kill_diverges_exactly_at_fork_tick(recorded_run):
    victim = _names(recorded_run.meta)[0]
    res = run_fork(recorded_run.dir, fork_tick=12,
                   intervention={"kind": "kill", "name": victim}, extra_ticks=12)
    d = res["diff"]
    # nothing before the fork changed; the branch splits at the fork tick
    assert d["first_divergence_tick"] == 12
    assert d["survivor_delta"] == -1
    # the victim takes no decisions after the fork tick
    fork = load_run(res["dir"])
    after = [e for e in fork["events"]
             if e["kind"] == "decision" and e["tick"] >= 12
             and e["payload"]["name"] == victim]
    assert not after


def test_kill_before_fork_is_reconstructed_faithfully(recorded_run):
    # Decisions BEFORE the fork tick must match the original exactly.
    res = run_fork(recorded_run.dir, fork_tick=14,
                   intervention={"kind": "kill", "name": _names(recorded_run.meta)[1]},
                   extra_ticks=10)
    orig = load_run(recorded_run.dir)
    fork = load_run(res["dir"])
    def tools(run):
        out = {}
        for e in run["events"]:
            if e["kind"] == "decision" and e["tick"] < 14:
                out[(e["tick"], e["actor"])] = e["payload"]["tool"]
        return out
    assert tools(orig) == tools(fork), "pre-fork trajectory must be bit-identical"


def test_intervention_event_recorded(recorded_run):
    res = run_fork(recorded_run.dir, fork_tick=10,
                   intervention={"kind": "weather", "what": "storm", "ticks": 8},
                   extra_ticks=8)
    fork = load_run(res["dir"])
    iv = [e for e in fork["events"] if e["kind"] == "intervention"]
    assert iv and iv[0]["payload"]["tick"] == 10
    assert "storm" in res["intervention_desc"]


def test_remove_structure_intervention(recorded_run):
    # Removing a structure that exists at the fork tick should succeed cleanly.
    res = run_fork(recorded_run.dir, fork_tick=12,
                   intervention={"kind": "remove_structure", "what": "cave"},
                   extra_ticks=6)
    # either it removed a cave or reported none — never crashes, always a branch
    assert res["dir"].exists()
    assert "remove" in res["intervention_desc"] or "none" in res["intervention_desc"]
