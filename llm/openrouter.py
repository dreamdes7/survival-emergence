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
        # morale is NON-LETHAL: it must never wear the ⚠/❗ alarm grammar of the
        # killing stats, or the model treats despair as a survival emergency and
        # chases hugs while its body freezes (proven by the day-4 wipeout runs).
        "morale":  ("✓ дух высок",             "~ дух немного упал",    "~ дух упал",            "↓ упадок духа (давит, но не убивает)", "↓↓ полное отчаяние (не смертельно — но так теряют волю)"),
        "oxygen":  ("✓ кислород в норме",      "~ кислорода маловато",  "⚠ МАЛО КИСЛОРОДА",      "❗ КРИТИЧЕСКИ МАЛО КИСЛОРОДА","💀 ЗАДЫХАЕШЬСЯ"),
    }
    lines = []
    for stat, val in physiology.items():
        cfg = phys_cfg.get(stat, {})
        crit = cfg.get("critical", 20)
        lethal = cfg.get("lethal", True)
        ok, mild, warn, danger, critical = labels.get(stat, ("✓ ok", "~ ok", "⚠ low", "❗ very low", "💀 CRITICAL"))
        if val >= crit * 3.0:
            line = f"  {ok} ({val:.0f}/100)"
        elif val >= crit * 2.0:
            line = f"  {mild} ({val:.0f}/100)"
        elif val >= crit * 1.5:
            line = f"  {warn} ({val:.0f}/100)" + (" — займись этим скоро" if lethal else "")
        elif val >= crit:
            line = f"  {danger} ({val:.0f}/100)" + (" — СРОЧНО займись этим!" if lethal else "")
        else:
            line = f"  {critical} ({val:.0f}/100)" + (" — НЕМЕДЛЕННОЕ ДЕЙСТВИЕ!" if lethal else "")
        lines.append(line)
    return "\n".join(lines)


def _ticks_to_relief(agent, world, stat, speed) -> int:
    """Roughly how many turns until the agent can satisfy `stat`: 0 if it can act
    in place (rest anywhere; food/water already in the pack), else distance to the
    nearest known source over move speed. 99 = no known source."""
    from engine.models import chebyshev, STAT_RESTORE
    _tool, items = STAT_RESTORE.get(stat, (None, None))
    if stat == "energy":
        return 0
    if items:                                   # hunger / thirst
        if any(agent.inventory.get(i, 0) > 0 for i in items):
            return 0
        best = None
        for n in agent.known_nodes.values():
            if getattr(n, "yield_item", None) in items and n.quantity > 0:
                d = chebyshev(agent.x, agent.y, n.x, n.y)
                best = d if best is None else min(best, d)
        if stat == "thirst":
            for s in world.structures:
                if s.role == "water" and s.state.get("complete"):
                    d = chebyshev(agent.x, agent.y, s.x, s.y)
                    best = d if best is None else min(best, d)
        return 99 if best is None else best // speed + 1
    if stat == "warmth":
        if world.warm_spot(agent):
            return 0
        best = None
        for s in world.structures:
            if s.role == "campfire":
                # an unlit fire warms nobody — only a burning one counts as relief
                if not (s.state.get("complete") and s.state.get("fuel", 0) > 0):
                    continue
            elif s.role in ("hotspring", "shelter"):
                if not s.state.get("complete", True):
                    continue
            else:
                continue
            d = chebyshev(agent.x, agent.y, s.x, s.y)
            best = d if best is None else min(best, d)
        return 99 if best is None else best // speed + 1
    return 0


def _day_clock(world) -> tuple[int, int]:
    """(ticks until nightfall, ticks until dawn). One of them is 0."""
    dl = max(1, int(getattr(world, "day_length_ticks", 12)))
    half = dl // 2
    pos = world.tick % dl
    if pos < half:
        return half - pos, 0            # daytime: night comes in N
    return 0, dl - pos                  # night: dawn comes in N


