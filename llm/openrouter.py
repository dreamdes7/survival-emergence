"""OpenRouter-backed agent brain.

Same interface as the stub: `.decide(agent, world) -> {"tool","args","thought"}`.
Each agent calls its own model (agent.model). Robust by design:
  - builds a compact prompt from perception + memory + persona + tool menu
  - asks for a JSON action (works across all models; no function-calling needed)
  - on ANY failure (no key, HTTP error, budget exceeded, unparseable output)
    falls back to the heuristic stub so the simulation never stalls.

Auth: set OPENROUTER_API_KEY (env or a .env file in the project root).
"""
from __future__ import annotations
import json
import os
import re
import time
import urllib.request
import urllib.error
from pathlib import Path

from engine.models import chebyshev

ROOT = Path(__file__).resolve().parent.parent
NEARBY_RADIUS = 10

PROVIDERS: dict[str, dict] = {
    "openrouter": {
        "endpoint": "https://openrouter.ai/api/v1/chat/completions",
        "key_env": "OPENROUTER_API_KEY",
        "models_url": "https://openrouter.ai/api/v1/models",
        "extra_headers": {
            "HTTP-Referer": "https://github.com/survival-emergence",
            "X-OpenRouter-Title": "Survival Emergence",
        },
    },
    "megallm": {
        "endpoint": "https://ai.megallm.io/v1/chat/completions",
        "key_env": "MEGALLM_API_KEY",
        "models_url": "https://ai.megallm.io/v1/models",
        "extra_headers": {},
        # OpenRouter-style ids -> MegaLLM ids, so configs that name a model the
        # OpenRouter way still resolve instead of silently 404→stub.
        "model_aliases": {
            "deepseek/deepseek-v4-flash": "deepseek-ai/deepseek-v4-flash",
            "deepseek/deepseek-v4-pro":   "deepseek-ai/deepseek-v4-pro",
            "deepseek/deepseek-v3.1":     "deepseek-ai/deepseek-v3.1",
        },
    },
}


def list_models(provider: str) -> list[str]:
    """Fetch the provider's available model ids (sorted). Returns [] on any error."""
    prov = PROVIDERS.get(provider)
    if not prov or not prov.get("models_url"):
        return []
    load_dotenv()
    key = os.environ.get(prov["key_env"], "")
    if not key:
        return []
    try:
        req = urllib.request.Request(
            prov["models_url"], headers={"Authorization": f"Bearer {key}"}, method="GET")
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        ids = [m.get("id") for m in data.get("data", []) if m.get("id")]
        return sorted(ids)
    except Exception:
        return []


def _normalize_model(provider: str, model: str) -> str:
    """Translate a model id to the provider's naming. Explicit aliases first,
    then a `deepseek/...`→`deepseek-ai/...` prefix fallback for MegaLLM."""
    prov = PROVIDERS.get(provider, {})
    aliases = prov.get("model_aliases", {})
    if model in aliases:
        return aliases[model]
    if provider == "megallm" and model.startswith("deepseek/"):
        return "deepseek-ai/" + model.split("/", 1)[1]
    return model


def _gender_ru(gender: str) -> str:
    return {"female": "женщина", "male": "мужчина"}.get(gender, "пол не задан")


