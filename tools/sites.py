"""Mystery-site tools — investigate / examine / breach.

Each site offers profit weighed against risk, so exploring is a real choice:
  distress_pod  (investigate): supplies OR a rescue clue OR a nasty trap (one-time)
  anomaly       (examine)    : shared meaning/cohesion + culture, with a touch of dread
  sealed_bunker (breach)     : big cache + escape parts, but needs 2+ agents together
The hazard_zone has no tool — it passively sears anyone nearby (see world.begin_tick),
but a rich ore node sits just outside it as the lure.
"""
from __future__ import annotations
from .base import Tool
from engine.models import chebyshev


def _adjacent_site(world, agent, role: str):
    for s in world.adjacent_structures(agent, role=role):
        return s
    return None


def _give(agent, item: str, qty: float) -> None:
    agent.inventory[item] = agent.inventory.get(item, 0) + qty


def _add_escape_progress(world, fraction: float) -> float:
    req = float(world.scenario.get("escape", {}).get("required_progress", 100))
    boost = req * fraction
    for st in world.structures:
        if st.role == "escape":
            st.state["progress"] = st.state.get("progress", 0.0) + boost
            world.escape_progress = st.state["progress"]
            break
    return boost


# ── investigate (distress pod) ────────────────────────────────────────────────
def _avail_investigate(world, agent) -> bool:
    return _adjacent_site(world, agent, "investigate") is not None


def _exec_investigate(world, agent, args) -> str:
    s = _adjacent_site(world, agent, "investigate")
    if s is None:
        return "nothing to investigate here"
    if s.state.get("looted"):
        return "already searched — nothing left but dust"
    s.state["looted"] = True
    r = world.rng.random()
    if r < 0.5:
        _give(agent, "food", 4)
        _give(agent, "water", 4)
        _give(agent, "tool", 1)
        agent.memory.add(world.tick, world.day, "social", "I found a supply cache in the pod", 2.2)
        return "searched the pod — found food, water and a tool"
    if r < 0.78:
        boost = _add_escape_progress(world, 0.2)
        agent.memory.add(world.tick, world.day, "social", "I found a rescue clue in the pod", 2.4)
        return f"found a rescue clue — the way out feels closer (+{boost:.0f})"
    if "oxygen" in agent.physiology:
        agent.physiology["oxygen"] = max(0.0, agent.physiology["oxygen"] - 25)
    agent.physiology["energy"] = max(0.0, agent.physiology.get("energy", 0) - 15)
    agent.memory.add(world.tick, world.day, "observation", "the pod was a tomb — a gas leak hit me hard", 2.4)
    return "it was a tomb — a gas leak hits you, you stagger back"


# ── examine (anomaly, graves, and the memory of a place) ──────────────────────
_PLACE_RU = {
    "campfire": "костёр", "tent": "шалаш", "store": "склад", "well": "колодец",
    "water_still": "опреснитель", "workbench": "верстак", "smokehouse": "коптильня",
    "garden": "грядка", "signpost": "указатель", "watchtower": "дозорная вышка",
    "cave": "пещера", "hotspring": "горячий источник",
}


def _adjacent_place(world, agent):
    """An adjacent built structure or grave — something that has a history to read."""
    best, best_d = None, 2
    for s in world.structures:
        if not (s.state.get("complete") or s.kind == "grave"):
            continue
        d = world.structure_distance(agent.x, agent.y, s)
        if d <= 1 and d < best_d:
            best, best_d = s, d
    return best


def _avail_examine(world, agent) -> bool:
    return (_adjacent_site(world, agent, "examine") is not None
            or _adjacent_place(world, agent) is not None)


def _examine_place(world, agent, s) -> str:
    log = s.state.get("log", [])
    if s.kind == "grave":
        of = s.state.get("of", "неизвестного")
        by = s.state.get("buried_by", "кто-то")
        # to stand at a grave is to grieve — and grief is a form of belonging
        if getattr(agent, "psyche", None):
            if agent.psyche.get("purpose") is not None:
                agent.psyche["purpose"] = min(100.0, agent.psyche["purpose"] + 8)
            if agent.psyche.get("belonging") is not None:
                agent.psyche["belonging"] = min(100.0, agent.psyche["belonging"] + 6)
        agent.memory.add(world.tick, world.day, "reflection",
                         f"постоял у могилы {of}. её выкопал {by}", 2.0)
        world.place_note(s.x, s.y, f"{agent.name} приходил к могиле {of}")
        extra = [e["text"] for e in log[-4:] if by not in e["text"]]
        tail = f" Здесь также: {'; '.join(extra)}." if extra else ""
        return f"могила {of}. похоронил {by}, день {s.state.get('day', '?')}.{tail}"
    kind_ru = _PLACE_RU.get(s.kind, s.kind)
    if not log:
        return f"{kind_ru}: тихое место, ничего примечательного здесь не случилось"
    hist = "; ".join(e["text"] for e in log[-5:])
    return f"{kind_ru} помнит: {hist}"


def _exec_examine(world, agent, args) -> str:
    s = _adjacent_site(world, agent, "examine")
    if s is None:
        place = _adjacent_place(world, agent)
        if place is not None:
            return _examine_place(world, agent, place)
        return "no anomaly to examine here"
    n = s.state.get("examined", 0)
    s.state["examined"] = n + 1
    if n >= 3:
        return "you have studied it enough — it offers nothing more"
    near = [o for o in world.agents if o.status != "dead"
            and chebyshev(agent.x, agent.y, o.x, o.y) <= 2]
    for o in near:
        o.memory.add(world.tick, world.day, "reflection",
                     "the anomaly fills me with strange awe — like it means something", 2.1)
        if o is not agent:
            agent.relationships.record(o.id, +0.08)
            o.relationships.record(agent.id, +0.08)
    return "you study the anomaly — a shared sense of meaning binds those who witnessed it"


# ── breach (sealed bunker) ────────────────────────────────────────────────────
def _avail_breach(world, agent) -> bool:
    return _adjacent_site(world, agent, "breach") is not None


def _exec_breach(world, agent, args) -> str:
    s = _adjacent_site(world, agent, "breach")
    if s is None:
        return "no sealed door here"
    if s.state.get("breached"):
        return "the bunker is already open and emptied"
    helpers = [o for o in world.agents if o is not agent and o.status != "dead"
               and world.structure_distance(o.x, o.y, s) <= 1]
    if not helpers:
        return "the door won't budge alone — you need someone here to help breach it"
    s.state["breached"] = True
    present = [agent] + helpers
    for p in present:
        _give(p, "food", 6)
        _give(p, "water", 6)
        _give(p, "tool", 1)
    boost = _add_escape_progress(world, 0.25)
    world.barter_count += 1
    agent.memory.add(world.tick, world.day, "social",
                     f"we breached the bunker together ({len(helpers)} others)", 2.5)
    return (f"breached the bunker with {len(helpers)} other(s) — "
            f"split the cache and salvaged escape parts (+{boost:.0f})")


def build_site_tools() -> list[Tool]:
    return [
        Tool("investigate", "Search an adjacent crashed pod or wreck.", "exploration",
             available=_avail_investigate, execute=_exec_investigate),
        Tool("examine", "Осмотреть рядом стоящее: аномалию, могилу или постройку — "
                        "узнать, что здесь случилось.", "exploration",
             available=_avail_examine, execute=_exec_examine),
        Tool("breach", "Force open an adjacent sealed bunker (needs a helper nearby).",
             "exploration", {"target": "optional"},
             available=_avail_breach, execute=_exec_breach),
    ]
