"""Shared test helpers: build a small deterministic stub world and drive ticks."""
from __future__ import annotations
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engine.orchestrator import (apply_runtime_policy, build_llm, load_config,
                                 resolve_names, spawn_agents)
from engine.world import World


def build_sim(overrides: dict | None = None):
    """A fully-wired stub simulation (no API). Returns (world, llm, cfg)."""
    ov = {"scenario": "island", "seed": 7, "agents": 4}
    ov.update(overrides or {})
    cfg, scenario = load_config(ov)
    world = World(scenario, int(cfg["seed"]), int(cfg["sim"]["day_length_ticks"]))
    world.move_speed = int(cfg["sim"].get("move_speed", 1))
    spawn_agents(world, cfg)
    apply_runtime_policy(world, cfg)
    llm = build_llm(world, cfg)
    resolve_names(world, llm, scenario)
    return world, llm, cfg


def run_ticks(world, llm, n: int) -> None:
    for t in range(n):
        world.tick = t
        world.begin_tick()
        for agent in world.active_agents():
            agent.step(world, llm)
        world.end_tick()


@pytest.fixture
def sim():
    return build_sim()
