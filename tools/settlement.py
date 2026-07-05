"""Settlement tools — craft, cook, farm, post notices, scan, repair landmarks.

Each action is gated on standing next to the relevant FINISHED structure, so the
model is only offered it when it actually makes sense — tight coupling with the
world keeps the agents' decisions legible.
"""
from __future__ import annotations
from .base import Tool


def _at(world, agent, role: str):
    """Nearest finished adjacent structure of `role`, or None."""
    for s in world.adjacent_structures(agent, role=role):
        if s.state.get("complete", True):
            return s
    return None


def _take(agent, item: str, qty: float) -> None:
    agent.inventory[item] = agent.inventory.get(item, 0) - qty
    if agent.inventory[item] <= 0:
        del agent.inventory[item]


# ── workbench: craft tools ────────────────────────────────────────────────────
RECIPES = {
    "axe":   {"wood": 2, "flint": 1},   # fells wood twice as fast when gathering
    "spear": {"wood": 1, "flint": 1},   # a weapon and a tool of standing
    "net":   {"fiber": 2, "wood": 1},   # hauls twice the fish from a fishing spot
}


def _avail_craft(world, agent) -> bool:
    return _at(world, agent, "workbench") is not None


def _exec_craft(world, agent, args) -> str:
    if _at(world, agent, "workbench") is None:
        return "you need to be at a workbench to craft"
    tool = str(args.get("tool") or args.get("item") or "").strip().lower()
    rec = RECIPES.get(tool)
    if rec is None:
        return f"can't craft '{tool}'. you can make: {', '.join(RECIPES)}"
    missing = [f"{q:g} {it}" for it, q in rec.items() if agent.inventory.get(it, 0) < q]
    if missing:
        return f"need {', '.join(missing)} to craft a {tool}"
    for it, q in rec.items():
        _take(agent, it, q)
    agent.inventory[tool] = agent.inventory.get(tool, 0) + 1
    return f"crafted a {tool}"


# ── smokehouse: cook raw food into dried food ─────────────────────────────────
def _avail_cook(world, agent) -> bool:
    return (_at(world, agent, "smokehouse") is not None
            and agent.inventory.get("food", 0) >= 1 and agent.inventory.get("wood", 0) >= 1)


def _exec_cook(world, agent, args) -> str:
    if _at(world, agent, "smokehouse") is None:
        return "you need a smokehouse to cook"
    if agent.inventory.get("food", 0) < 1:
        return "no raw food to smoke"
    if agent.inventory.get("wood", 0) < 1:
        return "need a piece of wood to keep the smoke going"
    n = max(1, min(int(args.get("qty", 1) or 1), int(agent.inventory["food"])))
    _take(agent, "food", n)
    _take(agent, "wood", 1)
    agent.inventory["dried_food"] = agent.inventory.get("dried_food", 0) + n
    return f"smoked {n} food into dried food — it keeps and fills you more"


# ── garden: plant a seed, let it grow, harvest ────────────────────────────────
def _avail_plant(world, agent) -> bool:
    g = _at(world, agent, "garden")
    return g is not None and not g.state.get("planted") and agent.inventory.get("food", 0) >= 1


def _exec_plant(world, agent, args) -> str:
    g = _at(world, agent, "garden")
    if g is None:
        return "you need a garden plot to plant"
    if g.state.get("planted"):
        return "this plot is already growing a crop"
    if agent.inventory.get("food", 0) < 1:
        return "need a piece of food to sow as seed"
    _take(agent, "food", 1)
    g.state["planted"] = True
    g.state["mature_at"] = world.tick + world.day_length_ticks
    return "sowed a crop — it will be ready to harvest in about a day"


def _avail_harvest(world, agent) -> bool:
    g = _at(world, agent, "garden")
    return bool(g and g.state.get("planted") and world.tick >= g.state.get("mature_at", 1 << 30))


def _exec_harvest(world, agent, args) -> str:
    g = _at(world, agent, "garden")
    if g is None or not g.state.get("planted"):
        return "nothing is planted here"
    if world.tick < g.state.get("mature_at", 1 << 30):
        return "the crop is still growing"
    g.state["planted"] = False
    g.state.pop("mature_at", None)
    agent.inventory["food"] = agent.inventory.get("food", 0) + 3
    return "harvested 3 food from the garden"


# ── signpost: leave / read written messages ───────────────────────────────────
def _avail_post(world, agent) -> bool:
    return _at(world, agent, "signpost") is not None


