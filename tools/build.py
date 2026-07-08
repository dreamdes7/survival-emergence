"""Construction tools.

Agents build structures from gathered materials. Starting a build pays the cost,
then future build_structure calls add progress until the structure becomes
functional. Build placement is footprint-aware and matches frontend rendering.
"""
from __future__ import annotations
from .base import Tool
from engine.models import Structure, chebyshev
from engine.skills import skill_bonus


def _warm_nearby(world, fire, warmth: float = 18.0, morale: float = 5.0) -> None:
    for other in world.living_agents():
        if chebyshev(other.x, other.y, fire.x, fire.y) <= 2:
            if "warmth" in other.physiology:
                other.physiology["warmth"] = min(100.0, other.physiology["warmth"] + warmth)
            if "morale" in other.physiology:
                other.physiology["morale"] = min(100.0, other.physiology["morale"] + morale)


def _buildables(world) -> dict:
    return world.scenario.get("buildables", {})


# Where each raw material comes from — so a blocked build tells the survivor what
# to actually DO, instead of dead-ending on "need 2 stone".
_SOURCE_HINT = {
    "stone": "добудь из скал (rocks) на нагорье",
    "wood": "нарубить дров у деревьев/пальм",
    "fiber": "собрать волокно в зарослях (thicket)",
    "food": "собрать у фруктовых деревьев",
}


def _blocked_msg(world, agent, kind: str, missing: list[str]) -> str:
    """A build is blocked: name the missing materials, WHERE to get each, and
    what the survivor could build right now with what they already carry."""
    src = "; ".join(f"{m}: {_SOURCE_HINT[m.split()[-1]]}"
                    for m in missing if m.split()[-1] in _SOURCE_HINT)
    affordable = [k for k, sp in _buildables(world).items()
                  if k != kind and all(agent.inventory.get(it, 0) >= q
                                        for it, q in sp.get("cost", {}).items())]
    tail = f" ({src})" if src else ""
    alt = f" Сейчас по ресурсам можешь построить: {', '.join(affordable)}." if affordable else ""
    return f"need {', '.join(missing)} to start a {kind}{tail}.{alt}"


def _adjacent_unfinished(world, agent, kind: str):
    for s in world.structures:
        if (s.state.get("buildable_kind") == kind and not s.state.get("complete")
                and world.adjacent_to_structure(agent, s)):
            return s
    return None


def _exec_build_structure(world, agent, args) -> str:
    kind = args.get("kind", "")
    spec = _buildables(world).get(kind)
    if spec is None:
        opts = ", ".join(_buildables(world).keys()) or "none"
        return f"can't build '{kind}'. buildable here: {opts}"

    s = _adjacent_unfinished(world, agent, kind)
    if s is None:
        site = world.find_clear_structure_site(kind, agent.x, agent.y, radius=4)
        if site is None:
            return "no clear ground here to build on"
        build_x, build_y = site

        cost = spec.get("cost", {})
        missing = [f"{q:g} {it}" for it, q in cost.items() if agent.inventory.get(it, 0) < q]
        if missing:
            return _blocked_msg(world, agent, kind, missing)
        for it, q in cost.items():
            agent.inventory[it] -= q
            if agent.inventory[it] <= 0:
                del agent.inventory[it]
        st = {"buildable_kind": kind, "progress": 0.0, "complete": False}
        if "capacity" in spec:
            st["capacity"] = spec["capacity"]
        s = Structure(
            id=f"{kind}@{build_x},{build_y}#{world.tick}", kind=kind,
            x=build_x, y=build_y, role=spec.get("role", ""), state=st,
        )
        world.structures.append(s)
        agent.memory.add(world.tick, world.day, "action", f"started building a {kind}", 1.8)

    # A practised builder lays more progress per tick…
    rate = float(spec.get("work_rate", 10)) * (
        1.0 + skill_bonus(getattr(agent, "skills", {}).get("builder", 0.0)))
    # …and many hands raise a structure far faster. "Heavy" builds barely move
    # solo — they need a crew, which forces survivors to coordinate at one spot.
    crew = sum(1 for o in world.living_agents() if world.adjacent_to_structure(o, s))
    heavy = bool(spec.get("heavy"))
    if heavy:
        team = 0.5 if crew <= 1 else (1.0 + 0.3 * (crew - 1))
    else:
        team = 1.0 + 0.15 * (crew - 1)
    rate *= team
    req = float(spec.get("required_progress", 30))
    s.state["progress"] = min(req, s.state.get("progress", 0.0) + rate)
    if s.state["progress"] >= req:
        s.state["complete"] = True
        if s.role == "campfire":
            s.state["fuel"] = 100.0
            _warm_nearby(world, s, warmth=22.0, morale=6.0)
        agent.memory.add(world.tick, world.day, "action", f"finished building a {kind}", 2.3)
        return f"finished the {kind}!"
    hint = " — это большая стройка, в одиночку медленно: позови других сюда" if (heavy and crew <= 1) else ""
    return f"worked on {kind} ({s.state['progress']:.0f}/{req:.0f}){hint}"


