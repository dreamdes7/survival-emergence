"""Tool registry gating + the run recorder's on-disk contract."""
from __future__ import annotations
import json

from engine.event_log import RunRecorder
from engine.serialize import world_manifest
from conftest import build_sim, run_ticks


def test_wait_tool_is_registered_and_neutral():
    world, _, _ = build_sim()
    wait = world.tools.get("wait")
    assert wait is not None
    agent = world.agents[0]
    before = (agent.x, agent.y, dict(agent.inventory))
    result = world.tools.execute("wait", world, agent, {})
    after = (agent.x, agent.y, dict(agent.inventory))
    assert before == after, "wait must not mutate world state"
    assert "[error]" not in result and "[blocked]" not in result


def test_unknown_tool_is_reported_not_raised():
    world, _, _ = build_sim()
    result = world.tools.execute("nonexistent_tool", world, world.agents[0], {})
    assert result.startswith("[error]")


def test_available_is_subset_of_all():
    world, _, _ = build_sim()
    agent = world.agents[0]
    available = {t.name for t in world.tools.available(world, agent)}
    everything = {t.name for t in world.tools.all()}
    assert available <= everything and available, "availability gating is broken"


def test_manifest_matches_backend_sizes():
    world, _, _ = build_sim()
    man = world_manifest(world)
    from engine.models import structure_size
    for kind, entry in man["structures"].items():
        assert (entry["w"], entry["h"]) == structure_size(kind)


def test_recorder_writes_a_complete_run(tmp_path):
    world, llm, cfg = build_sim()
    rec = RunRecorder(world, cfg, world.scenario, root=tmp_path, log_llm=True)
    world.recorder = rec
    run_ticks(world, llm, 5)
    for t in range(5):
        rec.tick_metrics(world)     # exercise metrics writer
    rec.close(world)

    run_dir = rec.dir
    assert (run_dir / "meta.json").exists()
    assert (run_dir / "events.jsonl").exists()
    assert (run_dir / "metrics.jsonl").exists()

    meta = json.loads((run_dir / "meta.json").read_text(encoding="utf-8"))
    assert meta["mode"] == "debug"           # pure-stub run
    assert meta["tainted"] is False
    assert meta["provenance"]["total"] > 0

    # events.jsonl must contain decision records with a source.
    decisions = [json.loads(l) for l in (run_dir / "events.jsonl").read_text(encoding="utf-8").splitlines()
                 if l.strip() and json.loads(l)["kind"] == "decision"]
    assert decisions and all(d["payload"].get("source") for d in decisions)
