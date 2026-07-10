"""Cross-run island memory: deposit gating, excavation, seed isolation, modes."""
from __future__ import annotations
import json

from engine import palimpsest
from engine.models import Structure
from conftest import build_sim


def _rich(seed, tmp):
    palimpsest.STRATA_DIR = tmp
    world, _llm, cfg = build_sim({"scenario": "island", "seed": seed})
    cfg["palimpsest"] = "on"
    A, B = world.agents[0], world.agents[1]
    B.status = "dead"; B.buried = True; B.x, B.y = 30, 30
    world.structures.append(Structure(
        id="grave@30,30#1", kind="grave", x=30, y=30, role="grave",
        state={"complete": True, "of": B.name, "buried_by": A.name, "day": 3, "log": []}))
    world.placenames.append({"name": "Хребет", "x": 25, "y": 25, "by": A.name,
                             "by_id": A.id, "tick": 10, "endorsers": [A.id], "famous": True})
    world.structures.append(Structure(
        id="tent@22,22#1", kind="tent", x=22, y=22, role="shelter",
        state={"complete": True, "buildable_kind": "tent", "log": []}))
    A.memory.add_diary(24, "Пещера — ловушка. Нужен настоящий дом до холодов, иначе конец.")
    world.day = 6
    world.chronicle = [{"importance": 3.0}]
    return world, cfg


def test_rich_run_deposits_a_layer(tmp_path):
    world, cfg = _rich(7, tmp_path)
    res = palimpsest.deposit(world, cfg, world.scenario, "run_seed7")
    assert res and res["written"] and res["score"] >= 5.0
    assert (tmp_path / "island_seed7" / "layer001.json").exists()


def test_junk_run_is_rejected_by_the_floor(tmp_path):
    palimpsest.STRATA_DIR = tmp_path
    world, _llm, cfg = build_sim({"scenario": "island", "seed": 7})
    cfg["palimpsest"] = "on"
    world.day = 1
    res = palimpsest.deposit(world, cfg, world.scenario, "junk")
    assert res is not None and not res["written"], "empty run must leave no layer"


def test_next_run_excavates_prior_layer(tmp_path):
    world, cfg = _rich(7, tmp_path)
    palimpsest.deposit(world, cfg, world.scenario, "run_seed7")
    nxt, _llm, ncfg = build_sim({"scenario": "island", "seed": 7})
    ncfg["palimpsest"] = "on"
    dug = palimpsest.excavate(nxt, ncfg, nxt.scenario)
    assert dug["placed"] >= 2
    assert any(s.kind == "grave" and s.state.get("inherited") for s in nxt.structures)
    assert any(p.get("inherited") for p in nxt.placenames)


def test_seed_isolation(tmp_path):
    world, cfg = _rich(7, tmp_path)
    palimpsest.deposit(world, cfg, world.scenario, "run_seed7")
    other, _llm, ocfg = build_sim({"scenario": "island", "seed": 999})
    ocfg["palimpsest"] = "on"
    dug = palimpsest.excavate(other, ocfg, other.scenario)
    assert dug["placed"] == 0, "a different seed is a different island"


def test_modes_off_and_read_only(tmp_path):
    world, cfg = _rich(7, tmp_path)
    cfg["palimpsest"] = "read_only"
    assert palimpsest.deposit(world, cfg, world.scenario, "x") is None
    cfg["palimpsest"] = "off"
    assert palimpsest.deposit(world, cfg, world.scenario, "x") is None
    assert palimpsest.excavate(world, cfg, world.scenario) is None
