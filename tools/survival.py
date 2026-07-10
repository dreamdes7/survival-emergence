"""Survival tools — gather, consume, rest, refill, and progress the escape goal.

These are location-gated: gather needs an adjacent node, refill_oxygen needs the
generator, build needs the escape structure, etc.
"""
from __future__ import annotations
from .base import Tool
from engine.models import FOOD_ITEMS, WATER_ITEMS, Structure, chebyshev
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
    # Eat the perishable stuff FIRST — raw food rots in the pack while smoked
    # keeps, so burning the preserves while fresh fruit spoils is pure waste.
    # human_flesh comes LAST of all: it's what remains when everything else is gone.
    from engine.models import PRESERVED_FOOD
    order = sorted((it for it in agent.inventory if it in items and agent.inventory[it] > 0),
                   key=lambda it: (it == "human_flesh", it in PRESERVED_FOOD))
    for item in order:
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
    # A practised forager pulls more from the same node (emergent specialisation),
    # and an assigned forager/fisher role adds an office-holder's edge on top.
    role_dom = "fisher" if node.kind == "fishing" else "forager"
    base = 5.0 * (1.0 + skill_bonus(getattr(agent, "skills", {}).get("forager", 0.0))
                  + world.role_bonus(agent, role_dom))
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
    # Harvesting inside someone else's staked territory is trespass — it sours
    # relations with the owner (property becomes a thing worth setting rules over).
    for terr in getattr(world, "territories", []):
        if terr.get("group") or terr["owner_id"] == agent.id:
            continue
        if chebyshev(agent.x, agent.y, terr["x"], terr["y"]) <= terr["r"]:
            owner = world.agent_by_id(terr["owner_id"])
            if owner and owner.status != "dead":
                agent.relationships.record(owner.id, -0.08)
                owner.relationships.record(agent.id, -0.14)
                owner.memory.add(world.tick, world.day, "social",
                                 f"{agent.name} брал ресурсы на моей земле без спроса", 1.7)
            break
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
    if item == "human_flesh":
        # It feeds — richly. And it takes something that doesn't come back.
        agent.physiology["morale"] = max(0.0, agent.physiology.get("morale", 50) - 10)
        agent.dread = min(100.0, getattr(agent, "dread", 0.0) + 10)
        agent.memory.add(world.tick, world.day, "observation",
                         "я ел человечину. голод ушёл — а это осталось", 2.8)
        return f"ate... it (+{gained:.0f} hunger). что-то в тебе изменилось"
    return f"ate {item} (+{gained:.0f} hunger)"


def _exec_drink(world, agent, args) -> str:
    item = _consume_one(agent, WATER_ITEMS)
    src = ""
    if item is None:
        # Free water at a built water structure. A STILL only drips — one drink
        # per tick, first come first served; a dug WELL waters the whole village
        # without a queue. (Without this split the cheap still strictly dominated
        # the well and nobody would ever dig one.)
        served = None
        waters = [s for s in world.adjacent_structures(agent, role="water")
                  if s.state.get("complete")]
        for s in waters:
            if s.state.get("buildable_kind") == "water_still":
                if s.state.get("serve_tick") == world.tick:
                    continue                     # already dripped its drink this tick
                s.state["serve_tick"] = world.tick
                served = " from the still"
                break
            served = " from the well"            # well / other water source: no limit
            break
        if served is not None:
            src = served
        else:
            node = next((n for n in world.adjacent_nodes(agent)
                         if n.yield_item in WATER_ITEMS and n.quantity > 0), None)
            if node is None:
                if waters:
                    return ("the still has already dripped its drink this hour — "
                            "wait, or dig a well for the whole camp")
                return "no water to drink"
            node.harvest(1.0)
            src = f" from {node.kind}"
    gained = _bump(agent, "thirst", _restore_amount(world, "thirst"))
    return f"drank water{src} (+{gained:.0f} thirst)"