def _avail_maintain(world, agent) -> bool:
    return any(s.role == "campfire" and s.state.get("complete")
               and chebyshev(agent.x, agent.y, s.x, s.y) <= 2 for s in world.structures)


def _exec_maintain(world, agent, args) -> str:
    fires = [s for s in world.structures if s.role == "campfire" and s.state.get("complete")
             and chebyshev(agent.x, agent.y, s.x, s.y) <= 2]
    if not fires:
        return "no campfire here to tend"
    if agent.inventory.get("wood", 0) < 1:
        return "need wood to feed the fire"
    agent.inventory["wood"] -= 1
    if agent.inventory["wood"] <= 0:
        del agent.inventory["wood"]
    fires[0].state["fuel"] = min(100.0, fires[0].state.get("fuel", 0.0) + 50)
    _warm_nearby(world, fires[0])
    return "fed the fire - it crackles back to life"


def _adjacent_store(world, agent):
    for s in world.adjacent_structures(agent, role="store"):
        if s.state.get("complete"):
            return s
    return None


def _avail_store_tool(world, agent) -> bool:
    return _adjacent_store(world, agent) is not None


def _exec_stash(world, agent, args) -> str:
    s = _adjacent_store(world, agent)
    if s is None:
        return "no store here"
    item = args.get("item", "")
    qty = float(args.get("qty", 1))
    have = agent.inventory.get(item, 0)
    if have <= 0:
        return f"have no {item} to stash"
    qty = min(qty, have)
    agent.inventory[item] = have - qty
    if agent.inventory[item] <= 0:
        del agent.inventory[item]
    cache = s.state.setdefault("cache", {})
    cache[item] = cache.get(item, 0) + qty
    world.barter_count += 1
    return f"stashed {qty:.0f} {item} in the store"


def _exec_grab(world, agent, args) -> str:
    s = _adjacent_store(world, agent)
    if s is None:
        return "no store here"
    item = args.get("item", "")
    qty = float(args.get("qty", 1))
    cache = s.state.get("cache", {})
    have = cache.get(item, 0)
    if have <= 0:
        return f"the store has no {item}"
    qty = min(qty, have)
    cache[item] = have - qty
    if cache[item] <= 0:
        del cache[item]
    agent.inventory[item] = agent.inventory.get(item, 0) + qty
    return f"took {qty:.0f} {item} from the store"


def build_tools(world) -> list[Tool]:
    kinds = ", ".join(_buildables(world).keys()) or "none"
    return [
        Tool("build_structure", f"Build a structure ({kinds}); costs materials, takes time.",
             "build", {"kind": "what to build"}, execute=_exec_build_structure),
        Tool("maintain", "Feed wood to an adjacent campfire to keep it burning.",
             "build", available=_avail_maintain, execute=_exec_maintain),
        Tool("stash", "Put an item into an adjacent shared store.", "build",
             {"item": "item", "qty": "amount"}, available=_avail_store_tool, execute=_exec_stash),
        Tool("grab", "Take an item from an adjacent shared store.", "build",
             {"item": "item", "qty": "amount"}, available=_avail_store_tool, execute=_exec_grab),
    ]