def _phys_urgency(physiology: dict, phys_cfg: dict) -> str:
    """Convert raw physiology numbers into human-readable urgency lines.
    Makes the model feel danger rather than seeing abstract numbers."""
    labels: dict[str, tuple] = {
        "hunger":  ("✓ сытость нормальная",    "~ немного голоден",    "⚠ ГОЛОДЕН",             "❗ ОЧЕНЬ ГОЛОДЕН",            "💀 УМИРАЕШЬ ОТ ГОЛОДА"),
        "thirst":  ("✓ не хочется пить",       "~ немного хочется пить","⚠ ХОЧЕТСЯ ПИТЬ",        "❗ СИЛЬНАЯ ЖАЖДА",            "💀 УМИРАЕШЬ ОТ ЖАЖДЫ"),
        "energy":  ("✓ бодр",                  "~ немного устал",       "⚠ УСТАЛ",               "❗ ОЧЕНЬ УСТАЛ",              "💀 ПАДАЕШЬ ОТ УСТАЛОСТИ"),
        "warmth":  ("✓ тепло",                 "~ немного мёрзнешь",    "⚠ МЁРЗНЕШЬ",            "❗ СИЛЬНО МЁРЗНЕШЬ",          "💀 УМИРАЕШЬ ОТ ХОЛОДА"),
        "morale":  ("✓ дух высок",             "~ дух немного упал",    "~ дух упал",            "⚠ УПАДОК ДУХА",              "❗ ПОЛНОЕ ОТЧАЯНИЕ"),
        "oxygen":  ("✓ кислород в норме",      "~ кислорода маловато",  "⚠ МАЛО КИСЛОРОДА",      "❗ КРИТИЧЕСКИ МАЛО КИСЛОРОДА","💀 ЗАДЫХАЕШЬСЯ"),
    }
    lines = []
    for stat, val in physiology.items():
        crit = phys_cfg.get(stat, {}).get("critical", 20)
        ok, mild, warn, danger, critical = labels.get(stat, ("✓ ok", "~ ok", "⚠ low", "❗ very low", "💀 CRITICAL"))
        if val >= crit * 3.0:
            line = f"  {ok} ({val:.0f}/100)"
        elif val >= crit * 2.0:
            line = f"  {mild} ({val:.0f}/100)"
        elif val >= crit * 1.5:
            line = f"  {warn} ({val:.0f}/100) — займись этим скоро"
        elif val >= crit:
            line = f"  {danger} ({val:.0f}/100) — СРОЧНО займись этим!"
        else:
            line = f"  {critical} ({val:.0f}/100) — НЕМЕДЛЕННОЕ ДЕЙСТВИЕ!"
        lines.append(line)
    return "\n".join(lines)


# ── .env loader (minimal, no dependency) ──────────────────────────────────────
def load_dotenv() -> None:
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


# ── budget tracking ───────────────────────────────────────────────────────────
class BudgetTracker:
    def __init__(self, usd_cap: float = 0.0) -> None:
        self.usd_cap = float(usd_cap)
        self.calls = 0
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.cost = 0.0

    def add(self, usage: dict) -> None:
        self.calls += 1
        self.prompt_tokens += int(usage.get("prompt_tokens", 0))
        self.completion_tokens += int(usage.get("completion_tokens", 0))
        self.cost += float(usage.get("cost", 0.0) or 0.0)

    def exceeded(self) -> bool:
        return self.usd_cap > 0 and self.cost >= self.usd_cap

    def summary(self) -> str:
        return (f"calls={self.calls} prompt_tok={self.prompt_tokens} "
                f"completion_tok={self.completion_tokens} cost=${self.cost:.4f}"
                + (f"/{self.usd_cap:.2f}" if self.usd_cap else ""))


