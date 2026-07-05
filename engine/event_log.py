"""RunRecorder — the research-grade record of a single simulation run.

Every run writes a self-contained directory under logs/runs/<run_id>/:

    meta.json      run manifest: config, seed, models, timings, and (on close)
                   the decision-provenance summary + tainted flag.
    events.jsonl   typed event stream — one JSON object per line. The load-bearing
                   record: every agent decision (with its `source`), every
                   chronicle event, deaths, builds, emergency overrides, fallbacks.
    metrics.jsonl  per-tick AWI indicators + a full relationship-affinity matrix
                   + a running decision-source tally. Drives offline timelines.
    llm.jsonl      full prompt + raw response + token usage per real LLM call,
                   keyed by (tick, agent). Lets you audit *why* an agent acted.

This is what turns a run from an anecdote into data: given the directory, the
whole run — who did what, why, and who really decided — reconstructs offline.

`decision_source` is the headline concept. Each action is attributed to exactly
one author:
    llm                the configured model chose it
    llm_fallback_stub  the model failed (api/parse/budget) and the heuristic stood in
    emergency          the emergency gate bypassed the brain to avert death
    repair_stub        the chosen tool was blocked/errored and the heuristic repaired it
    stub               a stub-brained (debug) agent chose it
A run whose LLM agents were driven by the heuristic more than `taint_threshold`
of the time is flagged `tainted` — its emergent behaviour cannot be attributed
to the models.
"""
from __future__ import annotations
import json
from datetime import datetime
from pathlib import Path

from engine.metrics import awi_metrics

RUNS_DIR = Path(__file__).resolve().parent.parent / "logs" / "runs"

# Sources that mean "the heuristic decided, not the model".
_HEURISTIC_SOURCES = {"stub", "llm_fallback_stub", "emergency", "repair_stub"}


def _slug(text: str) -> str:
    keep = "".join(c if c.isalnum() else "_" for c in str(text))
    return keep.strip("_") or "run"


class RunRecorder:
    """Owns one run directory and its append-only logs. Safe to no-op on IO errors
    so logging can never crash a simulation."""

    def __init__(self, world, cfg: dict, scenario: dict, *,
                 run_id: str | None = None, root: Path | None = None,
                 log_llm: bool = True, taint_threshold: float = 0.20,
                 extra_meta: dict | None = None) -> None:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        scen = _slug(scenario.get("name") or cfg.get("scenario") or "world")
        seed = cfg.get("seed")
        self.run_id = run_id or f"{scen}_{ts}_seed{seed}"
        self.dir = (root or RUNS_DIR) / self.run_id
        self.log_llm = bool(log_llm)
        self.taint_threshold = float(taint_threshold)
        self.started = ts

        # decision-provenance tally, finalised into meta.json on close
        self.source_counts: dict[str, int] = {}
        self.llm_calls = 0

        self._ok = True
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            self._events = (self.dir / "events.jsonl").open("w", encoding="utf-8")
            self._metrics = (self.dir / "metrics.jsonl").open("w", encoding="utf-8")
            self._llm = (self.dir / "llm.jsonl").open("w", encoding="utf-8") if self.log_llm else None
        except Exception:
            self._ok = False
            self._events = self._metrics = self._llm = None

        self.meta = {
            "run_id": self.run_id,
            "started": ts,
            "scenario": scenario.get("name"),
            "seed": seed,
            "config": cfg,
            "agents": [
                {"id": a.id, "name": a.name, "gender": getattr(a, "gender", "unspecified"),
                 "model": a.model, "persona": getattr(a.persona, "id", "?")}
                for a in world.agents
            ],
            "models": sorted({a.model for a in world.agents}),
            "map_size": world.size,
        }
        self._write_meta()

    # ── low-level ──────────────────────────────────────────────────────────────
    def _line(self, handle, rec: dict) -> None:
        if handle is None:
            return
        try:
            handle.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")
            handle.flush()
        except Exception:
            pass

    def _write_meta(self) -> None:
        try:
            (self.dir / "meta.json").write_text(
                json.dumps(self.meta, ensure_ascii=False, indent=2, default=str),
                encoding="utf-8")
        except Exception:
            pass

    # ── public API ─────────────────────────────────────────────────────────────
    def event(self, ev: dict) -> None:
        """Record one typed event. If it's a decision, tally its source."""
        if ev.get("kind") == "decision":
            src = (ev.get("payload") or {}).get("source", "?")
            self.source_counts[src] = self.source_counts.get(src, 0) + 1
        self._line(self._events, ev)

    def llm(self, rec: dict) -> None:
        """Record one real LLM exchange (prompt + response + usage)."""
        self.llm_calls += 1
        if self.log_llm:
            self._line(self._llm, rec)

    def tick_metrics(self, world) -> None:
        """Snapshot per-tick indicators + the relationship-affinity matrix so a
        social-graph timeline can be rebuilt without parsing free text."""
        rels = {
            a.id: {oid: round(r.affinity, 3) for oid, r in a.relationships.rel.items()}
            for a in world.agents
        }
        rec = {
            "t": world.tick,
            "day": world.day,
            "alive": len(world.living_agents()),
            "metrics": awi_metrics(world),
            "relationships": rels,
            "sources": dict(self.source_counts),
        }
        self._line(self._metrics, rec)

    def contamination(self) -> dict:
        """Share of decisions authored by the heuristic vs the model."""
        total = sum(self.source_counts.values())
        if not total:
            return {"total": 0, "heuristic_share": 0.0, "by_source": {}}
        heuristic = sum(v for k, v in self.source_counts.items() if k in _HEURISTIC_SOURCES)
        return {
            "total": total,
            "heuristic_share": round(heuristic / total, 4),
            "by_source": {k: round(v / total, 4) for k, v in sorted(self.source_counts.items())},
        }

    def close(self, world=None) -> None:
        contam = self.contamination()
        # A run is only "clean" if it actually exercised real models. A pure-stub
        # (debug) run is honestly labelled rather than flagged as contaminated.
        real_models = [m for m in self.meta.get("models", []) if m != "stub"]
        mode = "debug" if not real_models else "research"
        self.meta.update({
            "ended": datetime.now().strftime("%Y%m%d_%H%M%S"),
            "mode": mode,
            "llm_calls": self.llm_calls,
            "provenance": contam,
            "tainted": bool(real_models) and contam["heuristic_share"] > self.taint_threshold,
        })
        if world is not None:
            self.meta.update({
                "last_tick": world.tick,
                "day": world.day,
                "escaped": getattr(world, "escaped", False),
                "survivors": [a.name for a in world.living_agents()],
                "dead": [a.name for a in world.agents if a.status == "dead"],
                "structures": sorted({s.kind for s in world.structures}),
            })
        self._write_meta()
        for h in (self._events, self._metrics, self._llm):
            try:
                if h is not None:
                    h.close()
            except Exception:
                pass
