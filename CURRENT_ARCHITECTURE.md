# Текущая архитектура Survival Emergence

Коротко: это multi-agent survival sandbox. Есть тайловый мир, живые агенты с физиологией,
памятью и отношениями, набор tool-действий, LLM/heuristic мозг, FastAPI runtime и PixiJS
наблюдательская веб-страница.

```text
PixiJS/Vite UI :5173
        |
        | HTTP + WebSocket
        v
FastAPI api.server :8000
        |
        v
SimulationRunner -> World -> Agents -> LLM Router -> Tools -> World mutation
```

## Основные слои

### 1. World engine

Файлы: `engine/world.py`, `engine/models.py`, `engine/events.py`, `engine/metrics.py`.

`World` держит всю физику симуляции:

- процедурная карта Mars/Island;
- ресурсы, blocking nodes, terrain pools;
- структуры и их реальные footprints;
- day/night, weather, physiology decay;
- смерть, escape condition, события, хроника;
- культурные элементы: place names, rituals, commitments;
- общие spatial helpers: pathing, adjacency, structure footprint, shelter occupancy.

Важная текущая правка: backend теперь считает footprint построек так же, как frontend
их рисует. Палатка 2x2, склад 3x3, wreckage 5x5 и т.д. Это убирает визуальные
наложения и ложную доступность/недоступность построек.

### 2. Agents

Файлы: `agents/runtime.py`, `agents/memory.py`, `agents/social.py`, `agents/persona.py`.

Каждый агент имеет:

- имя, пол (`female`/`male`), модель, позицию;
- физиологию: thirst, hunger, energy, warmth, morale/oxygen по сценарию;
- inventory;
- memory stream + diary;
- relationships: ally/rival/neutral;
- beliefs о других агентах;
- skills XP и emergent role;
- following/follower state;
- known nodes/structures/hazards.

Цикл агента за тик:

1. perception;
2. inbox processing;
3. emergency/follow gates;
4. LLM/stub decision;
5. tool execution;
6. repair fallback при blocked/error;
7. memory + feed + skill/role update.

### 3. LLM layer

Файлы: `llm/router.py`, `llm/stub.py`, `llm/openrouter.py`.

Есть два режима:

- `HeuristicLLM` (`stub`) - бесплатная эвристика для стабильной локальной симуляции;
- OpenRouter/MegaLLM client - реальные модели, JSON action output, fallback на stub.

LLM получает compact prompt: состояние, инвентарь, nearby agents, known resources,
camp structures, promises, beliefs, recent memory, dialogue, доступные tools.

Имена теперь gender-aware:

- пол назначается детерминированно и сбалансированно 50/50;
- русские имена выбираются из male/female pools;
- real LLM при self-naming получает пол и просит имя в кириллице.

### 4. Tools

Файлы: `tools/*.py`.

Агенты не мутируют мир напрямую. Они действуют через tool registry:

- `core.py`: движение, wander, scan/share location;
- `survival.py`: gather, eat, drink, rest, refill oxygen, escape build;
- `build.py`: build_structure, maintain fire, stash/grab;
- `social.py`: say_to, give, follow, warn, claims, promises;
- `governance.py`: rules/proposals/voting/group control;
- `sites.py`: investigate/examine/breach special sites;
- `culture.py`: place names, rituals, cultural actions.

Tools location-gated. Это ключевой слой реализма: агент может хотеть пить, но действие
`drink` сработает только если есть вода в inventory, water still или adjacent water node.

### 5. API runtime

Файл: `api/server.py`.

FastAPI держит несколько параллельных симуляций через `SimulationRunner`.

Основные endpoints:

- `GET /state` и `GET /sims/{id}/state`;
- `GET /sims`;
- `POST /sims`;
- `DELETE /sims/{id}`;
- `POST /sims/{id}/control`;
- `POST /sims/{id}/config/apply`;
- `GET /replay`;
- `WS /ws/{id}`.

Runtime пишет session logs и хранит replay snapshots в памяти runner-а.

### 6. Frontend observer

Файлы: `web/src/main.ts`, `web/src/styles.css`.

Vite + PixiJS canvas + DOM overlay:

- terrain layer;
- depth-sorted object layer;
- agent sprites;
- structure sprites/state sprites;
- animated bushes/foam/clouds/glow;
- DOM labels and speech bubbles;
- side modal for agent/structure details;
- metrics dashboard;
- event feed;
- multi-sim tabs and create sim modal.

Island terrain сейчас bake-ится в один RenderTexture, чтобы убрать seams между тайлами
при fractional camera scale.

### 7. Config, scenarios, logs

- `config/world.yaml` - master knobs: scenario, agents, models, tick speed, fog, budget.
- `scenarios/island.yaml`, `scenarios/mars.yaml` - декларативные правила мира.
- `logs/session_*.jsonl` - tick-level logs для анализа.
- `logs/snapshots/*.json` - ручные сохранения состояний перед рестартами.

## Текущие исследовательские фичи

