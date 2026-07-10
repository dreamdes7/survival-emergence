"""FastAPI + WebSocket state streaming — multi-simulation support.

Each simulation is identified by a sim_id string. The "default" sim is
created on startup. Additional sims can be created via POST /sims.

Run:
    uvicorn api.server:app --reload
    py -3.12 -m api.server --scenario island --agents 6
"""
from __future__ import annotations
import argparse
import asyncio
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from engine.anomaly import place_anomaly
from engine.events import EventScheduler
from engine.orchestrator import (apply_runtime_policy, build_llm, build_narrator,
                                 build_recorder, load_config, resolve_names,
                                 spawn_agents)
from engine.serialize import world_manifest, world_snapshot
from engine.session_log import SessionLogger
from engine.world import World

ROOT = Path(__file__).resolve().parent.parent
ASSET_ROOTS = [ROOT / "assets", ROOT.parent / "assets"]
MAX_SIMS = 6


class SimulationRunner:
    def __init__(self, sim_id: str, overrides: dict | None = None) -> None:
        self.sim_id = sim_id
        self.overrides = overrides or {}
        self.cfg: dict = {}
        self.world: World | None = None
        self.events: EventScheduler | None = None
        self.llm = None
        self.max_ticks = 0
        self.tick_seconds = 1.0
        self.task: asyncio.Task | None = None
        self.subscribers: set[asyncio.Queue] = set()
        self.replay: list[dict] = []
        self.paused = False
        self.logger: SessionLogger | None = None
        self.recorder = None
        self.narrator = None
        self.run_id: str | None = None

    def reset(self) -> None:
        if self.logger is not None:
            self.logger.close(self.world)
            self.logger = None
        if self.recorder is not None:
            self.recorder.close(self.world)
            self.recorder = None
        self.cfg, scenario = load_config(self.overrides)
        sim = self.cfg["sim"]
        day_len = int(sim["day_length_ticks"])
        self.max_ticks = int(sim["max_days"]) * day_len
        self.tick_seconds = float(sim.get("api_tick_seconds", sim.get("tick_seconds", 1.0)) or 0.0)
        self.world = World(scenario, int(self.cfg["seed"]), day_len)
        self.world.move_speed = int(sim.get("move_speed", 1))
        spawn_agents(self.world, self.cfg)
        apply_runtime_policy(self.world, self.cfg)
        self.events = EventScheduler(self.world)
        self.llm = build_llm(self.world, self.cfg)
        resolve_names(self.world, self.llm, scenario)
        place_anomaly(self.world, self.overrides.get("anomaly"))
        # One canonical run_id shared by the session log and the run recorder, so a
        # single copyable string points at everything from this run.
        from engine.session_log import new_run_id
        self.run_id = new_run_id(scenario, self.cfg)
        self.logger = SessionLogger(self.world, self.cfg, run_id=self.run_id)
        self.recorder = build_recorder(self.world, self.cfg, scenario, run_id=self.run_id)
        self.narrator = build_narrator(self.world, self.cfg, self.llm)
        self.reflect_with_llm = bool(self.cfg.get("llm", {}).get("reflect_with_llm", True))
        self.replay = [self.snapshot()]
        self.paused = False

    def snapshot(self) -> dict:
        assert self.world is not None
        s = world_snapshot(self.world)
        s["sim_id"] = self.sim_id
        s["run_id"] = self.run_id
        return s

    def meta(self) -> dict:
        """Lightweight summary for the sim list (no full world state)."""
        if self.world is None:
            return {"sim_id": self.sim_id, "run_id": self.run_id, "status": "idle"}
        alive = len(self.world.living_agents())
        return {
            "sim_id": self.sim_id,
            "run_id": self.run_id,
            "scenario": self.world.scenario.get("name", "?"),
            "day": self.world.day,
            "tick": self.world.tick,
            "alive": alive,
            "paused": self.paused,
            "escaped": self.world.escaped,
            "status": "running" if (self.task and not self.task.done()) else "stopped",
        }

    async def start(self) -> None:
        if self.world is None:
            # reset() builds the world AND resolves agent names via blocking LLM
            # HTTP calls — run it off the event loop so the server stays responsive
            # (otherwise creating an LLM sim freezes every other sim + all sockets).
            await asyncio.to_thread(self.reset)
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self._run_loop())

    async def stop(self) -> None:
        if self.task is not None:
            self.task.cancel()
            with suppress(BaseException):
                await self.task
            self.task = None

    async def apply_overrides(self, overrides: dict) -> dict:
        await self.stop()
        self.overrides = {k: v for k, v in overrides.items() if v is not None and v != ""}
        await asyncio.to_thread(self.reset)   # heavy + blocking LLM name calls — off-loop
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self._run_loop())
        await self._broadcast()
        return self.snapshot()

    async def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=2)
        self.subscribers.add(q)
        await q.put(self.snapshot())
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.subscribers.discard(q)

    async def _broadcast(self) -> None:
        snap = self.snapshot()
        self.replay.append(snap)
        self.replay = self.replay[-2000:]
        for q in list(self.subscribers):
            if q.full():
                with suppress(asyncio.QueueEmpty):
                    q.get_nowait()
            await q.put(snap)

    async def _run_loop(self) -> None:
        assert self.world is not None
        assert self.events is not None
        reflect_every = int(self.cfg["sim"].get("reflect_every", 6))

        for t in range(self.world.tick, self.max_ticks):
            while self.paused:
                await asyncio.sleep(0.3)
            self.world.tick = t
            self.world.begin_tick()
            self.events.maybe_fire()

            for agent in self.world.active_agents():
                try:
                    await asyncio.to_thread(agent.step, self.world, self.llm)
                    if t % reflect_every == 0 and t > 0:
                        reflect_llm = self.llm if getattr(self, "reflect_with_llm", True) else None
                        await asyncio.to_thread(agent.reflect, self.world, reflect_llm)
                except Exception as exc:
                    print(f"[sim:{self.sim_id}] {agent.name} step failed: {exc!r}")

            self.world.end_tick()

            # LLM outage fail-safe: if EVERY recent decide() died on an API error
            # (dead key / no balance / 403), pause the sim loudly instead of
            # letting silent wait/heuristic fallbacks walk the agents into their
            # graves and poison the run's data.
            client = getattr(self.llm, "openrouter", None)
            if client is not None:
                threshold = max(4, 2 * len(self.world.living_agents()))
                if getattr(client, "consecutive_failures", 0) >= threshold:
                    self.paused = True
                    err = getattr(client, "last_api_error", "") or "unknown error"
                    notice = (f"⛔ LLM API недоступен ({err[:120]}) — симуляция "
                              f"ПРИОСТАНОВЛЕНА на тике {t}, чтобы агенты не деградировали "
                              f"в молчаливые фоллбеки. Почини ключ/баланс и сними паузу.")
                    print(f"[sim:{self.sim_id}] {notice}")
                    self.world.log_event("outage", notice, 3.0, [])
                    client.consecutive_failures = 0   # re-arm for after resume
                    await self._broadcast()

            if getattr(self, "narrator", None) is not None and t > 0:
                # Narration is a blocking LLM call — keep it off the event loop.
                await asyncio.to_thread(self.narrator.maybe_tick, self.world)
            tom_every = int(self.cfg.get("research", {}).get("tom_probe_every", 0) or 0)
            if (tom_every and t > 0 and t % tom_every == 0
                    and getattr(self.llm, "openrouter", None) is not None):
                from engine.probes import run_tom_probes
                await asyncio.to_thread(run_tom_probes, self.world, self.llm.openrouter)
            if self.logger is not None:
                self.logger.log_tick(self.world)
            if self.recorder is not None:
                self.recorder.tick_metrics(self.world)
            await self._broadcast()

            if self.world.escaped or not self.world.living_agents():
                if self.logger is not None:
                    self.logger.close(self.world)
                    self.logger = None
                if self.recorder is not None:
                    self.recorder.close(self.world)
                    client = getattr(self.llm, "openrouter", None)
                    if client is not None:
                        b = client.budget
                        self.recorder.add_meta(llm_usage={
                            "calls": b.calls, "prompt_tokens": b.prompt_tokens,
                            "completion_tokens": b.completion_tokens,
                            "cost_usd": round(b.cost, 4),
                        })
                    self.recorder = None
                break
            if self.tick_seconds > 0:
                await asyncio.sleep(self.tick_seconds)
            else:
                await asyncio.sleep(0)


