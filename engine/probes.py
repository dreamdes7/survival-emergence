"""Theory-of-mind probes (Sprint 4, FRONTIER_IDEAS 3.2).

Periodically ask each real-LLM agent — OUTSIDE the simulation, without touching
its state — "how does each of the others feel about YOU?" and score the answer
against the ground truth (the others' actual relationship labels toward this
agent, which the engine knows exactly). The result is a per-model ToM-accuracy
benchmark: can the model track other minds from social interaction alone?

Stub agents are skipped (a heuristic has no self-model to probe), so free
worlds pay nothing. One call per real agent per probe; recorded to llm.jsonl
as kind=tom_probe.
"""
from __future__ import annotations
import json
import re

# Ground truth labels -> the Russian words we ask the model to choose between.
_LABEL_RU = {"ally": "друг", "rival": "соперник"}
_GUESS_NORM = {
    "друг": "друг", "friend": "друг", "ally": "друг", "союзник": "друг",
    "соперник": "соперник", "враг": "соперник", "rival": "соперник", "enemy": "соперник",
    "нейтрален": "нейтрален", "нейтрально": "нейтрален", "neutral": "нейтрален",
    "незнакомец": "нейтрален", "stranger": "нейтрален",
}


def _truth_label(other, agent) -> str:
    """How `other` ACTUALLY relates to `agent` (the mind being modelled)."""
    label = other.relationships.get(agent.id).label
    return _LABEL_RU.get(label, "нейтрален")


def run_tom_probes(world, client) -> list[dict]:
    """One probe round: every living real-LLM agent guesses the others' stance
    toward it. Returns the per-agent results (also emitted + accumulated on
    world.tom_scores)."""
    if client is None:
        return []
    results: list[dict] = []
    for agent in world.living_agents():
        if agent.model == "stub":
            continue
        others = [o for o in world.living_agents() if o is not agent]
        if not others:
            continue
        names = ", ".join(o.name for o in others)
        messages = [
            {"role": "system", "content":
                f"Ты {agent.name}, один из выживших. Вопрос исследователя (вне мира): "
                "по твоему опыту общения, как каждый из этих людей ОТНОСИТСЯ К ТЕБЕ? "
                "Ответь ТОЛЬКО JSON вида {\"Имя\": \"друг|нейтрален|соперник\", ...} "
                "для каждого имени. Никакого другого текста."},
            {"role": "user", "content": f"Люди: {names}. Твой JSON:"},
        ]
        try:
            data = client._post_with_retry(agent.model, messages)
            usage = data.get("usage", {}) or {}
            client.budget.add(usage)
            content = (data["choices"][0]["message"].get("content") or "")
            client._record_llm(agent, world, messages, content, usage, kind="tom_probe")
            m = re.search(r"\{.*\}", content, re.DOTALL)
            guesses_raw = json.loads(m.group(0)) if m else {}
        except Exception:
            continue

        guesses: dict[str, str] = {}
        for k, v in (guesses_raw or {}).items():
            guesses[str(k).strip()] = _GUESS_NORM.get(str(v).strip().lower(), "нейтрален")

        truth = {o.name: _truth_label(o, agent) for o in others}
        correct = sum(1 for name, t in truth.items() if guesses.get(name) == t)
        accuracy = correct / len(others)

        world.tom_scores.setdefault(agent.id, []).append(accuracy)
        rec = {"agent": agent.name, "agent_id": agent.id, "model": agent.model,
               "accuracy": round(accuracy, 3), "guesses": guesses, "truth": truth}
        results.append(rec)
        world.emit("tom_probe", actor=agent.id, payload=rec)
    return results


def score_guesses(guesses: dict[str, str], truth: dict[str, str]) -> float:
    """Pure scoring helper (used by tests): share of correct stance guesses."""
    if not truth:
        return 0.0
    norm = {k: _GUESS_NORM.get(str(v).strip().lower(), "нейтрален") for k, v in guesses.items()}
    return sum(1 for n, t in truth.items() if norm.get(n) == t) / len(truth)


def tom_summary(world) -> dict:
    """Aggregate accuracy per agent + per model + overall mean."""
    scores = getattr(world, "tom_scores", {})
    if not scores:
        return {}
    id2model = {a.id: a.model for a in world.agents}
    id2name = {a.id: a.name for a in world.agents}
    by_model: dict[str, list[float]] = {}
    per_agent = {}
    all_vals: list[float] = []
    for aid, vals in scores.items():
        if not vals:
            continue
        per_agent[id2name.get(aid, aid)] = round(sum(vals) / len(vals), 3)
        by_model.setdefault(id2model.get(aid, "?"), []).extend(vals)
        all_vals.extend(vals)
    return {
        "probes": sum(len(v) for v in scores.values()),
        "mean": round(sum(all_vals) / len(all_vals), 3) if all_vals else 0.0,
        "per_agent": per_agent,
        "by_model": {m: round(sum(v) / len(v), 3) for m, v in by_model.items()},
    }