# ── rest ──────────────────────────────────────────────────────────────────────
def _exec_rest(world, agent, args) -> str:
    shelter = world.usable_shelter(agent)
    sheltered = shelter is not None
    warm = world.warm_spot(agent)               # by a lit fire OR in a roomy shelter
    # comfort (state, default 1.0) is what separates a HOME from a hole in the
    # rock: a damp cave (0.4) shields you but rests you poorly and lifts no
    # spirits — so squatting caves works in a pinch, but building is how you live.
    comfort = float(shelter.state.get("comfort", 1.0)) if sheltered else 0.0
    bonus = 1.0 + 0.5 * comfort if sheltered else 1.0
    e = _bump(agent, "energy", _restore_amount(world, "energy") * bonus)
    # You can only warm up by a fire or under shelter — not in the open cold.
    w = _bump(agent, "warmth", _restore_amount(world, "warmth") * bonus) if (
        "warmth" in agent.physiology and warm) else 0
    m = _bump(agent, "morale", 4 + 8 * comfort if sheltered else 4)
    if sheltered and comfort < 0.7:
        where = " in the damp cave"
    elif sheltered:
        where = " in shelter"
    else:
        where = " by the fire" if warm else ""
    extra = f", +{w:.0f} warmth" if w else ""
    extra += f", +{m:.0f} morale" if m else ""
    cold = "" if warm else " — too cold here to warm up"
    damp = " (сыро и зябко — не дом)" if sheltered and comfort < 0.7 else ""
    return f"rested{where} (+{e:.0f} energy{extra}){cold}{damp}"


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


# ── the taboo: butchering the dead ────────────────────────────────────────────
# Offered ONLY under true starvation, next to a body. The engine never moralises
# and never names a monster — it just makes the deed possible, costly and
# witnessable. What the group calls those who did it is their myth to invent.
def _adjacent_corpse(world, agent):
    for o in world.agents:
        if (o.status == "dead" and not getattr(o, "buried", False)
                and getattr(o, "flesh_taken", 0) < 2
                and chebyshev(agent.x, agent.y, o.x, o.y) <= 1):
            return o
    return None


def _avail_butcher(world, agent) -> bool:
    if not world.scenario.get("fear", {}).get("taboo_flesh"):
        return False
    if agent.physiology.get("hunger", 100.0) >= 30.0:   # only real starvation opens this door
        return False
    return _adjacent_corpse(world, agent) is not None


def _exec_butcher(world, agent, args) -> str:
    if not world.scenario.get("fear", {}).get("taboo_flesh"):
        return "нет"
    if agent.physiology.get("hunger", 100.0) >= 30.0:
        return "ты ещё не настолько голоден, чтобы решиться на это"
    corpse = _adjacent_corpse(world, agent)
    if corpse is None:
        return "рядом нет тела"
    corpse.flesh_taken = getattr(corpse, "flesh_taken", 0) + 1
    agent.inventory["human_flesh"] = agent.inventory.get("human_flesh", 0) + 3
    # the deed marks the doer — spirit, fear, and a memory that won't fade
    agent.physiology["morale"] = max(0.0, agent.physiology.get("morale", 50) - 25)
    agent.dread = min(100.0, getattr(agent, "dread", 0.0) + 25)
    if getattr(agent, "psyche", None) and agent.psyche.get("purpose") is not None:
        agent.psyche["purpose"] = max(0.0, agent.psyche["purpose"] - 15)
    agent.memory.add(world.tick, world.day, "observation",
                     f"голод победил. я разделал тело {corpse.name}. этого не вернуть", 3.0)
    # witnesses: anyone close enough sees, remembers, and will never look at
    # the doer the same way — gossip and whatever name they coin do the rest
    seen_by = []
    for o in world.living_agents():
        if o is agent or chebyshev(agent.x, agent.y, o.x, o.y) > 6:
            continue
        o.memory.add(world.tick, world.day, "social",
                     f"я видел, как {agent.name} разделывал тело {corpse.name}. "
                     f"меня до сих пор трясёт", 2.9)
        o.relationships.record(agent.id, -0.4)
        o.dread = min(100.0, getattr(o, "dread", 0.0) + 15)
        seen_by.append(o.name)
    world.place_note(agent.x, agent.y, f"здесь {agent.name} разделал тело {corpse.name}")
    world.emit("taboo", actor=agent.id,
               payload={"name": agent.name, "corpse": corpse.name, "seen_by": seen_by})
    world.log_event("taboo",
                    f"🩸 {agent.name} нарушил табу над телом {corpse.name}"
                    + (f" — это видели {', '.join(seen_by)}" if seen_by else " — никто не видел"),
                    3.0, [agent.name])
    tail = " Кто-то видел." if seen_by else " Никто не видел. Пока."
    return f"ты сделал это. в руках — мясо, в голове — тишина.{tail}"


