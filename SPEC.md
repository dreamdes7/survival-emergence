# Survival Emergence — Project Spec

> ℹ️ **Design intent, partly historical.** Some concrete numbers here (map size,
> atlas counts, example roster models, "all phases done incl. replay export")
> have drifted from the code. For current state see
> **[CURRENT_ARCHITECTURE.md](CURRENT_ARCHITECTURE.md)** and
> **[MASTERPLAN.md](MASTERPLAN.md)**. The cognitive-loop and memory sections
> describe the *target* stack; the research layer that closes the gap
> (LLM reflection, provenance, recursive summarisation) is now partly implemented.

AI multi-agent survival simulation. Agents run on real LLMs via OpenRouter,
develop emergent social structures, economy, and governance while struggling
to survive in a hostile environment.

Inspired by: Emergence AI "Emergence World" experiment + Altera "Project Sid"
(PIANO architecture) + Stanford "Generative Agents" (Smallville).

---

## Settings (presets)

| | Mars | Island |
|---|---|---|
| Premise | Colony crash / shuttle wreck on Mars | Plane crash on uninhabited island |
| Survival needs | Oxygen, heat/cold, radiation, suit integrity, hunger, fatigue | Thirst, hunger, temperature, injury/infection, morale |
| Key resources | Oxygen generator, shuttle wreckage, ore vein, ice deposit, greenhouse dome | Fresh water source, plane wreckage, forest, reef, cave |
| Escape condition | Repair shuttle OR build signal beacon | Build signal fire OR build raft |
| Unique hazards | Dust storms, radiation spikes, equipment decay | Storms, illness, predators/wildlife |

Both presets ship as `scenarios/mars.yaml` and `scenarios/island.yaml`.
Architecture is scenario-agnostic — survival layer is parameterised.

---

## Scale

- **Agents:** 3–12 (configurable). Deep cognition per agent (full Generative Agents stack).
- **Duration:** up to 15 sim-days. 1 sim-day = 24 ticks. Tick cadence configurable.
- **World map:** 64×64 tiles, procedurally generated from seed. Biome richness,
  resource scarcity, hazard density all configurable.

---

## Agent cognitive loop (per tick)

PIANO-inspired, single LLM call per tick (Cognitive Controller bottleneck):

```
1. Perception   — visible tiles, nearby agents, own physiology status
2. Retrieval    — relevant memories (recency × importance × relevance score)
3. Reflection*  — periodic: synthesise high-level conclusions, write diary entry
                  (recursive summarisation to fight context drift)
4. Planning     — check daily plan vs current state; reactive re-plan on threat
5. Controller   — ONE LLM call: choose action coherent with speech + goals
6. Act          — exactly one tool call; world applies consequences
7. Memorise     — log event, update relationship state
```

`*` Reflection runs every N ticks (configurable), not every tick.

Agents act **only** through tools. Tools are gated by location.

---

## Memory system

Three layers (Generative Agents style):

- **Memory stream** — timestamped event log per agent
- **Retrieval** — scored by: recency × importance × relevance to current situation
- **Reflection** — periodic synthesis into higher-level conclusions + diary entries
- **Relationship state** — explicit social labels + history per agent pair
- **Recursive summarisation** — on context overflow, compress old memory into summary
  (prevents context drift observed in Emergence experiment)

---

## Tool system (three tiers, Emergence-style)

| Tier | Count | Availability |
|---|---|---|
| Core | ~15 | Always available |
| Survival | ~15 | Always available |
| Adaptive | ~20 | Unlocked by location / social state / discovery |

Key constraint: **tools are gated by location.**
Examples: voting only at campfire/dome; repairing shuttle only at wreckage;
drawing water only at water source.

Core tools: `go_to`, `get_nearby`, `add_memory`, `write_diary`, `add_goal`,
`send_message`, `say_to`, `check_physiology`

Survival tools: `gather_resource`, `eat`, `drink`, `rest`, `craft`, `build`,
`treat_injury`, `repair_equipment`

Social/governance tools: `give_item`, `form_group`, `propose_rule`, `vote`,
`assign_role`, `expel_member`

---

## Personality system (3 modes, switchable per run)

### A — Library (preset psychotypes)
Pick from a catalogue. Based on Big Five + survival archetypes:

| ID | Name | Core trait |
|---|---|---|
| `leader` | Leader | high agreeableness + extraversion, drives group decisions |
| `loner` | Loner | low agreeableness, prefers solo survival, hoards resources |
| `caregiver` | Caregiver | high agreeableness, prioritises others' needs |
| `opportunist` | Opportunist | high neuroticism + low conscientiousness, exploits others |
| `skeptic` | Skeptic | low openness, challenges all proposals |
| `engineer` | Engineer | high conscientiousness, fixated on technical solutions |
| `panicker` | Panicker | high neuroticism, erratic under stress |
| `diplomat` | Diplomat | high agreeableness + openness, bridges conflicts |

### B — Custom profile
Per-agent freeform biography + drives written in `scenarios/personas/<name>.md`.

### C — Self-select (draft phase)
Before sim start, each agent receives the scenario brief and chooses their own
personality/role. Most emergent, least predictable.

Modes can be mixed in one world (e.g. 3 library + 2 custom + 1 self-select).
Each agent also has an independent `model` field regardless of persona mode.

---

## Agent roster config example (in world.yaml)

```yaml
agents:
  count: 8
  persona_mode: mixed
  roster:
    - name: Ada
      persona: "library:leader"
      model: "anthropic/claude-sonnet-4-6"
    - name: Kade
      persona: "custom:personas/kade.md"
      model: "openai/gpt-4o-mini"
    - name: Vee
      persona: "self_select"
      model: "google/gemini-flash-1.5"
```

