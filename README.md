# Survival Emergence

AI multi-agent survival simulation. Agents develop emergent social structures,
economy, and a push to escape while struggling to survive on **Mars** or a
**desert island**. See [SPEC.md](SPEC.md) for the full design.

> Status: **Phase 7 complete + research layer**. Headless core runs end-to-end
> with a heuristic stub LLM (no API spend); OpenRouter routing is wired behind
> the same `.decide(agent, world)` interface; all persona modes are available;
> FastAPI/WebSocket streaming, a PixiJS observer, and World-forge controls are
> implemented. On top of that: **decision provenance**, per-run event/metrics/LLM
> logs, a **batch experiment harness**, LLM-driven reflection, and a golden-run
> determinism test — see *Research instrumentation* below.
>
> Architecture of record: **[CURRENT_ARCHITECTURE.md](CURRENT_ARCHITECTURE.md)**
> (live) and **[MASTERPLAN.md](MASTERPLAN.md)** (roadmap). `ARCHITECTURE.md` and
> parts of `SPEC.md` are historical and partly stale.

## Quick start

```bash
pip install -r requirements.txt          # pyyaml
python -m engine.orchestrator            # default: mars, 4 days, 5 agents
python -m engine.orchestrator --scenario island --days 6 --agents 6
python -m engine.orchestrator --seed 7   # outcomes vary by seed
python -m engine.orchestrator --ticks 1  # short LLM/API smoke test
```

> On this machine use `py -3.12` instead of `python` (that interpreter has the deps).

CLI flags override `config/world.yaml`: `--scenario {mars,island}`, `--days`,
`--ticks`, `--agents`, `--seed`, `--model`.

## OpenRouter mode

By default every roster entry uses `model: "stub"`, so there is no API spend.
To run real LLM decisions, set an API key and pass an OpenRouter model id:

```bash
$env:OPENROUTER_API_KEY="sk-or-..."
py -3.12 -m engine.orchestrator --days 1 --agents 2 --model deepseek/deepseek-v4-flash
```

You can also put `OPENROUTER_API_KEY=...` in `.env` at the project root. The
`--model` flag overrides all roster models for a run; otherwise each agent uses
its own `model` field from `config/world.yaml`. Agents whose model is `"stub"`
continue to use the heuristic brain.

`deepseek/deepseek-v4-flash` supports a 1M-token context window on OpenRouter,
but `budget.context_tokens_per_agent_tick` is intentionally a local per-tick
prompt budget. Raising it increases how much memory/context each agent may put
into one decision. `budget.max_output_tokens` is separate and only caps the JSON
action response.

## Research instrumentation

Every run writes a self-contained record under `logs/runs/<run_id>/` (headless
**and** API runs — controlled by the `research:` block in `config/world.yaml`):

| file | what |
|---|---|
| `meta.json` | run manifest: full config, seed, models, outcome, and the **decision-provenance** summary + `tainted` flag |
| `events.jsonl` | typed event stream — every agent decision (with its author `source`), chronicle events, deaths, builds |
| `metrics.jsonl` | per-tick AWI indicators + full relationship-affinity matrix + running source tally |
| `llm.jsonl` | full prompt + raw response + token usage per real LLM call (audit *why* an agent acted) |

**Decision provenance** is the headline concept: each action is attributed to
exactly one author — `llm`, `emergency` (the survival gate overrode the brain),
`llm_fallback_stub` (the model failed), `repair_stub` (a blocked tool was
repaired), `stub` (a debug agent), or `wait`. The run's *heuristic share* tells
you how much of the emergent behaviour is the model's vs the heuristic's; a
real-model run above `research.taint_threshold` is flagged `tainted`.

Two knobs keep a research run's data clean (both in `config/world.yaml`, both in
the Forge UI):

- `sim.emergency_multiplier` — width of the emergency-override band (`crit×N`).
  Default `2.0` preserves the tuned survival balance; lower it to `~1.2` (or `0`
  to disable) so the heuristic rarely speaks for the model. Measured effect at
  seed 11 over 40 ticks: `2.0 → 25%` emergency-authored decisions, `1.2 → 7.5%`,
  `0 → 0%`.
- `llm.fallback_policy` — `stub` (heuristic stands in on an LLM failure; the sim
  never stalls) or `wait` (the agent does nothing, so heuristic behaviour never
  enters the data). Use `wait` when the run *is* data.

