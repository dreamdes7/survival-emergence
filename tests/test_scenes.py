"""Sprint 1: conversation scenes, dreams, narrator gating."""
from __future__ import annotations

from agents.dialogue import run_scene
from engine.orchestrator import build_narrator
from conftest import build_sim


def _adjacent_pair(world):
    a, b = world.agents[0], world.agents[1]
    b.x, b.y = a.x, min(world.size - 1, a.y + 1)   # force adjacency
    return a, b


def test_scene_produces_dialogue_event_and_memories():
    world, llm, _ = build_sim({"seed": 3})
    a, b = _adjacent_pair(world)
    world.tick = 1
    a_mem, b_mem = len(a.memory.entries), len(b.memory.entries)
    aff_before = b.relationships.get(a.id).affinity

    spoken = run_scene(world, llm, a, b, "How are you holding up?", max_lines=4)

    assert spoken >= 1, "stub scene should produce at least one reply"
    scenes = [e for e in world.events if e["kind"] == "dialogue"]
    assert len(scenes) == 1
    lines = scenes[0]["payload"]["lines"]
    assert lines[0]["text"] == "How are you holding up?"
    assert len(lines) == spoken + 1
    # both sides remembered the exchange, affinity moved up
    assert len(a.memory.entries) > a_mem and len(b.memory.entries) > b_mem
    assert b.relationships.get(a.id).affinity >= aff_before


def test_scene_respects_zero_config_and_dead_partner():
    world, llm, _ = build_sim({"seed": 3})
    a, b = _adjacent_pair(world)
    assert run_scene(world, llm, a, b, "hi", max_lines=0) == 0
    b.status = "dead"
    assert run_scene(world, llm, a, b, "hi", max_lines=4) == 0
    assert not [e for e in world.events if e["kind"] == "dialogue"]


def test_scene_triggers_from_step_on_say_to():
    world, llm, _ = build_sim({"seed": 9})
    a, b = _adjacent_pair(world)
    world.dialogue_scene_lines = 4

    class SayLLM:  # minimal brain that always opens a conversation
        def decide(self, agent, w):
            return {"tool": "say_to", "_source": "stub",
                    "args": {"target": b.name, "message": "Stay close, it's safer together."},
                    "thought": "talk"}

    world.emergency_multiplier = 0.0           # keep the gate out of the way
    world.tick = 1
    a.step(world, SayLLM())
    assert [e for e in world.events if e["kind"] == "dialogue"], \
        "a landed say_to on an adjacent agent must start a scene"


def test_dream_fires_once_per_night_and_lifts_morale():
    world, llm, _ = build_sim({"seed": 5})
    a = world.agents[0]
    world.tick = 8                              # second half of day 1 = night
    world.begin_tick()
    assert world.is_night
    a.physiology["morale"] = 50.0

    class RestLLM:
        def decide(self, agent, w):
            return {"tool": "rest", "_source": "stub", "args": {}, "thought": "sleep"}

    world.emergency_multiplier = 0.0
    a.step(world, RestLLM())
    dreams = [e for e in a.memory.entries if e.kind == "dream"]
    assert len(dreams) == 1
    assert a.physiology["morale"] > 50.0
    assert a.memory.diary and a.memory.diary[-1][1].startswith("(сон)")

    a.step(world, RestLLM())                    # same night — no second dream
    assert len([e for e in a.memory.entries if e.kind == "dream"]) == 1
    assert [e for e in world.events if e["kind"] == "dream"]


def test_narrator_disabled_for_stub_world():
    world, llm, cfg = build_sim({"seed": 4})
    cfg.setdefault("narrator", {})["enabled"] = True
    cfg["narrator"]["model"] = ""               # no explicit model, all agents stub
    assert build_narrator(world, cfg, llm) is None, \
        "stub-only world must not get a narrator (free worlds stay free)"