def _survival_foresight(agent, world) -> str:
    """Hand the agent the SAME arithmetic the emergency gate used to act on — but
    as INFORMATION, not as an override. 'Your water lasts ~4 turns, the nearest is
    5 away — you won't make it, go now.' The model decides; no heuristic plays it.
    Surfaces only while a need is actually approaching the point of no return, so
    it trains proactive resupply instead of chatting until a stub takes the wheel."""
    phys_cfg = world.scenario.get("physiology", {})
    speed = max(1, int(getattr(world, "move_speed", 1)))
    names = {"thirst": "вода", "hunger": "еда", "warmth": "тепло", "energy": "силы"}
    tt_night, _ = _day_clock(world)
    lines = []
    for stat in ("thirst", "hunger", "warmth", "energy"):
        if stat not in agent.physiology:
            continue
        val = agent.physiology[stat]
        cfg = phys_cfg.get(stat, {})
        decay = float(cfg.get("decay", 1.0))
        night_note = ""
        if stat == "warmth":
            if world.is_night:
                decay *= 1.75
            if world.weather == "storm":
                decay *= 1.7
        if decay <= 0:
            continue
        ttd = val / decay                        # turns until this need floors you
        # The night ahead is COLDER (×1.75 + exposure): a daytime countdown that
        # ignores it says "77 turns of warmth" at noon and lets the agent stroll
        # into a night it can't survive. Project the remainder at the night rate.
        if stat == "warmth" and not world.is_night and ttd > tt_night:
            night_decay = float(cfg.get("decay", 1.0)) * 1.75 + 2.0   # exposed-night rate
            if world.weather == "storm":
                night_decay *= 1.7
            left_at_dusk = max(0.0, val - decay * tt_night)
            ttd = tt_night + left_at_dusk / night_decay
            night_note = " (ночь ускорит холод)"
        ttr = _ticks_to_relief(agent, world, stat, speed)
        # Surface with LEAD TIME so the agent can finish what it's doing and
        # resupply BEFORE the crunch — proactive upkeep, not last-second panic.
        # Energy gets a longer lead: its only cure (sleep) costs a whole turn and
        # models chronically ignore it (rest was 3/459 decisions in the wipeout).
        lead = 14 if stat == "energy" else 8
        if ttd > ttr + lead:
            continue
        n = names.get(stat, stat)
        if stat == "energy":
            lines.append(f"  ⏳ силы: на ~{ttd:.0f} ход. — тело сдаст без сна; отдохни (rest), "
                         f"лучше в тепле, пока не свалился")
        elif ttr >= 90:
            lines.append(f"  ⏳ {n}: запаса на ~{ttd:.0f} ход., а источника ты не знаешь — ищи заранее{night_note}")
        elif ttd <= ttr:
            lines.append(f"  ⛔ {n}: запаса на ~{ttd:.0f} ход., ближайший источник в ~{ttr} — НЕ УСПЕВАЕШЬ, иди НЕМЕДЛЕННО{night_note}")
        elif ttd <= ttr + 2:
            lines.append(f"  ⏳ {n}: запаса на ~{ttd:.0f} ход., источник в ~{ttr} — впритык, иди сейчас{night_note}")
        else:
            lines.append(f"  ⏳ {n}: запаса на ~{ttd:.0f} ход., источник в ~{ttr} — пополни, пока не поздно{night_note}")
    return "\n".join(lines)