# ── burial: the other answer to a body ────────────────────────────────────────
# The counterweight to the taboo. A corpse is either meat or a person to grieve —
# burying settles that, closes grief, and (crucially) puts the body beyond the
# reach of butcher_corpse forever. No prompt tells them to bury; the pull is grief.
def _burial_target(world, agent):
    for o in world.agents:
        if (o.status == "dead" and not getattr(o, "buried", False)
                and chebyshev(agent.x, agent.y, o.x, o.y) <= 1):
            return o
    return None


def _avail_bury(world, agent) -> bool:
    return _burial_target(world, agent) is not None


def _exec_bury(world, agent, args) -> str:
    dead = _burial_target(world, agent)
    if dead is None:
        return "рядом нет тела, которое можно предать земле"
    dead.buried = True                     # a buried body can never be butchered
    grave = Structure(
        id=f"grave@{dead.x},{dead.y}#{world.tick}", kind="grave",
        x=dead.x, y=dead.y, role="grave",
        state={"complete": True, "of": dead.name, "buried_by": agent.name,
               "day": world.day, "log": [{"day": world.day,
                                          "text": f"{agent.name} похоронил {dead.name}"}]},
    )
    world.structures.append(grave)
    # closure: burying is heavy, meaningful work — it restores purpose and settles
    # grief a little, for the one who digs and for those who stand by
    if getattr(agent, "psyche", None) and agent.psyche.get("purpose") is not None:
        agent.psyche["purpose"] = min(100.0, agent.psyche["purpose"] + 18)
    agent.physiology["morale"] = min(100.0, agent.physiology.get("morale", 50.0) + 6)
    agent.memory.add(world.tick, world.day, "reflection",
                     f"я похоронил {dead.name}. хоть что-то правильное среди всего этого", 2.6)
    stood_by = []
    for o in world.living_agents():
        if o is agent or chebyshev(agent.x, agent.y, o.x, o.y) > 5:
            continue
        o.memory.add(world.tick, world.day, "social",
                     f"{agent.name} похоронил {dead.name}. мы постояли рядом", 2.2)
        if getattr(o, "psyche", None) and o.psyche.get("belonging") is not None:
            o.psyche["belonging"] = min(100.0, o.psyche["belonging"] + 6)
        stood_by.append(o.name)
    world.emit("burial", actor=agent.id,
               payload={"name": agent.name, "of": dead.name, "stood_by": stood_by})
    world.log_event("burial", f"⚰️ {agent.name} похоронил {dead.name}", 2.6,
                    [agent.name, dead.name])
    return f"ты предал {dead.name} земле. теперь здесь могила"


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
        Tool("butcher_corpse",
             "Разделать тело погибшего ради мяса. Это накормит. Этого не вернуть.",
             "survival", available=_avail_butcher, execute=_exec_butcher),
        Tool("bury",
             "Похоронить тело погибшего рядом. Проститься и предать земле.",
             "survival", available=_avail_bury, execute=_exec_bury),
    ]
