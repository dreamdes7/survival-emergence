"""Append-only JSONL log of a simulation session, for offline review.

One file per applied world in survival-emergence/logs/. Each line is a JSON
record: a header, then one record per tick (cognition events, deaths, new
builds) and a full stat snapshot every day. Readable after the fact to analyse
survival and emergent behaviour.
"""
from __future__ import annotations
import json
from datetime import datetime
from pathlib import Path

LOG_DIR = Path(__file__).resolve().parent.parent / "logs"


def new_run_id(scenario: dict, cfg: dict) -> str:
    """The ONE canonical id for a run — shared by the session log and the run
    recorder so a single copyable string points at everything from that run
    (logs/session_<id>.jsonl and logs/runs/<id>/). Format: <scenario>_<ts>_seed<N>."""
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    scen = scenario.get("name") or cfg.get("scenario") or "world"
    return f"{scen}_{ts}_seed{cfg.get('seed')}"


class SessionLogger:
    def __init__(self, world, cfg: dict, run_id: str | None = None) -> None:
        LOG_DIR.mkdir(exist_ok=True)
        scen = world.scenario.get("name", "world")
        # A caller can pass the canonical run_id so the session file and the run
        # recorder dir share one name; otherwise mint a fresh one here.
        self.run_id = run_id or new_run_id(world.scenario, cfg)
        # run_id is "<scen>_<YYYYMMDD>_<HHMMSS>_seed<N>"; recover the timestamp part.
        _parts = self.run_id.split("_")
        ts = "_".join(_parts[1:3]) if len(_parts) >= 3 else \
            datetime.now().strftime("%Y%m%d_%H%M%S")
        self.path = LOG_DIR / f"session_{self.run_id}.jsonl"
        self.day_length = int(cfg.get("sim", {}).get("day_length_ticks", 12)) or 12
        self._dead: set[str] = set()
        self._structs: set[str] = {s.id for s in world.structures}
        self._f = self.path.open("w", encoding="utf-8")
        self._write({
            "type": "session",
            "run_id": self.run_id,
            "started": ts,
            "scenario": scen,
            "seed": cfg.get("seed"),
            "day_length": self.day_length,
            "max_days": cfg.get("sim", {}).get("max_days"),
            "agents": [{"name": a.name, "gender": getattr(a, "gender", "unspecified"),
                        "model": a.model} for a in world.agents],
        })

    def _write(self, rec: dict) -> None:
        try:
            self._f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            self._f.flush()
        except Exception:
            pass

    def log_tick(self, world) -> None:
        t = world.tick
        events = [
            {"a": e["agent"], "kind": e["kind"], "tool": e["tool"],
             "result": e["result"], "thought": e.get("thought", "")}
            for e in world.feed if e.get("tick") == t
        ]
        died = [a.name for a in world.agents
                if a.status == "dead" and a.id not in self._dead]
        for a in world.agents:
            if a.status == "dead":
                self._dead.add(a.id)
        built = [s.kind for s in world.structures if s.id not in self._structs]
        self._structs |= {s.id for s in world.structures}

        rec: dict = {"t": t, "day": world.day, "night": world.is_night,
                     "weather": world.weather, "alive": len(world.living_agents())}
        if events:
            rec["events"] = events
        if died:
            rec["died"] = died
            reasons = getattr(world, "last_death_reasons", {})
            if reasons:
                rec["death_reasons"] = reasons
        if built:
            rec["built"] = built
        self._write(rec)

        if t % self.day_length == 0:
            self._write({
                "type": "stats", "t": t, "day": world.day,
                "agents": [
                    {"n": a.name, "g": getattr(a, "gender", "unspecified"), "st": a.status,
                     "p": {k: round(v) for k, v in a.physiology.items()},
                     "inv": {k: round(v) for k, v in a.inventory.items()}}
                    for a in world.agents
                ],
            })

    def close(self, world=None) -> None:
        if world is not None:
            self._write({
                "type": "end", "last_tick": world.tick, "day": world.day,
                "survivors": [a.name for a in world.living_agents()],
                "dead": sorted(self._dead and [a.name for a in world.agents if a.status == "dead"]),
                "escaped": getattr(world, "escaped", False),
                "structures": sorted({s.kind for s in world.structures}),
            })
        try:
            self._f.close()
        except Exception:
            pass
