# Survival Emergence — состояние проекта

> Единый ориентир: что это, на каком уровне, как устроено, что работает и что впереди.
> Актуально на 2026-07-05 (после спринтов 1-4). Живые доки: этот файл +
> [CURRENT_ARCHITECTURE.md](CURRENT_ARCHITECTURE.md) (детали слоёв) +
> [FRONTIER_IDEAS.md](FRONTIER_IDEAS.md) (роадмап). `ARCHITECTURE.md` и части
> `SPEC.md` — исторические.

---

## 1. Что это

Мульти-агентная симуляция выживания, где LLM-агенты с нуля («чистый лист»,
Project Sid style) развивают социальные структуры, культуру и экономику,
пытаясь выжить и спастись с острова или Марса. Вдохновлено Generative Agents
(Smallville), Project Sid (PIANO) и Emergence World.

Ключевое отличие от 99% подобных проектов на GitHub: это не демо, а
**исследовательский инструмент, результатам которого можно верить и которые
можно проверить**. Каждое действие атрибутировано автору, каждый ран
полностью реконструируется офлайн, гипотеза формулируется YAML-файлом и
проверяется батч-прогоном.

## 2. Уровень зрелости

| Ось | Состояние |
|---|---|
| **Движок** | Зрелый. Мир, физиология, погода, постройки, 49 tool-действий, смерть/побег. Детерминизм stub-пути закреплён golden-тестом. |
| **Когниция** | Generative-Agents стек реально реализован: retrieval по ситуации, LLM-reflection, recursive summarisation, PIANO split-thinking (план дня + быстрые тики). |
| **Исследовательский слой** | Сильный и уникальный. Provenance решений, типизированный event log, per-run манифесты, batch-харнесс, ToM-бенчмарк, лидерборд моделей. |
| **Эмерджентные феномены** | Смоделированы И измеримы: диалоги, сны, меметика, устная история с дрейфом, валютный эксперимент, governance. |
| **Наблюдатель (UI)** | Полноценный: живая карта (PixiJS), карточки агентов, интервью с выжившими, replay-скраббер, метрики, сага рассказчика. Модульный (11 файлов). |
| **Тесты/гигиена** | 31 pytest (детерминизм, provenance, культура, бенчмарк — LLM-пути через canned-HTTP), tsc clean, под git. |
| **Что не доказано** | Научный сигнал (реальный дрейф историй, спонтанная валюта, ToM-рейтинг) требует real-model ранов — механика готова, больших прогонов ещё не было. |

**Одной строкой:** каркас исследовательской платформы завершён; всё готово к
первым «настоящим» прогонам на живых моделях.

**Масштаб:** ~8300 строк Python (engine 2.8k, tools 1.9k, llm 1.4k, agents 0.9k),
~2500 строк TypeScript (11 модулей), 31 тест. 5 коммитов (база + 4 спринта).

## 3. Архитектура

```
              ┌─────────────────────────────────────────────┐
   Наблюдатель │  PixiJS/Vite UI :5173                        │
              │  render · ui · net · store · interview · replay │
              └───────────────┬─────────────────────────────┘
                              │  HTTP + WebSocket
              ┌───────────────▼─────────────────────────────┐
        API   │  FastAPI :8000 — SimulationRunner (мульти-сим) │
              │  /state /manifest /replay /interview /ws …     │
              └───────────────┬─────────────────────────────┘
                              │
     Оркестрация ┌────────────▼──────────────┐    ┌──────────────────┐
              │  orchestrator / batch       │    │  RunRecorder      │
              │  per-tick loop, narrator,   │───▶│  logs/runs/<id>/  │
              │  ToM-probes                 │    │  meta·events·     │
              └────────────┬──────────────┘    │  metrics·llm .jsonl│
                              │                   └──────────────────┘
        Ядро   ┌────────────▼──────────────────────────────────┐
              │  World (grid/physics) ─ Agent (cognitive loop) │
              │      │            │            │                │
              │   Tools        Memory       Culture / ToM       │
              │      │            │                             │
              │   LLM Router ─▶ OpenRouter | HeuristicLLM (stub)│
              └────────────────────────────────────────────────┘
```

### Слои

- **World engine** (`engine/world.py`, `models.py`, `events.py`) — тайловый мир
  Mars/Island, ресурсы, постройки с реальными footprint'ами, физиология,
  день/ночь, погода, смерть/побег, культурная/governance-механика. God-object,
  но причинность трассируется через event log, не через рефакторинг.
- **Agents** (`agents/runtime.py`, `memory.py`, `dialogue.py`, `social.py`,
  `persona.py`) — цикл за тик: perceive → inbox → emergency-gate → decide →
  act → [сцена/сон] → memorise → emit. Память = stream + scored retrieval +
  reflection + summarisation. Theory of mind (beliefs).
- **LLM layer** (`llm/router.py`, `openrouter.py`, `stub.py`) — единый интерфейс
  `.decide(agent, world)`. Stub — детерминированная эвристика (бесплатно,
  отладка). OpenRouter/MegaLLM — реальные модели, JSON-действия, split-thinking,
  reflection/dream/dialogue/interview/deliberate/ToM как отдельные методы.
- **Tools** (`tools/*.py`, 49 штук) — агенты мутируют мир ТОЛЬКО через tool'ы,
  гейтингованные по позиции/состоянию. core/survival/build/social/governance/
  culture/sites/settlement/bonds/anomaly.
- **API** (`api/server.py`) — FastAPI, мульти-сим (до 6), тики в asyncio-таске +
  `to_thread` для блокирующих LLM-вызовов, backpressure на WebSocket.
- **Frontend** (`web/src/*.ts`) — ацикличный граф 11 модулей: types/constants/
  utils/store/api/interview/ui/render/replay/net/main.

