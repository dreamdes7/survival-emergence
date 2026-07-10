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


# ── feast: share a store of food at the fire — a costly gift that binds the group ──
def _lit_fire_near(world, agent):
    for s in world.structures:
        if (s.role == "campfire" and s.state.get("complete")
                and s.state.get("fuel", 0) > 0
                and chebyshev(agent.x, agent.y, s.x, s.y) <= 2):
            return s
    return None


def _feast_guests(world, agent):
    return [o for o in world.living_agents()
            if o is not agent and chebyshev(agent.x, agent.y, o.x, o.y) <= 2]


def _avail_host_feast(world, agent) -> bool:
    have = agent.inventory.get("food", 0) + agent.inventory.get("dried_food", 0)
    return (have >= 3 and _lit_fire_near(world, agent) is not None
            and len(_feast_guests(world, agent)) >= 2)


def _exec_host_feast(world, agent, args) -> str:
    if _lit_fire_near(world, agent) is None:
        return "нужен зажжённый костёр, чтобы собрать всех на пир"
    guests = _feast_guests(world, agent)
    if len(guests) < 2:
        return "не с кем пировать — нужны хотя бы двое рядом"
    # Spend up to 5 food from the host — dried first (it's the storable surplus),
    # then raw. Sharing PRECIOUS food (scarcity!) is a costly signal that bonds.
    spend, pool = 0, 5
    for item in ("dried_food", "food"):
        take = min(pool - spend, int(agent.inventory.get(item, 0)))
        if take > 0:
            agent.inventory[item] = agent.inventory.get(item, 0) - take
            if agent.inventory[item] <= 0:
                del agent.inventory[item]
            spend += take
    if spend < 3:
        return "не хватает еды на пир (нужно хотя бы 3)"
    world.feasts += 1
    if not world.feast_tradition and world.feasts >= 3:
        world.feast_tradition = True
    trad = world.feast_tradition
    # feed the guests and lift everyone's spirits; a tradition deepens the effect
    per = spend / max(1, len(guests))
    fill = (world.scenario.get("physiology", {}).get("hunger", {}).get("restore", 40)) * 0.5
    partakers = guests + [agent]
    for o in partakers:
        if "hunger" in o.physiology and o is not agent:
            o.physiology["hunger"] = min(100.0, o.physiology["hunger"] + fill * min(1.0, per))
        if "morale" in o.physiology:
            o.physiology["morale"] = min(100.0, o.physiology["morale"] + (16 if trad else 12))
        if o.psyche.get("belonging") is not None:
            o.psyche["belonging"] = min(100.0, o.psyche["belonging"] + (18 if trad else 14))
        o.relationships.record(agent.id, +0.06)
        o.memory.add(world.tick, world.day, "social",
                     f"{agent.name} устроил пир у костра — мы ели вместе", 2.2)
    # the host leaves a mark: generosity is esteem + meaning
    if agent.psyche.get("esteem") is not None:
        agent.psyche["esteem"] = min(100.0, agent.psyche["esteem"] + 14)
    if agent.psyche.get("purpose") is not None:
        agent.psyche["purpose"] = min(100.0, agent.psyche["purpose"] + 12)
    agent.memory.add(world.tick, world.day, "social",
                     f"я устроил пир и накормил {len(guests)} человек", 2.4)
    world.log_event("feast",
                    f"🔥 {agent.name} устроил пир у костра — {len(guests)} сотрапезников"
                    + (" (уже традиция)" if trad else ""), 2.6,
                    [agent.name] + [g.name for g in guests])
    world.emit("feast", actor=agent.id,
               payload={"guests": len(guests), "spent": spend, "tradition": trad})
    tail = " Это уже стало традицией." if trad else ""
    return f"устроил пир на {len(guests)} человек, отдал {spend} еды.{tail}"


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
        Tool("host_feast",
             "Share your food with everyone at the fire — a costly gift that lifts the "
             "whole group's spirits; repeated, it becomes a ritual.",
             "culture", {},
             available=_avail_host_feast, execute=_exec_host_feast),
    ]