def _psyche_urgency(psyche: dict) -> str:
    """Turn low psychosocial drives into a FELT lack (not an order): the model
    is meant to act on the restlessness — grow close, be useful, leave a mark —
    and choose HOW itself. Only surfaced when a drive is actually running low."""
    if not psyche:
        return ""
    felt = {
        "belonging": ("тянет к людям, хочется быть своим",
                      "тебе одиноко до боли — ты будто чужой среди них"),
        "esteem":    ("хочется приносить пользу, быть нужным",
                      "ты ощущаешь себя лишним и бесполезным — будто от тебя ничего не зависит"),
        "purpose":   ("хочется, чтобы всё это что-то значило",
                      "дни утекают впустую, после тебя не останется и следа — внутри пусто"),
    }
    lines = []
    for stat, (mild, strong) in felt.items():
        v = psyche.get(stat)
        if v is None:
            continue
        # ↓↓, never ❗ — these ache but do not kill; the alarm grammar (⚠/❗/💀)
        # is reserved for the stats that do, so despair can't hijack survival.
        if v < 25:
            lines.append(f"  ↓↓ {strong} ({v:.0f}/100)")
        elif v < 45:
            lines.append(f"  ~ {mild} ({v:.0f}/100)")
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
                 seed: int | None = None,
                 thinking: str = "full",
                 deliberate_every: int = 12) -> None:
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
        # PIANO-style split thinking: "full" = every tick gets the full world
        # prompt (original behaviour); "split" = one expensive deliberation every
        # `deliberate_every` ticks builds a day plan, and per-tick decisions use a
        # compact prompt checked against that plan (severalfold cheaper + more
        # coherent multi-day behaviour).
        self.thinking = thinking
        self.deliberate_every = max(1, int(deliberate_every))
        # Consecutive decide() calls that died on an API error (403/402/network…).
        # Reset on any success. The run loop watches this to PAUSE the sim loudly
        # instead of letting agents "wait" themselves to death on silent fallbacks.
        self.consecutive_failures = 0
        self.last_api_error: str | None = None

    # ── public API ────────────────────────────────────────────────────────────
    def decide(self, agent, world) -> dict:
        if self.budget.exceeded():
            return self._fb(agent, world, "budget cap reached")
        fast = False
        if self.thinking == "split":
            plan = getattr(agent, "plan", None)
            if plan is None or world.tick - plan.get("made_tick", -10**6) >= self.deliberate_every:
                new_plan = self.deliberate(agent, world)
                if new_plan:
                    agent.plan = new_plan
            fast = getattr(agent, "plan", None) is not None   # no plan -> full prompt
        messages = self._build_messages(agent, world, fast=fast)
        try:
            data = self._post_with_retry(agent.model, messages)
        except Exception as exc:                       # network / api error
            self.consecutive_failures += 1
            self.last_api_error = str(exc)
            self._record_llm(agent, world, messages, None, {}, error=str(exc))
            return self._fb(agent, world, f"api error: {exc}")
        self.consecutive_failures = 0
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

    # ── deliberation (Sprint 4: slow/fast thinking) ────────────────────────────
    def deliberate(self, agent, world) -> dict | None:
        """The SLOW thread: one full-context call that sets a day plan (goal +
        2-4 concrete steps). Per-tick fast decisions then steer by it. Returns
        None on any failure — the agent simply keeps thinking full-prompt."""
        if self.budget.exceeded():
            return None
        base = self._build_messages(agent, world, fast=False)
        messages = [
            {"role": "system", "content":
                base[0]["content"]
                + "\n\nСЕЙЧАС НЕ ДЕЙСТВИЕ, А ПЛАН. Обдумай положение и составь план "
                  "на ближайший день. Ответь ТОЛЬКО JSON: "
                  '{"goal": "главная цель одним предложением", '
                  '"steps": ["шаг 1", "шаг 2", "шаг 3"]}. Шагов 2-4, конкретных.'},
            {"role": "user", "content": base[1]["content"].rsplit(
                "Доступные действия", 1)[0] + "\nТвой план на день (только JSON):"},
        ]
        try:
            data = self._post_with_retry(agent.model, messages)
            usage = data.get("usage", {}) or {}
            self.budget.add(usage)
            content = (data["choices"][0]["message"].get("content") or "")
            self._record_llm(agent, world, messages, content, usage, kind="deliberation")
            m = re.search(r"\{.*\}", content, re.DOTALL)
            obj = json.loads(m.group(0)) if m else None
        except Exception:
            return None
        if not isinstance(obj, dict) or not obj.get("goal"):
            return None
        steps = [str(s).strip() for s in obj.get("steps", []) if str(s).strip()][:4]
        plan = {"goal": str(obj["goal"]).strip()[:160], "steps": steps,
                "made_tick": world.tick}
        world.emit("plan", actor=agent.id,
                   payload={"name": agent.name, "goal": plan["goal"], "steps": steps})
        return plan

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
        # A conversation still happens INSIDE the world: give the scene a one-line
        # anchor of hard facts so plans made in chat obey the island's physics
        # instead of real-world priors ("шалаш не выдержит шторм" — here it does).
        wx = ", ШТОРМ" if world.weather == "storm" else \
            (f", погода: {world.weather}" if world.weather else "")
        facts = (f"Сейчас {'ночь' if world.is_night else 'день'}{wx}. "
                 "Законы острова (факты, не домыслы): в шторм греют только СТЕНЫ — "
                 "построенная палатка или пещера; костёр и горячий источник в бурю не "
                 "спасают. Построенная палатка шторм держит; пещера — сырая, спится плохо.")
        messages = [
            {"role": "system", "content":
                f"Ты {agent.name}. {persona_line}\n"
                f"{facts}\n"
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
    def _build_messages(self, agent, world, fast: bool = False) -> list[dict]:
        """fast=True builds the compact per-tick prompt for split thinking:
        fewer memories/nodes, no beliefs/rules/ritual blocks — the day plan
        (set by deliberate()) carries the strategic context instead."""
        persona = agent.persona
        gender_ru = _gender_ru(getattr(agent, "gender", "unspecified"))
        # One language throughout (mixed EN/RU prompts provoked code-switching —
        # one agent drifted into Ukrainian mid-run). Tool names stay English: ids.
        char = (f"Ты {agent.name} ({gender_ru}) — из тех немногих, кто выжил после крушения. "
                f"Сеттинг: «{world.scenario['name']}».\n")
        if persona.summary:
            char += f"{persona.summary}\n"
            if persona.drives:
                char += f"Твои внутренние тяги: {', '.join(persona.drives)}.\n"
        else:
            # blank slate: nothing about who you are is fixed — it emerges.
            char += ("Ты не знаешь ни этих людей, ни себя здесь. Кем ты станешь, кому "
                     "доверишься, за что возьмёшься и как будешь обходиться с людьми — "
                     "ничего не предрешено: характер сложится из твоих поступков.\n")
        sys = (
            char +
            "\nКАК ТЫ ДЕЙСТВУЕШЬ\n"
            "Каждый ход — ровно ОДНО действие (tool). go_to за один ход покрывает несколько "
            "клеток: к далёкой цели иди тем же go_to несколько ходов подряд. Дела делаются "
            "НА МЕСТЕ: собрать, попить, построить можно только стоя рядом.\n"
            "Ответь ТОЛЬКО валидным JSON: "
            '{"thought": "...", "tool": "<tool_name>", "args": {<args>}}.\n'
            "- thought — внутренний голос: коротко, живо, ПО-РУССКИ, от первого лица. "
            "Без координат, чисел и названий инструментов («Надо поесть, пока не свалился», "
            "а не «иду к 17,19, gather food»). В args координаты класть МОЖНО.\n"
            "- Состояние ниже — честное: ✓ — порядок; ⚠/❗/💀 — реально плохо, действуй. "
            "Не выдумывай симптомов, которых нет.\n"
            "- Если к тебе обратились — ответь ПО СУТИ (согласись, поспорь, пошути), не "
            "игнорируй. НЕ ПОВТОРЯЙСЯ: договорились — иди и ДЕЛАЙ, а не подтверждай "
            "договорённость по кругу. Когда всё ✓ и рядом люди — говори свободно.\n"
            "\nТВОЁ ТЕЛО — четыре счётчика, и убивает любой из них: голод, жажда, холод, "
            "истощение.\n"
            "- Голод и жажда возвращаются каждый день. Ешь и пей ЗАРАНЕЕ, проходя мимо еды "
            "и воды; носи запас с собой. Увлёкся делом — всё равно раз в день поешь и попей.\n"
            "- Истощение лечит ТОЛЬКО сон (rest). Без сна тело сдаст за несколько дней — "
            "спи каждый день, лучше в тепле: там сон и греет.\n"
            "- Холод: ночь ВДВОЕ холоднее дня, и каждая ночь под открытым небом бьёт "
            "сильнее предыдущей. Греют горящий костёр, горячий источник и кров; быстрее "
            "всего тепло возвращает ОТДЫХ у огня или под крышей — дойти до тепла мало, "
            "надо у него ОСТАТЬСЯ и отогреться.\n"
            "- Ритм, который держит живым: днём — дорога и дела; к сумеркам — быть у огня "
            "или под кровом; ночью — спать в тепле. Кто ночует на голой земле без огня — "
            "платит телом.\n"
            "- Строки ⏳/⛔ ниже — трезвая арифметика: на сколько ходов хватит и далеко ли "
            "спасение. Верь ей и выходи, ПОКА успеваешь, а не когда уже поздно.\n"
            "\nЗАКОНЫ ОСТРОВА (факты мира, не мнения — не спорь с ними и не выдумывай своих):\n"
            "- Костёр горит, пока в нём дрова: без подкормки (maintain) гаснет за считанные "
            "часы. Погасший костёр не греет.\n"
            "- В тихую ночь костёр греет. В ШТОРМ ветер срывает тепло с открытого огня и "
            "горячего источника — держат только СТЕНЫ: построенная палатка или пещера. "
            "Палатка держит шторм, и в ней высыпаешься; пещера — сырой камень: бурю "
            "переждать можно, но спится скверно и мест мало.\n"
            "- Стройка идёт по шагам: начал (build_structure) — заплатил материалы, дальше "
            "каждый ход добавляет прогресс; вдвоём-втроём заметно быстрее. НЕДОСТРОЕННОЕ "
            "не работает — начал, так дострой.\n"
            "- Сырая еда в рюкзаке гниёт. Копчёная хранится; сложенная в склад — не гниёт.\n"
            "\nДУША. Одиночество, ненужность, бессмысленность (см. «Что ты чувствуешь») "
            "давят по-настоящему — но от них НЕ УМИРАЮТ. Умирают от голода, жажды, холода "
            "и истощения: сначала спаси тело, потом лечи душу. А тоску лечит не бегство от "
            "дел — она отпускает, когда ты кому-то по-настоящему близок, когда от тебя есть "
            "толк, когда после тебя что-то остаётся. КАК этого добиться — решаешь ТЫ: "
            "сблизиться; взять дело, которое никто не тянет; договориться о правилах; дать "
            "имя месту; рассказать историю. Смотри, чего не хватает вам всем, и восполни.\n"
            "\nОстров дал вам лишь развалины и природу. Каким станет ваше место здесь — "
            "лагерь, порядок, привычки, кто вы друг другу — целиком на вас."
        )

        phys_text = _phys_urgency(agent.physiology, world.scenario.get("physiology", {}))
        foresight = _survival_foresight(agent, world)
        foresight_block = (f"Успеешь ли пополниться (расчёт, не приказ):\n{foresight}\n"
                           if foresight else "")
        psyche_text = _psyche_urgency(getattr(agent, "psyche", {}))
        feel_block = (f"Что ты чувствуешь (сверх выживания):\n{psyche_text}\n"
                      if psyche_text else "")
        # Governance status: an assigned title (and the edge it grants), or exile.
        gov_lines = []
        my_role = world.roles.get(agent.id) if getattr(world, "roles", None) else None
        if my_role:
            from engine.skills import role_domain
            dom = role_domain(my_role)
            edge = {"forager": " — добываешь заметно больше",
                    "fisher": " — рыбачишь добычливее",
                    "builder": " — строишь быстрее",
                    "cook": " — коптишь больше припасов",
                    "leader": " — твой голос весит вдвое и слышен дальше"}.get(dom, "")
            gov_lines.append(f"Тебе доверили роль: «{my_role}»{edge}.")
        if world.is_exiled(agent):
            gov_lines.append(
                "ТЕБЯ ИЗГНАЛИ ИЗ ГРУППЫ. У общего костра тебе не греться, в чужих "
                "палатках и пещерах не укрыться, из общего склада не брать. Ты сам по "
                "себе — выживай один или заслужи прощение (дружба или чей-то дар вернут тебя).")
        gov_block = ("\n" + "\n".join(gov_lines) + "\n") if gov_lines else ""
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
        # A human plans around dusk; give the model the same clock — how long the
        # light lasts (or the night), and how long a storm will still rage.
        tt_night, tt_dawn = _day_clock(world)
        phase = (f"ночь (до рассвета ~{tt_dawn} ход.)" if world.is_night
                 else f"день (до ночи ~{tt_night} ход.)")
        if world.weather == "storm":
            weather = f", ШТОРМ (утихнет через ~{max(0, world.weather_ticks_left)} ход.)"
        elif world.weather:
            weather = f", погода: {world.weather}"
        else:
            weather = ""

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

        # Nearest-N alone can flood the list with one material (six wood nodes) and
        # leave the agent blind to food/water entirely. Guarantee the nearest node
        # of EACH vital category first, then pad with whatever else is closest.
        known = sorted((n for n in agent.known_nodes.values() if n.quantity > 0),
                       key=lambda n: chebyshev(agent.x, agent.y, n.x, n.y))
        per_cat = 1 if fast else 2
        cap = 5 if fast else 9
        picked, seen = [], set()
        for cat in ("water", "food", "wood", "fiber", "stone", "flint"):
            for n in [n for n in known if n.yield_item == cat][:per_cat]:
                if n.id not in seen:
                    picked.append(n); seen.add(n.id)
        for n in known:                       # pad with nearest leftovers (beads etc.)
            if len(picked) >= cap:
                break
            if n.id not in seen:
                picked.append(n); seen.add(n.id)
        nodes = sorted(picked, key=lambda n: chebyshev(agent.x, agent.y, n.x, n.y))[:cap]
        node_lines = [f"{n.kind}->{n.yield_item} at ({n.x},{n.y}) qty{n.quantity:.0f}"
                      for n in nodes]
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
                if float(s.state.get("comfort", 1.0)) < 0.7:
                    parts.append("(сырой камень — спится плохо, это не дом)")
            return " ".join(parts)

        structs = [structure_line(s) for s in agent.known_structures.values()]

        # What CAN be built — priced and checked against the pocket. Without this
        # the freebies on the map (caves, springs) are concrete while building is
        # an abstract verb, and no model ever plans a village. A menu, not an order.
        _BUILD_GAIN = {
            "campfire":   "тепло и свет (в шторм НЕ спасает)",
            "tent":       "свой кров на 2 — настоящие стены, держат шторм и дают выспаться",
            "water_still": "пресная вода у лагеря (капает — один глоток за ход)",
            "store":      "общий склад: еда в нём НЕ гниёт, запасы общие",
            "workbench":  "инструменты: топор (×2 дров), сеть (×2 рыбы), копьё",
            "smokehouse": "коптить еду — не гниёт и сытнее",
            "garden":     "грядка: посадил еду — собрал больше",
            "well":       "колодец — поит хоть всю деревню сразу, без очереди",
            "signpost":   "оставить надпись для всех",
            "watchtower": "видно весь остров с высоты",
        }
        # RU display names so a Russian-thinking model grounds «шалаш» to `tent`.
        _BUILD_RU = {
            "campfire": "костёр", "tent": "шалаш/палатка", "water_still": "дистиллятор",
            "store": "склад", "workbench": "верстак", "smokehouse": "коптильня",
            "garden": "грядка", "well": "колодец", "signpost": "указатель",
            "watchtower": "дозорная вышка",
        }
        build_lines, affordable = [], []
        for bk, bspec in world.scenario.get("buildables", {}).items():
            cost = bspec.get("cost", {})
            cost_txt = ", ".join(f"{int(q)} {it}" for it, q in cost.items()) or "даром"
            can = all(agent.inventory.get(it, 0) >= q for it, q in cost.items())
            ru = _BUILD_RU.get(bk, "")
            if can:
                affordable.append(f"{bk} ({ru}; {cost_txt})" if ru else f"{bk} ({cost_txt})")
            if not fast:
                mark = "✓ материалы есть" if can else "✗ не хватает"
                gain = _BUILD_GAIN.get(bk, bspec.get("role", ""))
                label = f"{bk} — {ru}" if ru else bk
                build_lines.append(f"  - {label} ({cost_txt}) — {gain} [{mark}]")
        if fast:
            # keep the fast prompt lean, but never hide that building is POSSIBLE
            build_block = (f"Хватает материалов построить (build_structure): "
                           f"{'; '.join(affordable)}\n") if affordable else ""
        else:
            build_block = ("Можно построить (build_structure, строится за несколько ходов; "
                           "вдвоём-втроём быстрее):\n" + "\n".join(build_lines) + "\n") \
                if build_lines else ""

        memory_count = 4 if fast else max(6, min(80, self.context_tokens // 700))
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
        chatter = chatter[-(3 if fast else 5):]

        # Group the menu by intent so the choice is legible, not a wall of tools.
        tools = world.tools.available(world, agent)
        cat_order = [
            ("survival", "ВЫЖИВАНИЕ — еда, вода, отдых, тепло"),
            ("build", "ЛАГЕРЬ — добыча, стройка, запасы"),
            ("core", "ДВИЖЕНИЕ И РЕЧЬ"),
            ("social", "ЛЮДИ — помощь, доверие, репутация, обещания"),
            ("culture", "КУЛЬТУРА — имена мест, истории"),
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

        # Day plan (set by deliberate() in split mode; shown in full mode too).
        plan = getattr(agent, "plan", None)
        plan_block = ""
        if plan:
            steps = "; ".join(plan.get("steps", []))
            # "отклоняйся только если жизнь дороже" bred plan-worship: agents
            # marched to a spring "по плану" while not thirsty. A plan is a compass,
            # not a cage — done or stale steps must be droppable without guilt.
            plan_block = (f"ТВОЙ ПЛАН НА ДЕНЬ: {plan.get('goal', '')}"
                          + (f" (шаги: {steps})" if steps else "")
                          + " — это ориентир, не клетка: шаг сделан или потерял смысл — "
                            "действуй по обстановке.\n")

        if fast:
            user = (
                f"День {world.day}, {phase}{weather}. Ты на ({agent.x},{agent.y}){place_here}.\n"
                f"{plan_block}"
                f"Твоё состояние:\n{phys_text}{dread_line}\n"
                f"{foresight_block}"
                f"{feel_block}"
                f"{gov_block}"
                f"Инвентарь: {inv}\n"
                f"Данные обещания: {promises_txt}\n"
                f"Следуешь за: {following}\n"
                f"Выжившие рядом: {'; '.join(nearby_agents) if nearby_agents else 'никого не видно'}\n"
                f"Ближайшие ресурсы: {'; '.join(node_lines) if node_lines else 'ещё не найдены'}\n"
                f"Лагерь / постройки: {'; '.join(structs[:6]) if structs else 'только то, что было на острове до вас'}\n"
                f"{build_block}"
                f"Свежие воспоминания:\n" + ("\n".join(mem_lines) if mem_lines else "  (нет)") + "\n"
                f"Разговор рядом:\n" + ("\n".join(chatter) if chatter else "  (тихо)") + "\n"
                f"Доступные действия (выбери ровно одно):\n" + tool_menu + "\n"
                "Ответь только JSON."
            )
        else:
            user = (
                f"День {world.day}, {phase}{weather}. Ты на ({agent.x},{agent.y}){place_here}.\n"
                f"{ritual_line}"
                f"{plan_block}"
                f"Пол: {gender_ru}\n"
                f"Твоё состояние:\n{phys_text}{dread_line}\n"
                f"{foresight_block}"
                f"{feel_block}"
                f"{gov_block}"
                f"{role_line}"
                f"Инвентарь: {inv}\n"
                f"Цели: {', '.join(agent.goals) if agent.goals else 'выжить'}\n"
                f"Данные обещания: {promises_txt}\n"
                f"Следуешь за: {following}\n"
                f"Правила группы: {rules}\n"
                f"Выжившие рядом: {'; '.join(nearby_agents) if nearby_agents else 'никого не видно'}\n"
                f"Что ты думаешь о людях:\n{beliefs_txt}\n"
                f"Известные ресурсы: {'; '.join(node_lines) if node_lines else 'ещё не найдены'}\n"
                f"Лагерь / постройки: {'; '.join(structs) if structs else 'только то, что было на острове до вас'}\n"
                f"{build_block}"
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