## 4. Исследовательский хребет (то, что делает проект инструментом)

Три вещи, из-за которых результатам можно верить:

**Provenance решений.** Каждое действие атрибутировано автору: `llm`,
`emergency` (гейт выживания перехватил мозг), `llm_fallback_stub` (модель
сбойнула), `repair_stub`, `stub`, `wait`. Доля эвристики — headline-метрика
рана; real-model ран выше порога помечается `tainted`. Две ручки держат данные
чистыми: `sim.emergency_multiplier` (ширина перехвата; 2.0→25% решений
эвристики, 1.2→7.5%, 0→0%) и `llm.fallback_policy` (`stub` | `wait`).

**Типизированный event log.** `world.emit()` → единый поток из 12 типов событий
(decision, dialogue, dream, plan, meme_born/spread, story_told, currency_transfer,
gift, tom_probe, chronicle, saga). Из него считаются метрики, пишется JSONL,
строится UI. Соц. граф, экономика, культура реконструируются скриптом без
парсинга текста.

**Воспроизводимость и эксперименты.** Stub-путь детерминирован побитово (golden
golden-тест). Real-путь шлёт seed + temperature (статистическая
воспроизводимость по N сидов). `engine/batch.py` — матрица dotted-overrides →
ран на ячейку → `summary.json`; `analysis/compare.py` и `leaderboard.py` —
сравнительные таблицы.

### Что пишется на диск (`logs/runs/<id>/`)

| файл | содержимое |
|---|---|
| `meta.json` | манифест: конфиг, seed, модели, исход, provenance, tainted, ToM, культура, llm_usage |
| `events.jsonl` | типизированный поток — каждое решение с автором, диалоги, смерти, стройки, культура |
| `metrics.jsonl` | по-тиковые AWI-индикаторы + матрица отношений + source-tally |
| `llm.jsonl` | полный prompt+response+usage каждого вызова (kind: decision/dialogue/reflection/dream/deliberation/interview/tom_probe/saga) |

## 5. Эмерджентные феномены (смоделированы + измеримы)

| Феномен | Механика | Метрика |
|---|---|---|
| **Диалоги** | say_to в соседа → сцена из 3-6 реплик за тик (сцена — одно событие) | транскрипты в event log |
| **Сны** | ночной rest → LLM-рекомбинация памяти, morale +3, dread −5 | kind=dream |
| **Рассказчик** | отдельный LLM ведёт сагу по event stream | world.saga → UI |
| **Меметика** | фраза = мем только через доказанную передачу (услышал→повторил) | count, transmissions, famous |
| **Устная история** | tell_story → цепочки по token-overlap, дрейф = 1−Jaccard(перв,посл); миф при ≥4 версий×≥3 рассказчика | chains, retellings, max_drift, myths |
| **Валюта** | beads: бесполезно/редко/делимо, агентам не сказано | transfers, holders, velocity |
| **Theory of Mind** | проба «как каждый к тебе относится» vs ground truth | tom.mean, by_model |
| **Governance** | правила через голосование, роли, изгнание | participation, rules |
| **Отношения/репутация** | affinity, ally/rival, gossip, обещания (kept/broken) | social graph, gini |

## 6. Как запустить

```bash
pip install -r requirements.txt          # pyyaml, fastapi, uvicorn, pytest
py -3.12 -m pytest                        # 31 тест

# headless (бесплатно, stub)
py -3.12 -m engine.orchestrator --scenario island --days 6 --agents 5 --seed 7

# наблюдатель: два терминала
py -3.12 -m api.server                    # :8000
cd web && npm install && npm run dev      # :5173 → открыть в браузере

# real-модели: ключ в .env (OPENROUTER_API_KEY), затем
py -3.12 -m engine.orchestrator --days 3 --model deepseek/deepseek-v4-flash

# эксперимент-матрица + лидерборд
py -3.12 -m engine.batch experiments/model_arena.yaml
py -3.12 -m analysis.leaderboard --batch logs/runs/_batch_model-arena_*/summary.json
```

**Исследовательский пресет** (чистые данные): в `config/world.yaml` или Forge UI —
`emergency_multiplier: 1.2`, `fallback_policy: wait`, `thinking: split`,
`persona_mode: blank`.

## 7. Что твёрдо, что открыто

**Твёрдо:** движок и детерминизм stub; provenance + event log + манифесты;
когнитивный стек (retrieval/reflection/summarisation/split-thinking); культурный
и бенчмарк-слой; наблюдатель со всеми панелями; тесты; git.

**Открыто (в порядке приоритета роадмапа):**
- Научный сигнал не собран — нужны real-model прогоны арены (механика готова).
- **Спринт 5 — контрфактуальный форк** (`FRONTIER_IDEAS 3.1`): реплей до тика T с
  подстановкой записанных LLM-ответов + интервенция → причинная атрибуция. Заодно
  закрывает snapshot-restore.
- **Спринт 6 — время**: дерево веток UI (4.3), эволюция поколений (3.4), нормы с
  зубами (2.4).
- LLM-scored importance (отложено из-за стоимости; hook есть).
- `render.ts` крупный (~900 строк) — изолирован, распил не срочен.

## 8. Хронология

| Коммит | Что добавил |
|---|---|
| `4a989b8` База | движок, когниция, provenance, event log, batch-харнесс, тесты |
| `d4d92d4` Спринт 1 | диалоговые сцены, сны, рассказчик |
| `7dbf4f4` Спринт 2 | интервью с выжившими, распил main.ts (10 модулей), replay UI |
| `8325acf` Спринт 3 | меметика, устная история, валюта |
| `11d8f27` Спринт 4 | split-thinking, ToM-пробы, лидерборд моделей |

Репозиторий: приватный, github.com/dreamdes7/survival-emergence.
