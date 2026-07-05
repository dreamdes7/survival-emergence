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


# ── oral history: retell what you lived through (or what you heard) ───────────
def _near_listener(world, agent) -> bool:
    return any(o is not agent and o.status == "active"
               and chebyshev(agent.x, agent.y, o.x, o.y) <= 1 for o in world.agents)


def _exec_tell_story(world, agent, args) -> str:
    """Tell an adjacent agent a story IN YOUR OWN WORDS. The engine links each
    retelling into a story chain by textual overlap, so how the story drifts
    from teller to teller (the telephone game — and eventually myth) is measured,
    not imagined. The listener remembers the story as told, and can retell it."""
    story = str(args.get("story") or args.get("text") or "").strip()
    if not story:
        return "о чём история? расскажи её своими словами"
    listener = world.agent_by_name(args.get("target", ""))
    if listener is None or listener is agent or listener.status != "active":
        cands = [o for o in world.agents
                 if o is not agent and o.status == "active"
                 and chebyshev(agent.x, agent.y, o.x, o.y) <= 1]
        listener = cands[0] if cands else None
    if listener is None:
        return "рядом некому рассказывать"

    chain = world.culture.tell_story(world, agent, listener, story)
    # The listener remembers the story AS TOLD (kind=story so it can be retold),
    # attributed to the teller — the seed of subjective, drifting history.
    listener.memory.add(world.tick, world.day, "story",
                        f"история от {agent.name}: {story}", 2.1)
    world.culture.note_heard(listener, story)
    agent.memory.add(world.tick, world.day, "social",
                     f"я рассказал {listener.name} историю: {story[:80]}", 1.6)
    agent.relationships.record(listener.id, +0.05)
    listener.relationships.record(agent.id, +0.07)
    agent.last_said = story
    world.log_feed(agent, "speech", "", "tell_story",
                   f'said to {listener.name}: "{story}"')
    n = len(chain["versions"])
    return (f"рассказал {listener.name} историю"
            + (f" (она уже ходит по рукам — пересказ №{n})" if n > 1 else ""))


def build_culture_tools() -> list[Tool]:
    return [
        Tool("name_place",
             "Give the spot you're standing on a name; it spreads as others pass through.",
             "culture", {"name": "the name"},
             available=_avail_name_place, execute=_exec_name_place),
        Tool("tell_story",
             "Tell an adjacent agent a story from your past (or retell one you heard) "
             "in your own words — stories travel and change from teller to teller.",
             "culture", {"target": "agent name", "story": "the story, in your own words"},
             available=_near_listener, execute=_exec_tell_story),
    ]
