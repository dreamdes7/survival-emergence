"""Survival tools — gather, consume, rest, refill, and progress the escape goal.

These are location-gated: gather needs an adjacent node, refill_oxygen needs the
generator, build needs the escape structure, etc.
"""
from __future__ import annotations
from .base import Tool
from engine.models import FOOD_ITEMS, WATER_ITEMS
from engine.skills import skill_bonus


def _bump(agent, stat: str, amount: float) -> float:
    if stat not in agent.physiology:
        return 0.0
    before = agent.physiology[stat]
    agent.physiology[stat] = min(100.0, before + amount)
    return agent.physiology[stat] - before


def _restore_amount(world, stat: str, default: float = 40.0) -> float:
    return float(world.scenario["physiology"].get(stat, {}).get("restore", default))


def _consume_one(agent, items: set) -> str | None:
    for item in list(agent.inventory):
        if item in items and agent.inventory[item] > 0:
            agent.inventory[item] -= 1
            if agent.inventory[item] <= 0:
                del agent.inventory[item]
            return item
    return None


# ── gather ────────────────────────────────────────────────────────────────────
def _avail_gather(world, agent) -> bool:
    return bool(world.adjacent_nodes(agent))


def _exec_gather(world, agent, args) -> str:
    want = args.get("kind")
    nodes = world.adjacent_nodes(agent)
    if not nodes:
        return "nothing to gather here"
    node = next((n for n in nodes if want in (n.kind, n.yield_item)), nodes[0])
    # A practised forager pulls more from the same node (emergent specialisation).
    base = 5.0 * (1.0 + skill_bonus(getattr(agent, "skills", {}).get("forager", 0.0)))
    # Crafted tools are force-multipliers: an axe fells wood, a net hauls fish.
    if node.yield_item == "wood" and agent.inventory.get("axe", 0) > 0:
        base *= 2.0
    elif node.kind == "fishing" and agent.inventory.get("net", 0) > 0:
        base *= 2.0
    taken = node.harvest(base)
    if taken <= 0:
        return f"{node.kind} is depleted"
    agent.inventory[node.yield_item] = agent.inventory.get(node.yield_item, 0) + taken
    # Trespass: someone else claimed this node — ding both affinities.
    claim = getattr(world, "claims", {}).get(node.id)
    if claim and claim["owner_id"] != agent.id:
        agent.relationships.record(claim["owner_id"], -0.12)
        owner = world.agent_by_id(claim["owner_id"])
        if owner:
            owner.relationships.record(agent.id, -0.15)
            owner.memory.add(world.tick, world.day, "social",
                             f"{agent.name} trespassed on my {node.kind}", 1.8)
    # A chopped tree / mined rock is gone once emptied — frees its tile.
    spent = ""
    if node.consumable and node.quantity <= 0:
        world.nodes.remove(node)
        spent = f"; the {node.kind} is used up"
    return f"gathered {taken:.0f} {node.yield_item} from {node.kind}{spent}"


# ── eat / drink ───────────────────────────────────────────────────────────────
def _exec_eat(world, agent, args) -> str:
    item = _consume_one(agent, FOOD_ITEMS)
    if item is None:
        return "no food to eat"
    mult = 1.6 if item == "dried_food" else 1.0     # smoked food fills you more
    gained = _bump(agent, "hunger", _restore_amount(world, "hunger") * mult)
    return f"ate {item} (+{gained:.0f} hunger)"


def _exec_drink(world, agent, args) -> str:
    item = _consume_one(agent, WATER_ITEMS)
    src = ""
    if item is None:
        # free water at a built water still
        if any(s.state.get("complete") for s in world.adjacent_structures(agent, role="water")):
            src = " from the still"
        else:
            node = next((n for n in world.adjacent_nodes(agent)
                         if n.yield_item in WATER_ITEMS and n.quantity > 0), None)
            if node is None:
                return "no water to drink"
            node.harvest(1.0)
            src = f" from {node.kind}"
    gained = _bump(agent, "thirst", _restore_amount(world, "thirst"))
    return f"drank water{src} (+{gained:.0f} thirst)"