def _exec_post(world, agent, args) -> str:
    s = _at(world, agent, "signpost")
    if s is None:
        return "you need a signpost to write on"
    msg = str(args.get("message") or args.get("text") or "").strip()
    if not msg:
        return "write a message to post"
    notes = s.state.setdefault("notes", [])
    notes.append({"by": agent.name, "text": msg[:120], "tick": world.tick})
    s.state["notes"] = notes[-8:]
    world.log_event("culture", f"{agent.name} оставил надпись: «{msg[:60]}»", 1.8, [agent.name])
    return f'posted on the signpost: "{msg[:70]}"'


def _avail_read(world, agent) -> bool:
    s = _at(world, agent, "signpost")
    return bool(s and s.state.get("notes"))


def _exec_read(world, agent, args) -> str:
    s = _at(world, agent, "signpost")
    if s is None or not s.state.get("notes"):
        return "nothing is written here"
    notes = s.state["notes"][-5:]
    for n in notes:
        agent.memory.add(world.tick, world.day, "observation",
                         f'на указателе написано: {n["by"]} — «{n["text"]}»', 1.2)
    return "the signpost reads — " + " | ".join(f'{n["by"]}: "{n["text"]}"' for n in notes)


# ── watchtower: scan the island from up high ──────────────────────────────────
def _avail_scan(world, agent) -> bool:
    return _at(world, agent, "lookout") is not None


def _exec_scan(world, agent, args) -> str:
    if _at(world, agent, "lookout") is None:
        return "you need to be on a watchtower to scan"
    for n in world.nodes:
        agent.known_nodes[n.id] = n
    for s in world.structures:
        agent.known_structures[s.id] = s
    # If something strange is out there, the height reveals its rough bearing.
    hint = ""
    for s in world.structures:
        if s.role == "anomaly":
            hint = f" Far to the {_bearing(agent, s)} something does not belong here."
            break
    return "from the watchtower you take in the whole island." + hint


def _bearing(agent, s) -> str:
    dx, dy = s.x - agent.x, s.y - agent.y
    ns = "north" if dy < -3 else "south" if dy > 3 else ""
    ew = "west" if dx < -3 else "east" if dx > 3 else ""
    return (ns + ("-" if ns and ew else "") + ew) or "near"


# ── repair an abandoned landmark (lighthouse / radio tower) ────────────────────
def _repair_targets(world, agent):
    return [s for s in world.structures
            if s.role in ("beacon", "signal") and not s.state.get("active")
            and world.adjacent_to_structure(agent, s)]


def _avail_repair(world, agent) -> bool:
    return len(_repair_targets(world, agent)) > 0


def _exec_repair(world, agent, args) -> str:
    targets = _repair_targets(world, agent)
    if not targets:
        return "there is nothing here to repair"
    s = targets[0]
    name = "lighthouse" if s.role == "beacon" else "radio tower"
    s.state["repair"] = s.state.get("repair", 0.0) + 10.0
    req = float(s.state.get("required", 60))
    if s.state["repair"] >= req:
        s.state["active"] = True
        world.log_event("build", f"{agent.name} починил {name} — он снова ожил!", 2.6, [agent.name])
        if s.role == "beacon":
            return "the lighthouse beam blazes to life — a beacon over the whole island"
        return "the radio crackles — it can broadcast again. is anyone out there?"
    return f"worked on the {name} ({s.state['repair']:.0f}/{req:.0f})"


def build_settlement_tools(world) -> list[Tool]:
    return [
        Tool("craft", f"At a workbench, craft a tool ({', '.join(RECIPES)}) from materials.",
             "build", {"tool": "what to craft"}, available=_avail_craft, execute=_exec_craft),
        Tool("cook", "At a smokehouse, smoke raw food into dried food (keeps, more filling).",
             "survival", {"qty": "how much"}, available=_avail_cook, execute=_exec_cook),
        Tool("plant", "At a garden, sow a piece of food as seed to grow more.",
             "build", available=_avail_plant, execute=_exec_plant),
        Tool("harvest_crop", "At a ripe garden, harvest the grown food.",
             "survival", available=_avail_harvest, execute=_exec_harvest),
        Tool("post", "Write a message on a signpost for others to read.",
             "social", {"message": "what to write"}, available=_avail_post, execute=_exec_post),
        Tool("read_sign", "Read the messages left on a signpost.",
             "social", available=_avail_read, execute=_exec_read),
        Tool("scan", "From a watchtower, survey the whole island to reveal far places.",
             "core", available=_avail_scan, execute=_exec_scan),
        Tool("repair", "Work to repair an abandoned landmark (lighthouse / radio tower).",
             "build", available=_avail_repair, execute=_exec_repair),
    ]
