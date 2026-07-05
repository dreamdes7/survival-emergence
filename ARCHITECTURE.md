# Survival Emergence — Architecture

> ⚠️ **DEPRECATED / historical.** This document is stale (map size, tool list,
> phase status all out of date). The architecture of record is
> **[CURRENT_ARCHITECTURE.md](CURRENT_ARCHITECTURE.md)**; the roadmap is
> **[MASTERPLAN.md](MASTERPLAN.md)**. Kept only for history.

## Слои

```
Web UI (PixiJS)  ──WS/HTTP──▶  FastAPI  ──▶  Engine  ──▶  LLM
   :5173                          :8000
```

## Backend: `survival-emergence/`

### `engine/`
| Файл | Роль |
|---|---|
| `world.py` | Тайловый мир (48×48). Генерация ландшафта, ресурсы, постройки, физиология decay, день/ночь, погода, смерть. |
| `orchestrator.py` | Главный цикл: спавн агентов, tick loop, summary. Точка входа для headless и API режимов. |
| `models.py` | Pure dataclasses: `ResourceNode`, `Structure`, `STAT_RESTORE`, размеры спрайтов. |
| `serialize.py` | `world_snapshot()` — JSON для WS/REST. |
| `events.py` | Рандомные события (шторм, аномалия) по расписанию. |
| `metrics.py` | AWI-метрики: survival, gini, social density, economy и т.д. |
| `session_log.py` | Лог каждого тика в файл для replay. |

### `agents/`
| Файл | Роль |
|---|---|
| `runtime.py` | `Agent.step()` — спрашивает LLM, вызывает tool, двигается, обновляет память. |
| `persona.py` | Психотипы (library) и blank-slate режим. Загружает профиль из YAML/MD. |
| `memory.py` | Rolling memory: events + diary. Агент рефлексирует каждые N тиков. |
| `social.py` | `RelationshipGraph` — союзники/соперники, gifting, strength decay. |

### `llm/`
| Файл | Роль |
|---|---|
| `stub.py` | `HeuristicLLM` — детерминированная эвристика без API. Физиология → action. |
| `openrouter.py` | OpenRouter клиент: промпт-сборка, tool-calling, budget tracker. |
| `router.py` | `LLMRouter` — выбирает stub или OpenRouter по модели агента. |

### `tools/`
Каждый файл регистрирует набор `Tool(name, desc, category, execute, available)`:

| Файл | Инструменты |
|---|---|
| `core.py` | `go_to`, `wander`, `gather`, `scan_area` |
| `survival.py` | `eat`, `drink`, `rest`, `refill_oxygen` |
| `social.py` | `say_to`, `give`, `propose_trade` |
| `build.py` | `build_structure`, `maintain` (кормить костёр), `stash`, `grab` |
| `sites.py` | `salvage`, `build` (escape), `vote`, `propose_rule` |
| `governance.py` | `nominate`, `decree`, `assign_role` |

### `api/server.py`
FastAPI + WebSocket. Один `SimulationRunner` внутри:
- `POST /config/apply` — пересоздаёт мир с новыми параметрами
- `GET /state` — снапшот
- `WS /ws` — стримит каждый тик подписчикам
- `GET /assets/...` — раздаёт спрайты из `agent/assets/atlas/`

---

## Frontend: `web/src/main.ts` (монофайл ~1600 строк)

**PixiJS 8** canvas + DOM оверлей.

| Слой | Что |
|---|---|
| `worldLayer` | Тайлы ландшафта (terrain sprites) |
| `objectLayer` (depth-sorted) | Ресурсы, постройки, агенты — z-sort по Y |
| DOM | Сайдбар: агент/постройка, метрики, feed событий, world-forge панель |

**Рендер цикл:** WS сообщение → `updateState()` → `render()` (async, rebuilds props) + `renderChrome()` (DOM).

**Постройки:** `structureSpriteCandidates()` выбирает спрайт по state: строится → scaffold, костёр+fuel → lit, без fuel → unlit. Клик → показывает статус в сайдбаре.

---

## Сценарии: `scenarios/`

`island.yaml` / `mars.yaml` — декларативно задают:
- Карту (размер, тип генерации)
- Физиологию (decay, critical, lethal)
- Ресурсы (тип тайла, количество, regen)
- Buildables (cost, progress, role)
- Pre-placed structures
- Escape условие
- Weather events

---

## Фазы разработки

```
✅ Phase 1 — Headless core (engine + stub LLM + tools + escape)
✅ Phase 2 — OpenRouter (интерфейс готов, подключается через world.yaml)
⬜ Phase 3 — Personality system (self_select, drift)
⬜ Phase 4 — Benchmark mechanics (tragedy of commons, info asymmetry)
⬜ Phase 5 — Replays + metrics dashboard
```

---

## Ключевые числа (island, default)

- Карта: 48×48 тайлов
- Агенты: 5 (настраивается)
- Tick: 1 сек в API режиме, день = 12 тиков
- Thirst decay: 2.6/tick → реакция при < 50, смерть при 0 через 3 тика инкапаситации
- Агенты знают: все постройки + ресурсы в радиусе 14 тайлов + 2 ближайших источника воды/еды
