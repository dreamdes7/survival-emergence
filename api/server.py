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
        self.logger = SessionLogger(self.world, self.cfg)
        self.recorder = build_recorder(self.world, self.cfg, scenario)
        self.narrator = build_narrator(self.world, self.cfg, self.llm)
        self.reflect_with_llm = bool(self.cfg.get("llm", {}).get("reflect_with_llm", True))
        self.replay = [self.snapshot()]
        self.paused = False

    def snapshot(self) -> dict:
        assert self.world is not None
        s = world_snapshot(self.world)
        s["sim_id"] = self.sim_id
        return s

    def meta(self) -> dict:
        """Lightweight summary for the sim list (no full world state)."""
        if self.world is None:
            return {"sim_id": self.sim_id, "status": "idle"}
        alive = len(self.world.living_agents())
        return {
            "sim_id": self.sim_id,
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
            if getattr(self, "narrator", None) is not None and t > 0:
                # Narration is a blocking LLM call — keep it off the event loop.
                await asyncio.to_thread(self.narrator.maybe_tick, self.world)
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
    }
    clean = {k: raw.get(k) for k in allowed}
    for key in ("days", "agents", "seed", "tokens_per_agent_tick",
                "context_tokens_per_agent_tick", "max_output_tokens"):
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