### Batch experiments

Turn a hypothesis into data — a matrix of config overrides, one run per cell:

```bash
py -3.12 -m engine.batch experiments/blank_vs_library.yaml
py -3.12 -m analysis.compare --batch logs/runs/_batch_*/summary.json
```

An experiment YAML lists dotted config paths and value lists; the runner takes
the cross-product and writes a `summary.json` with per-cell outcomes + heuristic
share. `analysis/compare.py` prints a side-by-side table (also accepts run dirs
directly). LLM requests forward `seed` and a configurable `temperature` for
best-effort reproducibility; the stub path is bit-for-bit reproducible (guarded
by `tests/test_determinism.py`).

## Tests

```bash
py -3.12 -m pytest        # determinism, provenance, memory, tool gating, recorder
```

## Observer API

Phase 4 adds a FastAPI server that streams the running world state:

```bash
py -3.12 -m api.server --scenario mars --agents 5 --days 4
```

Endpoints:

- `GET /health` returns a basic readiness response.
- `GET /state` returns the current JSON world snapshot (includes a live
  `provenance` tally: share of decisions by author).
- `GET /manifest` returns backend-authoritative structure data (footprint sizes,
  buildable costs + `required_progress`) — the frontend reads this instead of
  hardcoding per-structure tables.
- `GET /replay` exports recent world snapshots for replay/analysis.
- `WS /ws` streams snapshots after each simulation tick.

The stream uses the same headless simulation core. `sim.tick_seconds` controls
headless cadence, and `sim.api_tick_seconds` controls observer cadence.

## PixiJS observer

Phase 5 adds a PixiJS/Vite observer:

```bash
# terminal 1
py -3.12 -m api.server

# terminal 2
cd web
npm install
npm run dev
```

Open the Vite URL printed in the terminal, usually `http://127.0.0.1:5173`.
The observer renders tiles, resource/item markers, structures, animated agent
sprites, an event feed, a selected agent's memory panel, World-forge controls,
and an AWI-style metrics dashboard from the WebSocket stream.

Observer controls:

- `-` / `+` zoom the map without stretching tiles.
- `Reset` fits the whole map back into the viewport.
- Drag the map to pan.
- Click an agent sprite to inspect physiology, inventory, goals, and diary.
- Change Forge values and press `Apply world` to restart the running API world
  with those config overrides.

## What runs each tick

Per agent, a PIANO-inspired loop: **perceive → retrieve memory → [reflect] →
decide (LLM) → act via one tool → memorize**. Agents act *only* through tools,
and tools are gated by location (gather needs an adjacent node, refill needs the
oxygen generator, build needs the escape site).

Mechanics live and observable in the logs:
- physiology decay (hunger/thirst/energy + oxygen on Mars / warmth on island)
- day/night cycle and weather events (dust storms / storms) that accelerate decay
- resource gathering, eating/drinking, resting, oxygen refill
- social talk, relationship labels (stranger→ally/rival), item gifting
- escape progress (repair shuttle / build signal fire) and the win condition
- incapacitation and death when a vital hits zero
- periodic reflection written to each agent's diary

## Configuration

- `config/world.yaml` — master knobs: scenario, seed, agent count, roster
  (name + persona + model per agent), sim length, budget.
- `scenarios/mars.yaml`, `scenarios/island.yaml` — survival layer: terrain,
  physiology decay/restore, resources, structures, escape condition, weather.
- `scenarios/personas/` — custom persona files (mode B; not required for defaults).

Persona refs follow the SPEC modes:

- `library:<type>` uses one of the 8 built-in psychotypes.
- `custom:personas/<name>.md` loads a biography + `Drives:` list from
  `scenarios/personas/`.
- `self_select` drafts a role from the active scenario brief before the sim starts.
- `persona_mode` controls generated roster entries when `agents.count` is larger
  than the explicit roster.

## Layout

```
config/      world.yaml (master config)
scenarios/   mars.yaml, island.yaml, personas/
engine/      models, world (grid/physics), events, orchestrator, serialize
agents/      memory, persona (8 psychotypes), social, runtime (Agent + loop)
tools/       base (registry), core, survival, social
llm/         stub, router, openrouter client
api/         FastAPI + WebSocket state streaming
web/         PixiJS + Vite observer
assets/      atlas/ (76 processed sprites), raw/ (source images)
```