# ── rest ──────────────────────────────────────────────────────────────────────
def _exec_rest(world, agent, args) -> str:
    sheltered = world.usable_shelter(agent) is not None
    warm = world.warm_spot(agent)               # by a lit fire OR in a roomy shelter
    bonus = 1.5 if sheltered else 1.0
    e = _bump(agent, "energy", _restore_amount(world, "energy") * bonus)
    # You can only warm up by a fire or under shelter — not in the open cold.
    w = _bump(agent, "warmth", _restore_amount(world, "warmth") * bonus) if (
        "warmth" in agent.physiology and warm) else 0
    m = _bump(agent, "morale", 12 if sheltered else 4)
    where = " in shelter" if sheltered else (" by the fire" if warm else "")
    extra = f", +{w:.0f} warmth" if w else ""
    extra += f", +{m:.0f} morale" if m else ""
    cold = "" if warm else " — too cold here to warm up"
    return f"rested{where} (+{e:.0f} energy{extra}){cold}"


# ── refill oxygen (Mars) ──────────────────────────────────────────────────────
def _avail_refill(world, agent) -> bool:
    return "oxygen" in agent.physiology and bool(
        world.adjacent_structures(agent, role="refill_oxygen"))


def _exec_refill(world, agent, args) -> str:
    if not world.adjacent_structures(agent, role="refill_oxygen"):
        return "no oxygen generator nearby"
    gained = _bump(agent, "oxygen", _restore_amount(world, "oxygen", 100))
    return f"refilled oxygen (+{gained:.0f})"


# ── build / repair the escape ─────────────────────────────────────────────────
def _avail_build(world, agent) -> bool:
    return bool(world.adjacent_structures(agent, role="escape"))


def _exec_build(world, agent, args) -> str:
    structs = world.adjacent_structures(agent, role="escape")
    if not structs:
        return "not at the escape site"
    esc = world.scenario["escape"]
    req_item = esc.get("requires_item")
    if req_item:
        if agent.inventory.get(req_item, 0) < 1:
            return f"need {req_item} to work on the escape"
        agent.inventory[req_item] -= 1
        if agent.inventory[req_item] <= 0:
            del agent.inventory[req_item]
    struct = structs[0]
    # The escape is the great shared labour: a lone worker barely moves it, a crew
    # raises it together. Builder skill helps too.
    rate = float(esc.get("work_rate", 5)) * (
        1.0 + skill_bonus(getattr(agent, "skills", {}).get("builder", 0.0)))
    crew = sum(1 for o in world.living_agents() if world.adjacent_to_structure(o, struct))
    rate *= 0.5 if crew <= 1 else (1.0 + 0.3 * (crew - 1))
    struct.state["progress"] = struct.state.get("progress", 0.0) + rate
    world.escape_progress = struct.state["progress"]
    req = float(esc.get("required_progress", 100))
    if struct.state["progress"] >= req:
        world.mark_escaped(agent)
        return f"completed the escape ({esc['action']})! progress {req:.0f}/{req:.0f}"
    agent.memory.add(world.tick, world.day, "action",
                     f"worked on {esc['action']} ({struct.state['progress']:.0f}/{req:.0f})", 2.0)
    return f"worked on {esc['action']} ({struct.state['progress']:.0f}/{req:.0f})"


def build_survival_tools() -> list[Tool]:
    return [
        Tool("gather", "Harvest from an adjacent resource node.", "survival",
             {"kind": "resource or item kind (optional)"},
             available=_avail_gather, execute=_exec_gather),
        Tool("eat", "Eat food from your inventory.", "survival", execute=_exec_eat),
        Tool("drink", "Drink water from inventory, a water still, or an adjacent water source.", "survival", execute=_exec_drink),
        Tool("rest", "Recover energy (faster in shelter).", "survival", execute=_exec_rest),
        Tool("refill_oxygen", "Refill oxygen at a generator.", "survival",
             available=_avail_refill, execute=_exec_refill),
        Tool("build", "Work on the escape structure.", "survival",
             available=_avail_build, execute=_exec_build),
    ]