# ── client ────────────────────────────────────────────────────────────────────
class OpenRouterLLM:
    name = "openrouter"

    def __init__(self, fallback, budget: BudgetTracker | None = None,
                 max_tokens: int = 400, temperature: float = 0.85,
                 context_tokens: int = 32000,
                 api_key: str | None = None,
                 provider: str = "openrouter",
                 seed: int | None = None) -> None:
        load_dotenv()
        prov = PROVIDERS.get(provider) or PROVIDERS["openrouter"]
        self.provider = provider
        self.endpoint = prov["endpoint"]
        self.extra_headers: dict = prov.get("extra_headers", {})
        self.api_key = api_key or os.environ.get(prov["key_env"], "")
        if not self.api_key:
            raise RuntimeError(
                f"{prov['key_env']} not set. Put it in the environment or a .env file.")
        self.fallback = fallback
        self.budget = budget or BudgetTracker()
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.context_tokens = context_tokens
        self.seed = seed          # forwarded to the API for best-effort reproducibility

    # ── public API ────────────────────────────────────────────────────────────
    def decide(self, agent, world) -> dict:
        if self.budget.exceeded():
            return self._fb(agent, world, "budget cap reached")
        messages = self._build_messages(agent, world)
        try:
            data = self._post_with_retry(agent.model, messages)
        except Exception as exc:                       # network / api error
            self._record_llm(agent, world, messages, None, {}, error=str(exc))
            return self._fb(agent, world, f"api error: {exc}")
        usage = data.get("usage", {}) or {}
        self.budget.add(usage)
        try:
            msg = data["choices"][0]["message"]
        except (KeyError, IndexError, TypeError):
            self._record_llm(agent, world, messages, data, usage, error="malformed response")
            return self._fb(agent, world, "malformed response")
        # Some models (esp. reasoning models) return content=null and put the
        # text in `reasoning`. Fall back through both before giving up.
        content = msg.get("content") or msg.get("reasoning") or ""
        self._record_llm(agent, world, messages, content, usage)
        decision = self._parse(content, world)
        if decision is None:
            return self._fb(agent, world, "unparseable action")
        decision["_source"] = "llm"
        return decision

    def _record_llm(self, agent, world, messages, response, usage,
                    error=None, kind: str = "decision") -> None:
        """Persist the exact prompt + raw model output so an action can be audited
        offline. `kind` tags the call's purpose (decision/dialogue/reflection/dream).
        No-ops when the run isn't being recorded."""
        rec = getattr(world, "recorder", None)
        if rec is None:
            return
        rec.llm({
            "t": world.tick, "day": world.day, "kind": kind,
            "agent": agent.id, "name": agent.name, "model": agent.model,
            "provider": self.provider,
            "prompt": messages,
            "response": response if isinstance(response, str) else response,
            "usage": usage,
            "error": error,
        })

    def reflect(self, agent, world) -> str:
        """Generative-Agents style reflection: synthesise ONE short first-person
        conclusion from what the agent has retrieved about its situation and the
        people around it. Returns "" on any failure so the caller templates instead.
        Recorded to llm.jsonl like any other call."""
        if self.budget.exceeded():
            return ""
        mems = agent.memory.retrieve(agent.retrieval_query(world), n=12) \
            if hasattr(agent, "retrieval_query") else agent.memory.recent(12)
        mem_text = "\n".join(f"- {m.text}" for m in mems) or "  (пока мало что помню)"
        allies = [world.agent_by_id(oid).name for oid, r in agent.relationships.rel.items()
                  if r.label == "ally" and world.agent_by_id(oid)]
        rivals = [world.agent_by_id(oid).name for oid, r in agent.relationships.rel.items()
                  if r.label == "rival" and world.agent_by_id(oid)]
        messages = [
            {"role": "system", "content":
                f"Ты {agent.name}. Оглянись на прожитое и сделай ОДИН короткий честный "
                "вывод от первого лица — о людях, о себе, о том что делать дальше. "
                "1-2 предложения, по-русски, без чисел и координат. Только сам вывод."},
            {"role": "user", "content":
                f"День {world.day}. Союзники: {', '.join(allies) or 'нет'}. "
                f"Соперники: {', '.join(rivals) or 'нет'}.\n"
                f"Что вспоминается:\n{mem_text}\n\nТвой вывод:"},
        ]
        try:
            data = self._post_with_retry(agent.model, messages)
            self.budget.add(data.get("usage", {}) or {})
            content = data["choices"][0]["message"].get("content") or ""
            self._record_llm(agent, world, messages, content, data.get("usage", {}) or {},
                             kind="reflection")
            line = content.strip().strip('"').split("\n")[0][:240]
            return line
        except Exception:
            return ""

    # ── dialogue scenes (Sprint 1) ─────────────────────────────────────────────
    def dialogue_reply(self, agent, world, partner, transcript: list) -> str | None:
        """One short in-character reply inside a conversation scene. A compact
        prompt (persona line + relationship + a few shared memories + the scene so
        far) instead of the full world context — scenes are cheap by design.
        Returns None to end the conversation (model says [конец], or any failure).
        """
        if self.budget.exceeded():
            return None
        rel = agent.relationships.get(partner.id)
        persona_line = agent.persona.summary or (
            "Кто ты — решаешь ты сам; характер складывается из таких разговоров.")
        shared = [m.text for m in agent.memory.retrieve(partner.name, n=4)]
        shared_txt = "\n".join(f"- {s}" for s in shared) or "  (мало что вспоминается)"
        convo = "\n".join(f"{l['speaker']}: {l['text']}" for l in transcript[-8:])
        messages = [
            {"role": "system", "content":
                f"Ты {agent.name}. {persona_line}\n"
                f"Ты разговариваешь с {partner.name} (отношение: {rel.label}, "
                f"близость {rel.affinity:+.1f}). Отвечай ПО-РУССКИ, 1-2 короткие живые "
                "реплики как в настоящем разговоре: отвечай по сути, соглашайся, спорь, "
                "шути, вспоминай. Без координат и чисел. Только текст реплики. "
                "Если сказать больше нечего и разговор исчерпан — ответь ровно [конец]."},
            {"role": "user", "content":
                f"Что ты помнишь о {partner.name}:\n{shared_txt}\n\n"
                f"Разговор:\n{convo}\n\nТвоя реплика:"},
        ]
        try:
            data = self._post_with_retry(agent.model, messages)
            usage = data.get("usage", {}) or {}
            self.budget.add(usage)
            content = (data["choices"][0]["message"].get("content") or "").strip()
            self._record_llm(agent, world, messages, content, usage, kind="dialogue")
        except Exception:
            return None
        line = content.strip().strip('"').split("\n")[0][:220]
        if not line or "[конец]" in line.lower() or "[end]" in line.lower():
            return None
        return line

    # ── survivor interview (Sprint 2) ──────────────────────────────────────────
    def interview(self, agent, world, question: str, history: list | None = None) -> str:
        """Talk to an agent as an outside interviewer. The agent answers from its
        OWN subjective experience — memories retrieved by the question, beliefs
        about the others, diary, current state. The observer's window into 'why
        did you do that?'. Returns "" on failure (caller may fall back to stub)."""
        if self.budget.exceeded():
            return ""
        mems = agent.memory.retrieve(question, n=10)
        mem_text = "\n".join(f"- {m.text}" for m in mems) or "  (почти ничего не помню)"
        diary_tail = "\n".join(t for _, t in agent.memory.diary[-4:]) or "(дневник пуст)"
        bel_lines = []
        for oid, b in getattr(agent, "beliefs", {}).items():
            o = world.agent_by_id(oid)
            if o is not None:
                bel_lines.append(f"- {o.name}: {b.get('note', '')} ({', '.join(b.get('tags', []))})")
        beliefs_txt = "\n".join(bel_lines) or "  (не составил мнения)"
        status_line = ("я не выжил — говорю как призрак своей истории"
                       if agent.status == "dead" else "я всё ещё здесь, живой")
        convo = "\n".join(f"{h.get('role', '?')}: {h.get('text', '')}"
                          for h in (history or [])[-8:])
        messages = [
            {"role": "system", "content":
                f"Ты {agent.name} — один из выживших. С тобой говорит наблюдатель "
                "(интервьюер извне). Отвечай от первого лица, ПО-РУССКИ, 2-4 живых "
                "предложения, из СВОЕГО опыта: что помнишь, что чувствовал, кому "
                "доверял. Не выдумывай событий, которых нет в памяти — если не "
                "помнишь, так и скажи. Без координат и игровых терминов."},
            {"role": "user", "content":
                f"Твоё положение: {status_line}. День {world.day}.\n"
                f"Что ты помнишь по теме вопроса:\n{mem_text}\n"
                f"Твой дневник (последнее):\n{diary_tail}\n"
                f"Что ты думаешь о людях:\n{beliefs_txt}\n\n"
                + (f"Разговор до этого:\n{convo}\n\n" if convo else "")
                + f"Вопрос наблюдателя: {question}\n\nТвой ответ:"},
        ]
        try:
            data = self._post_with_retry(agent.model, messages)
            usage = data.get("usage", {}) or {}
            self.budget.add(usage)
            content = (data["choices"][0]["message"].get("content") or "").strip()
            self._record_llm(agent, world, messages, content, usage, kind="interview")
            return content.strip().strip('"')[:1200]
        except Exception:
            return ""

    # ── dreams (Sprint 1) ──────────────────────────────────────────────────────
    def dream(self, agent, world) -> str:
        """Night-time memory consolidation: recombine recent memories into one
        short symbolic dream. Returns "" on failure (caller falls back to stub)."""
        if self.budget.exceeded():
            return ""
        mems = agent.memory.retrieve(agent.retrieval_query(world), n=12) \
            if hasattr(agent, "retrieval_query") else agent.memory.recent(12)
        mem_text = "\n".join(f"- {m.text}" for m in mems) or "  (день прошёл как в тумане)"
        messages = [
            {"role": "system", "content":
                f"Ты {agent.name}, ты спишь. Опиши ОДИН короткий сон (1-2 предложения, "
                "по-русски, от первого лица, образно): сон перемешивает пережитое — "
                "людей, страхи, надежды. Без координат и чисел. Только сам сон."},
            {"role": "user", "content":
                f"Из чего соткан сон (пережитое):\n{mem_text}\n\nСон:"},
        ]
        try:
            data = self._post_with_retry(agent.model, messages)
            usage = data.get("usage", {}) or {}
            self.budget.add(usage)
            content = (data["choices"][0]["message"].get("content") or "").strip()
            self._record_llm(agent, world, messages, content, usage, kind="dream")
            return content.strip().strip('"').split("\n")[0][:240]
        except Exception:
            return ""

    def propose_names(self, model: str, scenario_name: str, gender: str = "unspecified") -> list[str]:
        """Ask a model for 5 names it would want for itself, favourite first."""
        gender_names = {"female": "женских", "male": "мужских"}.get(gender, "русских")
        gender_line = f"Твой пол: {_gender_ru(gender)}. "
        messages = [
            {"role": "system", "content":
                gender_line +
                "Ты один из людей, переживших катастрофу, и у тебя пока нет имени. "
                f"Ответь ТОЛЬКО JSON-массивом из ровно 5 {gender_names} имён в кириллице, "
                "которые ты бы выбрал себе, любимое первым. Только короткие имена, "
                "без фамилий, прозвищ и английской транслитерации."},
            {"role": "user", "content":
                f"Сеттинг: {scenario_name}. Твои 5 русских имён JSON-массивом."},
        ]
        try:
            data = self._post_with_retry(model, messages)
            self.budget.add(data.get("usage", {}) or {})
            content = data["choices"][0]["message"].get("content") or ""
            m = re.search(r"\[.*\]", content, re.DOTALL)
            if m:
                arr = json.loads(m.group(0))
                names = [str(x).strip() for x in arr if str(x).strip()][:5]
                if names:
                    return names
        except Exception:
            pass
        return []

    # ── prompt construction ───────────────────────────────────────────────────
    def _build_messages(self, agent, world) -> list[dict]:
        persona = agent.persona
        gender_ru = _gender_ru(getattr(agent, "gender", "unspecified"))
        char = (f"You are {agent.name} ({gender_ru}), one of several people who just survived a crash in a "
                f"'{world.scenario['name']}' setting.\n")
        if persona.summary:
            char += f"{persona.summary}\n"
            if persona.drives:
                char += f"Your drives: {', '.join(persona.drives)}.\n"
        else:
            # blank slate: nothing about who you are is fixed — it emerges.
            char += ("You don't know the others — or even yourself out here — well yet. "
                     "Who you become, whom you trust, what role you take and how you treat "
                     "people is entirely up to you and to what unfolds between you. "
                     "Nothing about your character is pre-decided.\n")
        sys = (
            char +
            "You act through TOOLS — exactly one per turn. go_to moves you several tiles "
            "toward a target, so keep heading there over a few turns.\n"
            "РЕСПОНДЬ ТОЛЬКО валидным JSON: "
            '{"thought": "...", "tool": "<tool_name>", "args": {<args>}}.\n'
            "\nПРАВИЛА:\n"
            "- Пиши ПО-РУССКИ, живым человеческим языком от первого лица.\n"
            "- thought — твой внутренний голос: коротко, с эмоцией и характером.\n"
            "- НИКОГДА не упоминай координаты, числа или названия инструментов в thought/say_to. "
            "Думай как человек. Плохо: «иду к 17,19, gather food». "
            "Хорошо: «Надо поесть, пока не стало совсем плохо».\n"
            "- Опирайся на РЕАЛЬНОЕ состояние: если ✓ — ты в порядке; если ⚠/❗/💀 — "
            "реально плохо, действуй соответственно. Не выдумывай симптомы которых нет.\n"
            "- ДИАЛОГ: если к тебе обратились — ОТВЕЧАЙ по сути (согласись, поспорь, пошути). "
            "Реплики короткие, как в живом разговоре. Не игнорируй собеседника.\n"
            "- Когда выживание в порядке (все ✓) и рядом люди — общайся свободно "
            "(страхи, воспоминания, шутки).\n"
            "\nПРИОРИТЕТЫ (строго в этом порядке):\n"
            "1. ВЫЖИВАНИЕ: если в состоянии есть ⚠/❗/💀 — НЕМЕДЛЕННО ешь, пей, иди к "
            "рабочему теплу/укрытию или строй/заправляй костёр. Компас и светские беседы подождут.\n"
            "2. ТЕПЛО НОЧЬЮ: ночью warmth падает постоянно. Согреться можно ТОЛЬКО у горящего "
            "костра с fuel>0 или в ГОТОВОЙ палатке с местом. Недостроенный костёр/палатка НЕ греют. "
            "Если костёр потух, нужен wood и maintain; если maintain недоступен — сначала go_to к костру.\n"
            "3. СТРОЙ ЛАГЕРЬ: без укрытий группа погибнет в первые дни. Собирай материалы и стройте:\n"
            "   • костёр: дерево×3 + камень×2 (первый приоритет!)\n"
            "   • палатка: дерево×4 + волокно×3 (на 2 человека — нужно несколько)\n"
            "   • водосбор: дерево×2 + волокно×2 (не нужно носить воду)\n"
            "   • склад: дерево×3 (общий запас)\n"
            "4. ЗАПАСЫ: носи еду и воду про запас, пока рядом источники.\n"
            "5. Разведка, общение, помощь другим — когда выживание обеспечено.\n"
            "\nargs — техническая часть, можно класть координаты из контекста ниже."
        )

        phys_text = _phys_urgency(agent.physiology, world.scenario.get("physiology", {}))
        dread = getattr(agent, "dread", 0.0)
        dread_line = ""
        if dread >= 25:
            level = "невыносимый" if dread > 75 else "сильный" if dread > 50 else "смутный"
            dread_line = (
                f"\nТебя гнетёт {level} страх ({dread:.0f}/100) — он не уходит сам и "
                f"становится хуже, мешает спать и думать. Легче, только когда ты не один "
                f"или когда наберёшься смелости понять, что это и что с этим делать."
            )
        inv = ", ".join(f"{k}:{v:.0f}" for k, v in agent.inventory.items()) or "пусто"
        phase = "ночь" if world.is_night else "день"
        weather = f", погода: {world.weather}" if world.weather else ""

        nearby_agents = []
        for o in world.agents:
            if o is agent or o.status == "dead":
                continue
            d = chebyshev(agent.x, agent.y, o.x, o.y)
            if d <= NEARBY_RADIUS:
                rel = agent.relationships.get(o.id).label
                tag = "ADJACENT" if d <= 1 else f"{d} away"
                role = f", {o.role}" if getattr(o, "role", None) else ""
                nearby_agents.append(f"{o.name}({rel}, {tag}{role}) at ({o.x},{o.y})")

        nodes = sorted(agent.known_nodes.values(),
                       key=lambda n: chebyshev(agent.x, agent.y, n.x, n.y))[:6]
        node_lines = [f"{n.kind}->{n.yield_item} at ({n.x},{n.y}) qty{n.quantity:.0f}"
                      for n in nodes if n.quantity > 0]
        def structure_line(s) -> str:
            parts = [f"{s.kind}{'(' + s.role + ')' if s.role else ''} at ({s.x},{s.y})"]
            build_kind = s.state.get("buildable_kind")
            if build_kind:
                spec = world.scenario.get("buildables", {}).get(build_kind, {})
                req = float(spec.get("required_progress", 100))
                prog = float(s.state.get("progress", 0))
                if s.state.get("complete"):
                    parts.append("complete")
                else:
                    parts.append(f"incomplete {prog:.0f}/{req:.0f} NOT functional")
            if s.role == "campfire":
                fuel = float(s.state.get("fuel", 0))
                lit = s.state.get("complete") and fuel > 0
                parts.append(f"{'lit' if lit else 'not lit'} fuel={fuel:.0f}")
            if s.role == "shelter":
                cap = int(s.state.get("capacity", 2))
                ready = s.state.get("complete", True)
                occupants = len(world.shelter_occupants(s)) if ready else 0
                usable = ready and world.shelter_has_room_for(agent, s)
                status = "usable for me" if usable else "full/unusable"
                parts.append(f"{status} occupants={occupants}/{cap}")
            return " ".join(parts)

        structs = [structure_line(s) for s in agent.known_structures.values()]

        memory_count = max(6, min(80, self.context_tokens // 700))
        # Retrieval scored against the agent's ACTUAL situation (needs + who's
        # nearby + goal), not the often-empty goals[0]. Falls back gracefully.
        query = agent.retrieval_query(world) if hasattr(agent, "retrieval_query") else \
            (agent.goals[0] if agent.goals else "")
        mems = agent.memory.retrieve(query, n=memory_count)
        mem_lines = [f"- {m.text}" for m in mems]
        following = "никем"
        if agent.following:
            leader = world.agent_by_id(agent.following)
            if leader and leader.status == "active":
                following = (f"{leader.name} (он на ({leader.x},{leader.y})) — держись рядом, "
                             f"но решай сам: помогай ему, добывай, говори, не теряйся")
        rules = "; ".join(world.rules[-5:]) if getattr(world, "rules", None) else "нет"

        # Recent dialogue spoken near this agent — lets conversations actually chain.
        id2agent = {o.id: o for o in world.agents}
        chatter: list[str] = []
        for f in world.feed[-14:]:
            if f.get("kind") != "speech":
                continue
            sp = id2agent.get(f.get("agent_id"))
            if sp is not None and chebyshev(agent.x, agent.y, sp.x, sp.y) <= NEARBY_RADIUS:
                chatter.append(f"{sp.name}: {f.get('result', '')}")
        chatter = chatter[-5:]

        # Group the menu by intent so the choice is legible, not a wall of tools.
        tools = world.tools.available(world, agent)
        cat_order = [
            ("survival", "ВЫЖИВАНИЕ — еда, вода, отдых, тепло"),
            ("build", "ЛАГЕРЬ — добыча, стройка, запасы"),
            ("core", "ДВИЖЕНИЕ И РЕЧЬ"),
            ("social", "ЛЮДИ — помощь, доверие, репутация, обещания"),
            ("culture", "КУЛЬТУРА — имена мест"),
            ("governance", "ГРУППА — правила, роли, решения"),
        ]
        by_cat: dict[str, list] = {}
        for t in tools:
            by_cat.setdefault(t.category, []).append(t)
        seen = {c for c, _ in cat_order}
        blocks = []
        for cat, label in cat_order:
            ts = by_cat.get(cat)
            if not ts:
                continue
            lines = [f"  - {t.name}({', '.join(t.params.keys())}): {t.description}" for t in ts]
            blocks.append(f"[{label}]\n" + "\n".join(lines))
        for cat, ts in by_cat.items():
            if cat not in seen:
                lines = [f"  - {t.name}({', '.join(t.params.keys())}): {t.description}" for t in ts]
                blocks.append("\n".join(lines))
        tool_menu = "\n".join(blocks)

        role_line = ""
        if getattr(agent, "role", None):
            role_line = f"Твоя сила: ты лучший {agent.role} в группе — на тебя в этом полагаются.\n"

        # Open promises (the obligation that pulls behaviour toward follow-through).
        prom_lines = []
        for c in getattr(world, "commitments", []):
            if c["status"] != "open":
                continue
            if c["from_id"] == agent.id:
                prom_lines.append(f"ТЫ обещал {c['to']}: {c['text']} — сдержи (помоги ему / отдай обещанное)")
            elif c["to_id"] == agent.id:
                prom_lines.append(f"{c['from']} обещал тебе: {c['text']}")
        promises_txt = "; ".join(prom_lines) if prom_lines else "нет"

        # Theory of mind — what you've come to think of people you know.
        bel_lines = []
        for oid, b in getattr(agent, "beliefs", {}).items():
            o = world.agent_by_id(oid)
            if o is None or o.status == "dead":
                continue
            tags = ", ".join(b.get("tags", []))
            bel_lines.append(f"  - {o.name}: {b['note']}" + (f" ({tags})" if tags else ""))
        beliefs_txt = "\n".join(bel_lines[:5]) if bel_lines else "  (пока не разобрался в людях)"

        # Named place you're standing in (emergent shared geography).
        here_name = next((pn["name"] for pn in getattr(world, "placenames", [])
                          if chebyshev(agent.x, agent.y, pn["x"], pn["y"]) <= 4), None)
        place_here = f' — это место зовут «{here_name}»' if here_name else ""

        # Night ritual nudge.
        ritual_line = ""
        if world.is_night:
            if getattr(world, "fireside_tradition", False):
                ritual_line = "Ночь. У вас есть традиция собираться у костра вместе — это греет душу.\n"
            else:
                ritual_line = "Ночь. Если втроём и больше собраться у горящего костра — всем легче на душе.\n"

        user = (
            f"День {world.day}, {phase}{weather}. Ты на ({agent.x},{agent.y}){place_here}.\n"
            f"{ritual_line}"
            f"Пол: {gender_ru}\n"
            f"Твоё состояние:\n{phys_text}{dread_line}\n"
            f"{role_line}"
            f"Инвентарь: {inv}\n"
            f"Цели: {', '.join(agent.goals) if agent.goals else 'выжить'}\n"
            f"Данные обещания: {promises_txt}\n"
            f"Следуешь за: {following}\n"
            f"Правила группы: {rules}\n"
            f"Выжившие рядом: {'; '.join(nearby_agents) if nearby_agents else 'никого не видно'}\n"
            f"Что ты думаешь о людях:\n{beliefs_txt}\n"
            f"Известные ресурсы: {'; '.join(node_lines) if node_lines else 'ещё не найдены'}\n"
            f"Лагерь / постройки: {'; '.join(structs) if structs else 'ничего нет — нужно строить!'}\n"
            f"Последние воспоминания:\n" + ("\n".join(mem_lines) if mem_lines else "  (нет)") + "\n"
            f"Разговор рядом:\n"
            + ("\n".join(chatter) if chatter else "  (тихо)") + "\n"
            f"Доступные действия (выбери ровно одно):\n" + tool_menu + "\n"
            "Ответь только JSON."
        )
        return [{"role": "system", "content": sys}, {"role": "user", "content": user}]

    # ── response parsing ──────────────────────────────────────────────────────
    def _parse(self, content, world) -> dict | None:
        if not isinstance(content, str) or not content.strip():
            return None
        match = re.search(r"\{.*\}", content, re.DOTALL)
        if not match:
            return None
        try:
            obj = json.loads(match.group(0))
        except json.JSONDecodeError:
            return None
        tool = obj.get("tool")
        if not isinstance(tool, str) or world.tools.get(tool) is None:
            return None
        args = obj.get("args", {})
        if not isinstance(args, dict):
            args = {}
        return {"tool": tool, "args": args, "thought": str(obj.get("thought", ""))[:200]}

    # ── http ──────────────────────────────────────────────────────────────────
    def _post_with_retry(self, model: str, messages: list[dict], retries: int = 2) -> dict:
        model = _normalize_model(self.provider, model)
        payload = {
            "model": model,
            "messages": messages,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "usage": {"include": True},
        }
        if self.seed is not None:
            payload["seed"] = int(self.seed)   # honoured by some providers; ignored by others
        body = json.dumps(payload).encode("utf-8")
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            **self.extra_headers,
        }
        last: Exception | None = None
        for attempt in range(retries + 1):
            try:
                req = urllib.request.Request(self.endpoint, data=body, headers=headers, method="POST")
                with urllib.request.urlopen(req, timeout=60) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", "ignore")[:200]
                last = RuntimeError(f"HTTP {exc.code}: {detail}")
                if exc.code in (429, 500, 502, 503) and attempt < retries:
                    time.sleep(1.5 * (attempt + 1))
                    continue
                raise last
            except Exception as exc:                   # noqa: BLE001
                last = exc
                if attempt < retries:
                    time.sleep(1.0 * (attempt + 1))
                    continue
                raise
        raise last or RuntimeError("request failed")

    # ── fallback ──────────────────────────────────────────────────────────────
    def _fb(self, agent, world, reason: str) -> dict:
        """The model failed (no key / api error / budget / unparseable). Under the
        default policy the heuristic stub stands in so the sim never stalls; under
        policy='wait' the agent does nothing, so heuristic behaviour never leaks
        into a research run's data. Either way the fallback is tagged for provenance.
        """
        policy = getattr(world, "fallback_policy", "stub")
        if policy == "wait":
            return {"tool": "wait", "args": {},
                    "thought": f"[fallback:wait:{reason}]",
                    "_source": "wait", "_fallback_reason": reason}
        d = self.fallback.decide(agent, world)
        d["thought"] = f"[fallback:{reason}] {d.get('thought', '')}"
        d["_source"] = "llm_fallback_stub"
        d["_fallback_reason"] = reason
        return d
