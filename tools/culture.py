"""Culture tools — naming places.

A name is coined for the spot an agent stands on; it then spreads on its own as
other survivors pass through it (see World._resolve_emergent). Once enough of the
group recognises it, the name becomes shared geography — the first real culture.
"""
from __future__ import annotations
from .base import Tool
from engine.models import chebyshev


def _named_here(world, agent) -> bool:
    return any(chebyshev(agent.x, agent.y, pn["x"], pn["y"]) <= 4 for pn in world.placenames)


def _notable_here(world, agent) -> bool:
    """Worth naming: a structure, a live resource, or company — not empty sand."""
    if any(world.adjacent_to_structure(agent, s) for s in world.structures):
        return True
    if any(chebyshev(agent.x, agent.y, n.x, n.y) <= 2 and n.quantity > 0 for n in world.nodes):
        return True
    return any(o is not agent and o.status != "dead"
               and chebyshev(agent.x, agent.y, o.x, o.y) <= 1 for o in world.agents)


def _avail_name_place(world, agent) -> bool:
    return (not _named_here(world, agent)) and _notable_here(world, agent)


def _exec_name_place(world, agent, args) -> str:
    name = str(args.get("name") or args.get("text") or "").strip()
    if not name:
        return "как назвать это место?"
    if _named_here(world, agent):
        return "у этого места уже есть имя"
    world.placenames.append({
        "name": name, "x": agent.x, "y": agent.y,
        "by": agent.name, "by_id": agent.id, "tick": world.tick,
        "endorsers": [agent.id], "famous": False,
    })
    agent.memory.add(world.tick, world.day, "social", f"я назвал это место «{name}»", 1.7)
    return f"ты назвал это место «{name}» — посмотрим, приживётся ли"


def build_culture_tools() -> list[Tool]:
    return [
        Tool("name_place",
             "Give the spot you're standing on a name; it spreads as others pass through.",
             "culture", {"name": "the name"},
             available=_avail_name_place, execute=_exec_name_place),
    ]