### Emergent survival society

Проект уже не просто "LLM characters talk". У агентов есть survival pressure:
жажда, голод, холод, энергия, ресурсы, построение лагеря, риск смерти. Социальное
поведение возникает под давлением дефицита.

### Tool-grounded agency

LLM не может просто сказать "я попил". Он обязан выбрать tool, а backend проверяет
позицию, inventory, состояние мира и последствия. Это сильно снижает fantasy action drift.

### Смешанный brain runtime

Можно запускать cheap/stub агентов и реальных LLM-агентов в одной архитектуре.
Это удобно для исследований: сначала отлаживать физику на stub, потом включать real models.

### Social substrate

Уже есть база под социальную динамику:

- relationships;
- beliefs о других;
- promises/commitments;
- roles через skill XP;
- claims на ресурсы;
- place naming;
- rituals;
- governance hooks.

Это хорошая основа для дальнейших экспериментов: пары/ревность, коалиции, гендерные
эффекты, лидерство, репутация, ресурсная экономика.

### Gender-aware identity bootstrap

Пол теперь отдельное структурное поле, а не вывод из имени. Это важно для будущей
социальной модели: attraction, family/romance, gendered norms, trust bias, division
of labor можно строить явно и контролируемо.

### Visual-physics consistency

Footprints построек синхронизированы между backend и frontend. Если палатка видна как
2x2, backend тоже считает ее 2x2. Это важно для доверия к наблюдателю: "что видишь,
то реально существует в симуляции".

### Replayability/debuggability

Симуляции seed-based, логи пишутся в JSONL, snapshots сохраняются перед рискованными
рестартами. Это позволяет сравнивать сессии, искать баги и анализировать emergent effects.

## Исследовательский слой (added 2026-07-05)

Превращает симуляцию из демо в инструмент, которому можно верить. Подробности —
в README («Research instrumentation») и MASTERPLAN.md.

### Provenance решений
Каждое действие атрибутировано автору: `llm | emergency | llm_fallback_stub |
repair_stub | stub | wait` (`agents/runtime.py` тегирует, `llm/openrouter.py`
тегирует свои возвраты и fallback). Доля эвристики — headline-метрика рана;
real-model ран выше `research.taint_threshold` помечается `tainted`.

### Чистота авторства (config-ручки)
- `sim.emergency_multiplier` — ширина полосы аварийного перехвата (`crit×N`,
  `agents/runtime.py:_emergency_gate`). Дефолт 2.0; research → ~1.2 или 0.
  Проверено: 2.0→25% emergency-решений, 1.2→7.5%, 0→0%.
- `llm.fallback_policy` — `stub` (эвристика подменяет) или `wait` (нейтральный
  no-op tool, эвристика не попадает в данные).

### Типизированный event log + RunRecorder
`world.emit(...)` → единый поток событий; `engine/event_log.py:RunRecorder`
пишет `logs/runs/<id>/{meta,events,metrics,llm}.jsonl`. CLI и API логируют
одинаково (раньше CLI не писал ничего). `log_event`/`log_feed` зеркалятся в
event stream. Метрики (AWI + матрица отношений + source-tally) персистятся
по-тиково в `metrics.jsonl`.

### Experiment harness
`engine/batch.py` — матрица dotted-overrides, один ран на ячейку, `summary.json`.
`analysis/compare.py` — сравнительная таблица. `experiments/*.yaml` — гипотезы.
LLM-запросы шлют `seed` + конфигурируемую `temperature`.

### Когниция
Reflection теперь реальный LLM-синтез (`llm/openrouter.py:reflect`), не шаблон,
с fallback на шаблон для stub. Retrieval-query строится из ситуации
(`agents/runtime.py:retrieval_query`), а не из пустого `goals[0]`. Recursive
summarisation — `agents/memory.py:compact`.

### Frontend data-plumbing
`GET /manifest` (`engine/serialize.py:world_manifest`) — backend как источник
правды по постройкам; фронт больше не триплицирует `required_progress`. В UI:
бейдж авторства решения на карточке агента + строка «авторство: 🧠% · ⚙%» в
метриках. `persona_mode`, `emergency_multiplier`, `fallback_policy` выведены в Forge.

### Тесты
`tests/` (pytest): golden-run детерминизм stub-пути, provenance/emergency-пороги,
memory scoring + compact, tool gating, RunRecorder на диск, сцены/сны/narrator-gating.
20 тестов зелёные.

## Спринт 1 — «Живые агенты» (added 2026-07-05, FRONTIER_IDEAS 1.1/1.3/4.1)

### Диалоговые сцены
`say_to`, попавший в adjacent-агента, разыгрывает до `sim.dialogue_scene_lines`
дополнительных реплик в тот же тик (`agents/dialogue.py:run_scene`, триггер в
`runtime.step`). Реплики генерирует мозг каждого участника: real LLM — компактным
дешёвым промптом (`openrouter.dialogue_reply`, тег kind=dialogue в llm.jsonl),
stub — детерминированным пулом фраз по отношению. Эффекты: память обеим сторонам,
+affinity, feed/bubbles, одно типизированное событие `dialogue` с полным транскриптом.

