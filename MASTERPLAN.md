# MASTERPLAN — от демо к исследовательскому инструменту

> Что исправляем, в каком порядке и по каким критериям принимаем.
> База: аудит кода от 2026-07-05 (engine/agents/llm/tools/api/web, все файлы прочитаны).
> Продукт, который строим: **обсерватория + бенчмарк emergent-поведения LLM-агентов**.
> Рабочий цикл продукта: *поставил эксперимент → прогнал → наблюдал → доказал → сравнил*.

---

## 0. Диагноз в одну строку

Инженерно проект сильный, но научно — уязвимый: в дефолтном конфиге это симуляция
нашей эвристики, а не LLM; в LLM-конфиге — неразличимая смесь того и другого,
и по логам невозможно восстановить, *кто* и *почему* принял каждое решение.

Три корневые проблемы, из которых вытекает всё остальное:

| # | Проблема | Следствие |
|---|----------|-----------|
| 1 | Решения принимают три мозга (emergency gate / LLM / stub-fallback), автор нигде не фиксируется | Любой «emergent» результат нельзя атрибутировать модели |
| 2 | Нет структурного лога: prompt/response не пишутся, соц. события — free-text строки | Поведение не реконструируется offline, метрики не пересчитываются |
| 3 | Нет experiment harness: ни batch-ранов, ни манифестов, ни сравнения сессий | Один ран = анекдот, не данные |

---

## 1. Workstream A — Provenance решений *(первый приоритет, самый дешёвый)*

**Цель:** про каждое действие каждого агента известно, кто его автор и на каком основании.

### A1. Пометка автора решения
- В `agents/runtime.py` цикл `step()` возвращает решение вместе с источником:
  `decision_source: "emergency" | "llm" | "llm_fallback_stub" | "repair_stub"`.
- Точки, где источники рождаются сейчас:
  - emergency gate — `runtime.py:14-37` (перехват при стате < critical×2.0);
  - fallback на stub — `llm/openrouter.py:499-502` (`_fb`);
  - repair-путь — `runtime.py:281-288`.
- `decision_source` пишется в память агента, в session log и в snapshot (для UI-бейджа).

### A2. Полный capture LLM-обмена
- В `llm/openrouter.py` логировать на каждый вызов: полный prompt (messages),
  raw response, model id, latency, usage-токены, был ли retry/fallback.