# ── Global sim registry ───────────────────────────────────────────────────────
runners: dict[str, SimulationRunner] = {}
_default_overrides: dict = {}


def _get_runner(sim_id: str) -> SimulationRunner:
    r = runners.get(sim_id)
    if r is None:
        raise HTTPException(status_code=404, detail=f"Simulation '{sim_id}' not found")
    return r


def _next_sim_id() -> str:
    i = 1
    while f"sim_{i}" in runners:
        i += 1
    return f"sim_{i}"


def _clean_overrides(raw: dict) -> dict:
    allowed = {
        "scenario", "days", "agents", "seed", "model", "roster",
        "api_tick_seconds", "usd_cap", "tokens_per_agent_tick",
        "context_tokens_per_agent_tick", "max_output_tokens", "provider",
        "anomaly", "persona_mode", "emergency_multiplier", "fallback_policy",
        "thinking", "tom_probe_every",
    }
    clean = {k: raw.get(k) for k in allowed}
    for key in ("days", "agents", "seed", "tokens_per_agent_tick",
                "context_tokens_per_agent_tick", "max_output_tokens",
                "tom_probe_every"):
        if clean.get(key) not in (None, ""):
            clean[key] = int(clean[key])
    for key in ("api_tick_seconds", "usd_cap", "emergency_multiplier"):
        if clean.get(key) not in (None, ""):
            clean[key] = float(clean[key])
    return clean


