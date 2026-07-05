"""Decision provenance + clean-authorship knobs: every action is attributed, and
the emergency-gate width / fallback policy behave as configured."""
from __future__ import annotations

from agents.runtime import _emergency_gate, _wait_decision
from conftest import build_sim, run_ticks


def test_every_decision_has_a_source():
    world, llm, _ = build_sim()
    run_ticks(world, llm, 6)
    for a in world.agents:
        assert a.last_source in {"stub", "emergency", "repair_stub", "wait"}, a.last_source


def test_stub_run_is_pure_stub():
    world, llm, _ = build_sim()
    seen = set()
    for t in range(6):
        world.tick = t
        world.begin_tick()
        for a in world.active_agents():
            decision, _ = a.step(world, llm)
            seen.add(decision["_source"])
        world.end_tick()
    # A stub world may hit the emergency gate, but never a real-LLM source.
    assert seen <= {"stub", "emergency", "repair_stub", "wait"}
    assert "llm" not in seen


def test_emergency_multiplier_widens_the_gate():
    from engine.models import STAT_RESTORE
    world, _, _ = build_sim()
    agent = world.agents[0]
    phys_cfg = world.scenario.get("physiology", {})
    # Pick a lethal, restorable stat and set it into the band 1.2*crit < v < 2.0*crit.
    stat = next(s for s in agent.physiology
                if s in STAT_RESTORE and phys_cfg.get(s, {}).get("lethal", True))
    crit = phys_cfg.get(stat, {}).get("critical", 20)
    for other in list(agent.physiology):     # keep all other stats safely high
        agent.physiology[other] = 100.0
    agent.physiology[stat] = crit * 1.6      # inside 2.0's band, outside 1.2's band

    world.emergency_multiplier = 2.0
    wide = _emergency_gate(agent, world)
    world.emergency_multiplier = 1.2
    narrow = _emergency_gate(agent, world)
    world.emergency_multiplier = 0.0
    disabled = _emergency_gate(agent, world)

    assert wide is not None and wide["_source"] == "emergency"
    assert narrow is None
    assert disabled is None


def test_wait_decision_is_neutral():
    d = _wait_decision("test")
    assert d["tool"] == "wait" and d["_source"] == "wait"