- Отдельный файл `logs/llm_<session>.jsonl` (prompt'ы тяжёлые — не смешивать с tick-логом),
  связь по `(sim_id, tick, agent)`.

### A3. Contamination как метрика
- Per-run метрика: `% решений от LLM / emergency / stub` — в session header summary,
  в metrics dashboard и в финальном отчёте рана.
- Ран с contamination выше порога (конфиг, дефолт 20%) помечается `tainted: true`.

**Acceptance:** после рана одним запросом к логу можно построить таблицу
«tick × agent × tool × decision_source» и точно сказать, какой процент поведения — модель.

---

## 2. Workstream B — Чистота авторства *(сразу за A)*

**Цель:** LLM-агент управляется LLM, эвристика не подмешивает своё поведение в данные.

### B1. Сузить emergency gate
- Сейчас порог `critical × 2.0` ≈ 40 — агенты полжизни проводят под опекой эвристики.
- Сделать множитель конфигом `sim.emergency_multiplier` (дефолт 1.2),
  а для research-ранов — опция полного отключения (`0` = никогда).
- Emergency-вмешательство всегда логируется как событие (см. Workstream C).

### B2. Fallback — политика, а не магия
- Конфиг `llm.fallback_policy: "stub" | "wait" | "retry_then_wait"`.
- Для research-ранов дефолт `wait`: при ошибке LLM агент делает нейтральный noop
  (отдыхает/стоит), а не «умное» stub-решение. Stub-поведение не попадает в данные.
- Repair-путь (`runtime.py:281-288`) — та же политика.

### B3. Определиться со stub honestly
- Stub объявляется **отладочным режимом физики**, не источником данных:
  раны с `model=stub` в манифесте помечаются `mode: debug`.
- Развязать stub-гейты от biases или принять как есть —但 задокументировать,
  что blank-персоны (все biases = 0.5) глушат кооперативную ветку
  (`llm/stub.py:106`, гейт `cooperation > 0.6` — сейчас мёртвый код).

**Acceptance:** в research-ране с real LLM contamination < 5% при живом API;
каждое вмешательство эвристики видно в логе и в UI (бейдж на агенте).

---

## 3. Workstream C — Типизированный event log *(хребет всей аналитики)*

**Цель:** одна лента типизированных событий вместо free-text — из неё считается всё:
метрики, JSONL, UI-feed, chronicle, соц. граф.

### C1. Событийная модель
```python
@dataclass
class SimEvent:
    tick: int
    kind: str          # speech | relationship_delta | trade | gift | vote |
                       # claim | promise | promise_resolved | build | death |
                       # emergency_override | llm_fallback | ...
    actor: str
    target: str | None
    payload: dict      # типизированные поля per kind
```
- Единственная точка эмиссии — `world.emit(event)`; `world.log_event` (free-text)
  становится тонкой обёрткой над ней (текст генерится ИЗ события, не наоборот).

### C2. Миграция тулов
- Тулы в `tools/*.py` перестают писать только текст: каждая мутация отношений,
  инвентаря, обещаний, голосов эмитит событие с числовыми полями
  (пример: `relationship_delta {a, b, delta, new_affinity, reason}`).
- Порядок миграции: `social.py` → `governance.py` → `bonds.py` → остальные.
  God-object `World` при этом НЕ переписываем — event log решает трассировку без рефакторинга.

### C3. Единый логгер для CLI и API
- `SessionLogger` инстанцируется в `engine/orchestrator.py` тоже
  (сейчас — только `api/server.py:64`; headless-раны не пишут ничего).
- Формат: `logs/runs/<run_id>/events.jsonl` + `meta.json` + `llm.jsonl` + `metrics.jsonl`.

### C4. Метрики из событий
- `engine/metrics.py` (AWI) пересчитывается из event log, персистится per-tick
  в `metrics.jsonl`. Live-snapshot использует те же значения.

**Acceptance:** соц. граф (кто с кем, динамика affinity по тикам), экономика
(все сделки), governance (все голоса) строятся скриптом из `events.jsonl`
без парсинга текста. Feed и chronicle в UI рендерятся из тех же событий.

---

## 4. Workstream D — Experiment harness

**Цель:** ран — не запуск руками, а воспроизводимая единица эксперимента.

### D1. Манифест рана
- `meta.json`: run_id, git-hash (когда появится репо — см. G1), полный config,
  seed, scenario, model ids + фактические версии из API-ответов, timestamps,
  итоговая contamination, tainted-флаг.

### D2. Batch-раннер
- `python -m engine.batch --config experiments/exp01.yaml`:
  матрица {seeds × персона-режимы × модели × сценарии}, параллельность по процессам,
  каждый ран → своя папка в `logs/runs/`.
- Формат эксперимента:
  ```yaml
  name: blank-vs-library
  base: config/world.yaml
  matrix:
    seed: [1, 2, 3, 4, 5]
    agents.persona_mode: [blank, library]
  ```

### D3. Воспроизводимость LLM-пути
- Передавать `seed` в тело запроса (`openrouter.py:465-471` — сейчас не передаётся),
  `temperature` — в конфиг (сейчас захардкожено 0.85).
- Честная позиция: побитовой воспроизводимости с LLM не будет — есть статистическая
  (N сидов на ячейку матрицы). Stub-путь уже детерминирован — беречь это свойство.

### D4. Сравнение сессий
- Минимум: notebook/скрипт `analysis/compare.py` поверх `logs/runs/*` —
  таблицы метрик, кривые по тикам, соц. графы.
- Затем — вкладка сравнения в UI (грузит metrics.jsonl двух+ ранов).

**Acceptance:** один YAML-файл описывает эксперимент; `batch` прогоняет матрицу;
`compare` выдаёт сводную таблицу «конфиг × метрики» с доверительными интервалами по сидам.

---

## 5. Workstream E — Когниция до уровня заявки

**Цель:** закрыть разрыв между SPEC («PIANO, full Generative Agents stack») и кодом.

| Сейчас | Должно быть |
|--------|-------------|
| importance — хардкод-константы у каждого `memory.add` | LLM оценивает importance значимых событий (батчем, дёшево); мелочь остаётся константой |
| reflection — шаблонная f-строка без LLM (`runtime.py:233-235`) | Раз в `reflect_every` тиков — реальный LLM-синтез: 3-5 выводов из retrieved-памяти, выводы пишутся как memory kind=reflection с высокой importance |
| retrieval query = `goals[0]` (у blank-персон пуст → relevance всегда 0) | Query из текущей ситуации: физиология-угрозы + nearby agents + активный контекст |
| relevance — bag-of-words пересечение | Этап 1: оставить BoW, но с живым query. Этап 2 (опционально): локальные эмбеддинги |
| planning отсутствует | Отложено. Либо добавить daily-plan slot в prompt + tool `set_plan`, либо убрать PIANO из SPEC |

- Recursive summarisation при переполнении контекста (`summarize_at_tokens` в конфиге
  уже есть, механики нет) — реализовать: старая память сжимается LLM-суммой.

**Acceptance:** в blank-режиме retrieval возвращает релевантные ситуации воспоминания
(проверяется golden-тестом); reflection-записи — синтез, а не шаблон; SPEC совпадает с кодом.

---

## 6. Workstream F — Frontend как research observer

**Цель:** UI отвечает на вопросы исследователя, а не только показывает «живой мир».

### F1. Убить дублирование данных
- Backend отдаёт `GET /manifest`: per-structure {sprite, scale, shadow_lift,
  placeholder_color, required_progress}, per-item sprite, per-terrain color.
- Удаляются фронтовые таблицы: `STRUCT_RENDER_SCALE` (`main.ts:1138`),
  `STRUCT_SHADOW_LIFT`, `structureSpriteCandidates`, `structurePlaceholder`,
  `itemSpriteName`, `terrainColor` — и **триплированный** required_progress
  (yaml + `main.ts:256` + `main.ts:1197`). Новая структура = правка в одном месте.

### F2. Распил main.ts (2013 строк)
```
web/src/
  net/        — websocket, api client, multi-sim state
  state/      — world state store, типы (генерить бы из pydantic-схем)
  render/     — terrain, structures, agents, fx (по модулю на слой)
  ui/         — modals, forge, metrics, feed, sim bar
  main.ts     — только композиция
```

### F3. Research-виджеты (по отдаче)
1. **Replay UI** — `/replay` уже существует и не используется: скраббер по тикам,
   play/pause/speed. Заодно перевести хранение реплея с полных снапшотов
   (2000 × полный мир × 6 симов в RAM, `server.py:126-127`) на keyframe + дельты.
2. **Таймлайн отношений** — график affinity per-pair из event log; клик по паре —
   вся история их взаимодействий.
3. **Лог диалогов** — per-agent и per-pair история речи (сейчас речь живёт 6 секунд
   в bubble и 26 строк в feed).
4. **Fog-overlay** — `known_nodes/known_structures` уже сериализуются backend'ом,
   но отсутствуют в TS-типах (`main.ts:4-29`) — довести до отрисовки.
5. **Бейдж decision_source на агенте** (из Workstream A) — видно, кем управляется агент.
6. `persona_mode` и fog/pacing-ручки — в Forge UI (сейчас главная исследовательская
   ручка меняется только правкой yaml).

**Acceptance:** добавление структуры не требует правок фронта; любой ран можно
отмотать и пересмотреть; историю пары агентов видно за 2 клика.

---

## 7. Workstream G — Инженерная база

### G1. Git *(буквально первый шаг всего плана)*
- Проект не под version control. `git init`, `.gitignore`
  (logs/, output/, web/dist/, node_modules/, .env), первый коммит — до любых правок.

### G2. Тесты (минимальный каркас, не карго-культ)
- **Golden run**: фиксированный seed + stub + N тиков → хеш сериализованного
  финального состояния. Детерминизм stub-пути уже есть — закрепить его тестом,
  он же ловит случайные изменения физики.
- Unit: tool availability gates (каждый тул: доступен/недоступен в граничных
  позициях), memory retrieval scoring, emergency gate пороги.
- Contract: snapshot-схема (то, что читает фронт) валидируется pydantic-моделью.
- `pytest` в requirements, запуск одной командой.

### G3. Типы честные
- Убрать phantom-атрибуты: `dread` создаётся только anomaly-кодом (`anomaly.py:98`),
  читается через `getattr(..., 0.0)` по всему коду — объявить в `Agent.__init__`.
  Аналогично пройтись по всем `getattr(obj, "attr", default)`.
- mypy в строгом режиме хотя бы на `engine/` и `agents/`.

### G4. Документация: один источник правды
- Остаётся: `README.md` (запуск) + `CURRENT_ARCHITECTURE.md` (живая архитектура,
  переименовать в `ARCHITECTURE.md`) + этот файл (план).
- Удаляются/архивируются: старый `ARCHITECTURE.md` (противоречит всему),
  `OVERVIEW.md` (слить в архитектуру), `SPRINT_PLAN.md` (выполнен).
- `SPEC.md` переписывается под реальность после Workstream E (сейчас врёт про
  размер карты, фазы, атлас, roster-модели).

### G5. Развязка слоёв (дёшево, по пути)
- Циклический хак `from llm.stub import HeuristicLLM` внутри функций
  (`runtime.py:32,281`) уходит сам при B2: runtime зовёт `fallback_policy`,
  интерфейс политики живёт в `llm/router.py`.

---

## 8. Порядок работ и зависимости

```
G1 git ─┐
        ├─► A provenance ─► B чистота авторства ─┐
        │                                        ├─► первые честные раны
        └─► C event log ──► D harness ───────────┘         │
                                                           ▼
                              E когниция ◄── данные о том, что реально слабо
                              F observer UI (F1-F2 можно параллельно с C/D)
                              G2-G5 фоном, golden-тест — сразу после G1
```

**Спринт 1 (фундамент доверия):** G1, A1-A3, B1-B2, golden-тест.
**Спринт 2 (данные):** C1-C4, D1, D3.
**Спринт 3 (эксперименты):** D2, D4, B3, первые матричные раны blank vs library.
**Спринт 4 (глубина + витрина):** E, F1-F3.

---

## 9. Definition of masterpiece

Проект считается собранным в цельный исследовательский продукт, когда:

1. **Атрибуция** — про каждое действие известно, кто его принял; contamination —
   первоклассная метрика рана.
2. **Реконструкция** — любой ран полностью восстанавливается offline из
   `logs/runs/<id>/`: события, промпты, метрики, реплей.
3. **Эксперимент** — гипотеза формулируется YAML-файлом, проверяется batch-раном
   по матрице сидов, результат — сравнительная таблица, а не скриншот.
4. **Честность** — SPEC, архитектурный док и код говорят одно и то же;
   заявленный когнитивный стек реально существует.
5. **Один источник правды** — данные о мире (структуры, спрайты, прогрессы)
   живут в одном месте; golden-тест держит детерминизм; фронт — тонкий наблюдатель.

Когда пять пунктов закрыты, у проекта появляется то, чего нет у 99% «LLM-агентных
симуляций» на GitHub: результатам можно верить и их можно проверить.
