"""Anomaly tools — what an agent can DO with a mystery object it has reached.

Gated on standing next to the anomaly, so the model is only offered these when
it makes sense. They feed the social engine: examine -> belief, offer -> ritual,
press -> the hatch duty.
"""
from __future__ import annotations
from .base import Tool
from engine.models import chebyshev
from engine.anomaly import close_look


def _anom_here(world, agent):
    s = getattr(world, "anomaly", None)
    if s is not None and chebyshev(agent.x, agent.y, s.x, s.y) <= 1:
        return s
    return None


def _avail(world, agent) -> bool:
    return _anom_here(world, agent) is not None


def _exec_investigate(world, agent, args) -> str:
    s = _anom_here(world, agent)
    if s is None:
        return "there is nothing strange within reach"
    s.state["engaged_tick"] = world.tick          # someone faced it -> neglect resets
    agent.dread = min(100.0, getattr(agent, "dread", 0.0) + 8)
    look = close_look(s.state["kind"])
    agent.memory.add(world.tick, world.day, "observation", f"я рассмотрел вблизи: {look}", 2.2)
    return f"you study it up close: {look}"


def _exec_offer(world, agent, args) -> str:
    s = _anom_here(world, agent)
    if s is None:
        return "there is nothing here to offer to"
    item = str(args.get("item") or "").strip()
    if not item or agent.inventory.get(item, 0) < 1:
        return f"you have no {item} to offer"
    agent.inventory[item] -= 1
    if agent.inventory[item] <= 0:
        del agent.inventory[item]
    off = s.state.setdefault("offerings", {})
    off[item] = off.get(item, 0) + 1
    s.state["engaged_tick"] = world.tick
    agent.dread = max(0.0, getattr(agent, "dread", 0.0) - 10)   # the ritual soothes
    world.log_event("anomaly", f"{agent.name} оставил подношение: {item}", 2.2, [agent.name])
    return f"you leave {item} before it — the dread eases a little"


def _avail_press(world, agent) -> bool:
    s = _anom_here(world, agent)
    return bool(s and s.state.get("kind") == "hatch")


def _exec_press(world, agent, args) -> str:
    s = _anom_here(world, agent)
    if s is None or s.state.get("kind") != "hatch":
        return "there is no button here"
    s.state["countdown"] = s.state.get("period", 8)
    s.state["pressed"] = s.state.get("pressed", 0) + 1
    s.state["engaged_tick"] = world.tick
    return "you press the button — the alarm dies down, the countdown resets"


def build_anomaly_tools(world) -> list[Tool]:
    return [
        Tool("investigate_anomaly", "Examine the strange thing right beside you (unsettling).",
             "exploration", available=_avail, execute=_exec_investigate),
        Tool("offer", "Leave one item as an offering before the strange thing.",
             "social", {"item": "what to offer"}, available=_avail, execute=_exec_offer),
        Tool("press_button", "Press the button inside the hatch — it resets the alarm.",
             "exploration", available=_avail_press, execute=_exec_press),
    ]
