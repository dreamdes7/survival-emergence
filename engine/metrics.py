"""AWI-style indicators from SPEC.md."""
from __future__ import annotations


def _clamp01(v: float) -> float:
    return max(0.0, min(1.0, v))


def _gini(values: list[float]) -> float:
    if not values or sum(values) <= 0:
        return 0.0
    vals = sorted(values)
    n = len(vals)
    weighted = sum((i + 1) * v for i, v in enumerate(vals))
    return (2 * weighted) / (n * sum(vals)) - (n + 1) / n


def awi_metrics(world) -> dict:
    total_agents = max(1, len(world.agents))
    living = len(world.living_agents())
    visited = set()
    relationship_edges = 0
    rival_edges = 0
    diary_count = 0
    inventory_values: list[float] = []

    for agent in world.agents:
        visited.update(getattr(agent, "visited", set()))
        relationship_edges += len(agent.relationships.rel)
        rival_edges += sum(1 for r in agent.relationships.rel.values() if r.label == "rival")
        diary_count += len(agent.memory.diary)
        inventory_values.append(sum(agent.inventory.values()))

    possible_edges = max(1, total_agents * (total_agents - 1))
    tool_count = sum(world.tool_usage.values())
    total_tools = max(1, len(world.tools.all()))
    escape_required = float(world.scenario.get("escape", {}).get("required_progress", 100) or 100)

    indicators = {
        "population_survival_rate": living / total_agents,
        "safety": 1.0 - _clamp01(rival_edges / possible_edges),
        "map_exploration_coverage": len(visited) / max(1, world.size * world.size),
        "tool_usage_diversity": len(world.tool_usage) / total_tools if tool_count else 0.0,
        "governance_participation_rate": len(getattr(world, "gov_participants", ())) / total_agents,
        "cultural_output": _clamp01(diary_count / max(1, total_agents * max(1, world.day))),
        "social_graph_density": relationship_edges / possible_edges,
        "economic_activity": _clamp01(world.barter_count / max(1, world.tick + 1)),
        "escape_progress": _clamp01(world.escape_progress / escape_required),
    }
    out = {
        "indicators": indicators,
        "gini_inventory": _gini(inventory_values),
        "tool_usage": dict(world.tool_usage),
        "barter_count": world.barter_count,
    }
    # Culture as data (Sprint 3): memes / story chains / currency experiment.
    culture = getattr(world, "culture", None)
    if culture is not None:
        out["culture"] = culture.summary(world)
    return out