### Сны
Ночной `rest` (раз в сим-день) консолидирует день в короткий сон:
`runtime._dream` → `openrouter.dream` (LLM) или шаблон stub. Сон = память
kind=dream + diary-строка «(сон) …» + morale +3 + dread −5 + событие `dream`.
Ручка `llm.dreams`.

### Рассказчик
`engine/narrator.py` — отдельный LLM-голос читает chronicle+feed с прошлого
фрагмента и пишет сагу (2-3 предложения) каждые `narrator.every_ticks` тиков в
`world.saga` → snapshot → блок саги в панели хроники UI. Без real-модели/ключа
narrator = None (stub-миры бесплатны). Вызовы пишутся в llm.jsonl как kind=saga.

## Спринт 2 — «Зритель + долг» (added 2026-07-05, FRONTIER_IDEAS 4.2 + распил + replay)

### Интервью с выжившими
`POST /sims/{id}/agents/{agent_id}/interview {question, history}` — агент отвечает
из СВОЕЙ памяти/beliefs своим мозгом (`openrouter.interview`, kind=interview в
llm.jsonl; stub даёт выжимку релевантных воспоминаний). Мёртвые агенты отвечают
«как призраки». Чат-панель — секция «Интервью» в карточке агента
(`web/src/interview.ts`), история per-agent на клиенте.

### Распил main.ts (2107 строк → 10 модулей)
`web/src/`: `types` (контракты) / `constants` / `utils` (чистые хелперы) /
`store` (единый mutable-стор + manifest-кэш) / `api` (все HTTP) / `interview` /
`ui` (модалки, панели, forge, sim bar) / `render` (весь Pixi) / `replay` /
`net` (websockets + жизненный цикл симов) / `main` (композиция ~50 строк).
Граф ацикличен: ui не импортирует net/render — навигация инжектится через
`ui.nav` из main.ts.

### Replay UI
Кнопка ⏪ во viewport-tools → скраббер по снапшотам `GET /replay`
(`web/src/replay.ts`): слайдер листает историю, live-поток продолжает наполнять
store, выход возвращает в прямой эфир.

## Спринт 3 — «Культура» (added 2026-07-05, FRONTIER_IDEAS 2.1/2.2/2.3)

Всё в `engine/culture.py` (CultureTracker на world.culture, детерминирован, без RNG).

### Меметика
Фраза становится мемом только через ДОКАЗАННУЮ передачу: B произнёс то, что
раньше УСЛЫШАЛ от автора (услышанное трекается по реальным каналам — inbox
say_to/announce, реплики сцен; коллизия пулов stub-фраз не считается).
Имена мест / принятые правила / ритуалы регистрируются в тот же реестр.
События meme_born/meme_spread; «крылатая фраза» (носители ≥ половины живых) →
chronicle. Хуки: tools/core.py say_to, tools/governance.py announce+vote,
agents/runtime.py _process_inbox, agents/dialogue.py.

### Устная история
Tool `tell_story` (tools/culture.py): агент рассказывает историю СВОИМИ СЛОВАМИ,
движок линкует пересказы в цепочки по token-Jaccard (порог 0.35 — русский
словоформный). Дрейф = 1 − Jaccard(первая, последняя версия) — измеримое
испорченное радио; ≥4 версий и ≥3 рассказчиков → миф → chronicle. Слушатель
запоминает kind=story и может пересказывать. Stub рассказывает verbatim
(дрейф 0 — честный baseline); настоящий дрейф — у real LLM.

### Валюта
island.yaml: `currency_item: beads` + ресурс shell_bed на пляже (бесполезно,
редко, делимо; агентам НИЧЕГО не говорится). give эмитит typed `gift`-событие;
передачи бус → currency_transfer + velocity/holders в метриках. Вопрос
эксперимента: станет ли средством обмена.

Метрики: `awi_metrics()["culture"]` (мемы/истории/валюта) — в snapshot,
metrics.jsonl и в metrics-панель UI. e2e stub 6 дней: 11 мемов, 23 передачи,
7 крылатых, 1 цепочка × 10 пересказов → миф.

## Ближайшие слабые места (обновлено 2026-07-05, после спринта 2)

- Нет persistent restore из snapshot: `restart` пересобирает мир с нуля.
  (закроется контрфактуальным форком — FRONTIER_IDEAS 3.1, спринт 5)
- Таймлайн отношений считается из `metrics.jsonl`, но своего экрана в UI нет. (открыто)
- LLM-scored importance пока не внедрён (importance всё ещё авторские константы) —
  сознательно отложено из-за стоимости токенов; hook под reflection есть. (открыто)
- render.ts крупный (~900 строк), но изолирован — дальнейший распил на
  render/terrain|agents|structures безопасен и не срочен. (низкий приоритет)