---

## LLM gateway — OpenRouter

Single HTTP client (`llm/openrouter.py`) routes each agent's calls to its
configured model. Supports any OpenRouter model ID.

Budget controls (in `world.yaml`):
```yaml
budget:
  usd_cap: 25
  tokens_per_agent_tick: 4000
  summarize_at_tokens: 12000   # trigger recursive summarisation
```

Cost estimate: 8 agents × 24 ticks × 15 days = 2880 calls.
Mix flagship models for main agents, cheap open-weight for extras.

---

## Economy & governance (Emergence-style)

- **Barter economy:** no currency — direct resource exchange. Reputation tracked.
- **Ownership:** emergent (agents claim resources/locations through use + group consensus)
- **Gini coefficient** tracked as inequality metric
- **Governance:** agents can propose rules, vote (configurable quorum), assign roles,
  expel members. No external authority — fully self-regulated.
- **Cultural transmission:** place names, rituals, myths, survival lore spread between agents

---

## World simulation

- **Tile map:** 64×64, generated from seed
- **Physiology:** per-agent vital stats decay each tick (hunger, thirst, oxygen, etc.)
  Hitting zero = incapacitation → death if untreated
- **Day/night cycle:** 24 ticks = 1 day. Night raises cold/danger.
- **Weather:** scheduled + random (dust storms on Mars, storms on island)
- **Equipment decay:** structures and tools degrade over time
- **Random events:** configured rate + fixed schedule in world.yaml

---

## Metrics (AWI-analogue, 9 indicators)

1. Population survival rate
2. Safety (conflicts, violence incidents)
3. Map exploration coverage
4. Tool usage diversity
5. Governance participation rate
6. Cultural output (named places, rituals, shared beliefs)
7. Social graph density (relationship count/strength)
8. Economic activity (barter volume, Gini)
9. Escape progress (% toward win condition)

---

## Tech stack

| Layer | Technology |
|---|---|
| Simulation core | Python 3.11+, asyncio |
| API / streaming | FastAPI + Uvicorn + WebSocket |
| Storage | SQLite (dev) → Postgres (scale) |
| LLM gateway | OpenRouter (single client, per-agent model) |
| Frontend renderer | PixiJS + TypeScript, Vite |
| Assets | Pre-generated pixel-art sprite atlas (64px tiles, 64px agents, 128px structures) |

---

## Asset atlas

Location: `assets/atlas/`
Format: PNG, transparent background (except tiles which are solid)

| Category | Count | Size | Path |
|---|---|---|---|
| Agents | 28 | 64×64 | `agents/` |
| Tiles | 16 | 64×64 | `tiles/` |
| Structures | 14 | 128×128 | `structures/` |
| Items | 13 | 48×48 | `items/` |
| FX overlays | 5 | 64×64 | `fx/` |

Agent sprites: `{suit|castaway}_walk_{down|up|left|right}_{0|1|2}.png`,
`{suit|castaway}_{downed|sleeping}.png`

Palette variations (for individual agent colours) applied at render time in PixiJS,
not as separate sprite files.

---

## Repository structure

```
survival-emergence/
├─ SPEC.md                        ← this file
├─ config/
│   └─ world.yaml                 ← master config (the knobs you control)
├─ scenarios/
│   ├─ mars.yaml
│   ├─ island.yaml
│   └─ personas/                  ← custom agent profiles (mode B)
├─ engine/
│   ├─ world.py                   ← tile map, resources, physiology, weather, tick
│   ├─ orchestrator.py            ← main loop, event scheduler
│   └─ events.py                  ← storms, failures, random occurrences
├─ agents/
│   ├─ memory.py                  ← stream + retrieval + reflection + diary
│   ├─ planning.py                ← goals → plan → reactive re-plan
│   ├─ social.py                  ← relationships, norms, reputation
│   ├─ persona.py                 ← 3 personality modes loader
│   └─ runtime.py                 ← PIANO cognitive loop
├─ tools/
│   ├─ core.py                    ← navigation, memory ops, communication
│   ├─ survival.py                ← gather, eat, drink, rest, craft, build
│   └─ social.py                  ← give, form_group, vote, propose_rule
├─ llm/
│   ├─ stub.py                    ← fake LLM for testing without API spend
│   └─ openrouter.py              ← real client, budget tracking, retries
├─ api/
│   └─ server.py                  ← FastAPI + WebSocket state streaming
├─ web/                           ← PixiJS frontend (observer + world-forge UI)
└─ assets/
    ├─ atlas/                     ← processed sprites (ready to use)
    └─ raw/                       ← original generated source images
```

---

## Build phases

1. **[DONE] Headless core** — world + orchestrator + tools + memory + stub LLM.
   `python -m engine.orchestrator` runs both scenarios end-to-end (move, gather,
   eat/drink, refill, rest, talk, gift, reflect/diary, weather, death, escape).
   Outcomes vary by seed (escape / survive / wipe). No API spend.
2. **[IN PROGRESS] OpenRouter layer** — real LLM calls behind the same
   `.decide(agent, world)` interface, per-agent model routing, env/.env API key
   loading, basic retry/fallback behavior, and runtime usage summary. Remaining:
   stronger cost accounting, model/provider policies, and production observability.
3. **[DONE] Personality system** — all 3 modes + psychotype library + self-select draft.
4. **[DONE] API + WebSocket** — FastAPI server streams world state in real time.
5. **[DONE] PixiJS observer** — tile renderer, agent sprites, event feed, memory inspector.
6. **[DONE] World-forge UI** — web form over world.yaml (scenario, agents, events, budget).
7. **[DONE] Presets + metrics** — finalise mars/island yamls, AWI dashboard, replay export.