@asynccontextmanager
async def lifespan(_app: FastAPI):
    default = SimulationRunner("default", _default_overrides)
    runners["default"] = default
    await default.start()
    try:
        yield
    finally:
        for r in list(runners.values()):
            await r.stop()


app = FastAPI(title="Survival Emergence API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^http://(127\.0\.0\.1|localhost):\d+$",
    allow_methods=["*"],
    allow_headers=["*"],
)
for asset_root in ASSET_ROOTS:
    if asset_root.exists():
        app.mount("/assets", StaticFiles(directory=asset_root), name="assets")
        break


# ── Health / meta ─────────────────────────────────────────────────────────────
@app.get("/health")
async def health() -> dict:
    return {"ok": True}


@app.get("/providers/{provider}/models")
async def provider_models(provider: str) -> dict:
    from llm.openrouter import list_models
    models = await asyncio.to_thread(list_models, provider)
    return {"provider": provider, "models": models}


# ── Past runs on disk (browsable, copyable ids) ──────────────────────────────
@app.get("/runs")
async def list_runs(limit: int = 100) -> dict:
    """Every recorded run under logs/runs/, newest first — so any past session's
    copyable run_id (and a one-line summary) is discoverable from the UI."""
    import json as _json
    from pathlib import Path as _Path
    runs_dir = _Path(__file__).resolve().parent.parent / "logs" / "runs"
    out: list[dict] = []
    if runs_dir.is_dir():
        dirs = sorted((d for d in runs_dir.iterdir() if d.is_dir()),
                      key=lambda d: d.name, reverse=True)
        for d in dirs[:limit]:
            entry = {"run_id": d.name}
            meta_f = d / "meta.json"
            if meta_f.is_file():
                try:
                    m = _json.loads(meta_f.read_text(encoding="utf-8"))
                    entry.update({
                        "started": m.get("started"), "seed": m.get("seed"),
                        "scenario": m.get("scenario"), "models": m.get("models"),
                        "agents": len(m.get("agents", [])),
                        "days": (m.get("config", {}).get("sim", {}) or {}).get("max_days"),
                        "ended": m.get("ended"), "last_tick": m.get("last_tick"),
                        "survivors": m.get("survivors"),
                    })
                except Exception:
                    pass
            out.append(entry)
    return {"runs": out}


# ── Multi-sim management ──────────────────────────────────────────────────────
@app.get("/sims")
async def list_sims() -> dict:
    return {"sims": [r.meta() for r in runners.values()]}


@app.post("/sims")
async def create_sim(body: dict) -> dict:
    if len(runners) >= MAX_SIMS:
        raise HTTPException(status_code=409, detail=f"Max {MAX_SIMS} simulations reached")
    sim_id = body.get("sim_id") or _next_sim_id()
    if sim_id in runners:
        raise HTTPException(status_code=409, detail=f"Sim '{sim_id}' already exists")
    overrides = _clean_overrides(body.get("overrides", {}))
    r = SimulationRunner(sim_id, overrides)
    runners[sim_id] = r
    await r.start()
    return r.meta()


@app.delete("/sims/{sim_id}")
async def delete_sim(sim_id: str) -> dict:
    if sim_id == "default" and len(runners) == 1:
        raise HTTPException(status_code=400, detail="Cannot delete the only simulation")
    r = _get_runner(sim_id)
    await r.stop()
    del runners[sim_id]
    return {"deleted": sim_id}


