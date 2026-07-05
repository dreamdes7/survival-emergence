"""Event scheduler — injects weather to keep the world 'living'.

Phase 1: random weather from the scenario's event list. Scheduled/scripted
events and richer occurrences (equipment failure, wildlife) come later.
"""
from __future__ import annotations


class EventScheduler:
    def __init__(self, world, rate: float = 0.04, duration: int = 3) -> None:
        self.world = world
        self.rate = rate
        self.duration = duration
        self.options = list(world.scenario.get("weather", {}).get("events", []))

    def maybe_fire(self) -> str | None:
        w = self.world
        if not self.options or w.weather is not None:
            return None
        if w.rng.random() < self.rate:
            event = w.rng.choice(self.options)
            w.weather = event
            w.weather_ticks_left = self.duration
            for a in w.living_agents():
                a.memory.add(w.tick, w.day, "observation",
                             f"a {event} has set in", 2.0)
            return event
        return None
