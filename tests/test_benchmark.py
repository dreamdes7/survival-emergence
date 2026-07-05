"""Sprint 4: split thinking, ToM probes, leaderboard aggregation. All offline —
the OpenRouter client's HTTP layer is stubbed out."""
from __future__ import annotations
import json

from engine.probes import run_tom_probes, score_guesses, tom_summary
from analysis.leaderboard import aggregate
from llm.openrouter import BudgetTracker, OpenRouterLLM
from llm.stub import HeuristicLLM
from conftest import build_sim


def _client(**kw) -> OpenRouterLLM:
    return OpenRouterLLM(fallback=HeuristicLLM(), budget=BudgetTracker(),
                         api_key="test-key", **kw)


class _CannedHTTP:
    """Replaces _post_with_retry; returns queued responses and records calls."""
    def __init__(self, responses: list[str]) -> None:
        self.responses = list(responses)
        self.calls: list[dict] = []

    def __call__(self, model: str, messages: list[dict], retries: int = 2) -> dict:
        self.calls.append({"model": model, "messages": messages})
        content = self.responses.pop(0) if self.responses else self.responses_fallback()
        return {"choices": [{"message": {"content": content}}], "usage": {}}

    @staticmethod
    def responses_fallback() -> str:
        return json.dumps({"thought": "ok", "tool": "wander", "args": {}})


PLAN_JSON = json.dumps({"goal": "построить костёр до ночи",
                        "steps": ["набрать дров", "найти камни", "разжечь"]})
ACT_JSON = json.dumps({"thought": "иду за дровами", "tool": "wander", "args": {}})


def test_split_thinking_deliberates_once_then_goes_fast():
    world, _, _ = build_sim({"seed": 6})
    agent = world.agents[0]
    agent.model = "test/model"
    client = _client(thinking="split", deliberate_every=6)
    http = _CannedHTTP([PLAN_JSON, ACT_JSON, ACT_JSON])
    client._post_with_retry = http  # type: ignore[method-assign]

    world.tick = 0
    d1 = client.decide(agent, world)
    assert d1["_source"] == "llm"
    assert agent.plan is not None and agent.plan["goal"].startswith("построить")
    assert len(http.calls) == 2, "first tick = deliberation + fast decision"
    # Fast prompt must carry the plan and be smaller than the full decide prompt.
    fast_user = http.calls[1]["messages"][1]["content"]
    assert "ТВОЙ ПЛАН НА ДЕНЬ" in fast_user
    full_user = client._build_messages(agent, world, fast=False)[1]["content"]
    assert len(fast_user) < len(full_user)

    world.tick = 1
    client.decide(agent, world)
    assert len(http.calls) == 3, "plan is fresh — no second deliberation"

    world.tick = 6            # plan is stale now
    http.responses = [PLAN_JSON, ACT_JSON]
    client.decide(agent, world)
    assert len(http.calls) == 5, "stale plan triggers a new deliberation"
    assert [e for e in world.events if e["kind"] == "plan"]


def test_full_thinking_unchanged():
    world, _, _ = build_sim({"seed": 6})
    agent = world.agents[0]
    agent.model = "test/model"
    client = _client(thinking="full")
    http = _CannedHTTP([ACT_JSON])
    client._post_with_retry = http  # type: ignore[method-assign]
    client.decide(agent, world)
    assert len(http.calls) == 1 and agent.plan is None


def test_tom_probe_scores_against_ground_truth():
    world, _, _ = build_sim({"seed": 9, "agents": 3})
    a, b, c = world.agents
    a.model = "test/model"
    # Ground truth: b considers a an ally, c considers a a rival.
    b.relationships.record(a.id, +0.9)
    c.relationships.record(a.id, -0.9)
    assert b.relationships.get(a.id).label == "ally"
    assert c.relationships.get(a.id).label == "rival"

    client = _client()
    # The model gets b right and c wrong -> accuracy 0.5.
    guesses = json.dumps({b.name: "друг", c.name: "друг"})
    client._post_with_retry = _CannedHTTP([guesses])  # type: ignore[method-assign]
    results = run_tom_probes(world, client)

    assert len(results) == 1, "only the real-LLM agent is probed"
    assert results[0]["accuracy"] == 0.5
    assert world.tom_scores[a.id] == [0.5]
    summary = tom_summary(world)
    assert summary["mean"] == 0.5 and summary["by_model"]["test/model"] == 0.5
    assert [e for e in world.events if e["kind"] == "tom_probe"]


def test_score_guesses_normalises_synonyms():
    truth = {"Боря": "друг", "Кира": "соперник", "Ума": "нейтрален"}
    guesses = {"Боря": "ally", "Кира": "враг", "Ума": "stranger"}
    assert score_guesses(guesses, truth) == 1.0


def test_leaderboard_groups_by_model(tmp_path):
    def fake_run(name: str, model: str, survivors: int, total: int,
                 tom: float | None, tainted: bool) -> None:
        d = tmp_path / name
        d.mkdir()
        meta = {
            "models": [model], "agents": [{"id": f"A{i}", "model": model} for i in range(total)],
            "survivors": [f"a{i}" for i in range(survivors)], "escaped": False,
            "provenance": {"heuristic_share": 0.1}, "tainted": tainted,
            "culture": {"memes": {"count": 4}, "stories": {"myths": 1}},
            "llm_usage": {"cost_usd": 0.5},
        }
        if tom is not None:
            meta["tom"] = {"mean": tom}
        (d / "meta.json").write_text(json.dumps(meta), encoding="utf-8")

    fake_run("r1", "model/a", 5, 5, 0.8, False)
    fake_run("r2", "model/a", 3, 5, 0.6, False)
    fake_run("r3", "model/b", 2, 5, 0.3, True)

    rows = aggregate([tmp_path / "r1", tmp_path / "r2", tmp_path / "r3"])
    assert [r["model"] for r in rows] == ["model/a", "model/b"]
    a_row = rows[0]
    assert a_row["runs"] == 2 and abs(a_row["survival"] - 0.8) < 1e-9
    assert abs(a_row["tom"] - 0.7) < 1e-9
    assert rows[1]["tainted"] == 1