# ── Per-sim endpoints (sim_id in path) ───────────────────────────────────────
@app.get("/sims/{sim_id}/state")
async def sim_state(sim_id: str) -> dict:
    return _get_runner(sim_id).snapshot()


@app.get("/sims/{sim_id}/config")
async def sim_config(sim_id: str) -> dict:
    return _get_runner(sim_id).cfg


@app.get("/sims/{sim_id}/manifest")
async def sim_manifest(sim_id: str) -> dict:
    r = _get_runner(sim_id)
    if r.world is None:
        raise HTTPException(status_code=409, detail="Simulation not started")
    return world_manifest(r.world)


@app.post("/sims/{sim_id}/agents/{agent_id}/interview")
async def sim_interview(sim_id: str, agent_id: str, body: dict) -> dict:
    """Talk to a survivor (or a ghost — dead agents answer too). The agent
    replies from its own memories/beliefs via its own brain; stub agents give a
    plain memory readout. Works live or paused; the call is a pure read of agent
    state plus one LLM request, so it never mutates the simulation."""
    r = _get_runner(sim_id)
    if r.world is None:
        raise HTTPException(status_code=409, detail="Simulation not started")
    agent = r.world.agent_by_id(agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found")
    question = str(body.get("question", "")).strip()
    if not question:
        raise HTTPException(status_code=422, detail="question is required")
    history = body.get("history") or []

    brain = r.llm.brain_for(agent) if hasattr(r.llm, "brain_for") else r.llm.stub
    answer = await asyncio.to_thread(brain.interview, agent, r.world, question, history)
    if not answer:                      # real-LLM failure -> honest stub readout
        from llm.stub import HeuristicLLM
        answer = HeuristicLLM().interview(agent, r.world, question, history)
    return {"agent": agent.name, "status": agent.status, "answer": answer}


@app.get("/sims/{sim_id}/replay")
async def sim_replay(sim_id: str) -> dict:
    return {"snapshots": _get_runner(sim_id).replay}


@app.post("/sims/{sim_id}/control")
async def sim_control(sim_id: str, cmd: dict) -> dict:
    r = _get_runner(sim_id)
    action = cmd.get("action")
    if action == "pause":
        r.paused = True
    elif action == "resume":
        r.paused = False
    elif action == "restart":
        await r.stop()
        r.reset()
        await r.start()
    return {"paused": r.paused}


@app.post("/sims/{sim_id}/config/apply")
async def sim_apply_config(sim_id: str, overrides: dict) -> dict:
    r = _get_runner(sim_id)
    return await r.apply_overrides(_clean_overrides(overrides))


@app.websocket("/ws/{sim_id}")
async def websocket_sim(ws: WebSocket, sim_id: str) -> None:
    r = runners.get(sim_id)
    if r is None:
        await ws.close(code=4004)
        return
    await ws.accept()
    q = await r.subscribe()
    try:
        while True:
            await ws.send_json(await q.get())
    except WebSocketDisconnect:
        pass
    finally:
        r.unsubscribe(q)


# ── Backward-compat aliases (single-sim clients) ──────────────────────────────
@app.get("/state")
async def state() -> dict:
    return _get_runner("default").snapshot()


@app.get("/config")
async def config() -> dict:
    return _get_runner("default").cfg


@app.get("/replay")
async def replay() -> dict:
    return {"snapshots": _get_runner("default").replay}


@app.get("/manifest")
async def manifest() -> dict:
    r = _get_runner("default")
    if r.world is None:
        raise HTTPException(status_code=409, detail="Simulation not started")
    return world_manifest(r.world)


@app.post("/control")
async def control(cmd: dict) -> dict:
    return await sim_control("default", cmd)


@app.post("/config/apply")
async def apply_config(overrides: dict) -> dict:
    return await sim_apply_config("default", overrides)


@app.websocket("/ws")
async def websocket_default(ws: WebSocket) -> None:
    await websocket_sim(ws, "default")


# ── CLI entry point ───────────────────────────────────────────────────────────
def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", choices=["mars", "island"])
    ap.add_argument("--days", type=int)
    ap.add_argument("--agents", type=int)
    ap.add_argument("--seed", type=int)
    ap.add_argument("--model")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()

    _default_overrides.update({
        "scenario": args.scenario,
        "days": args.days,
        "agents": args.agents,
        "seed": args.seed,
        "model": args.model,
    })

    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
