"""The Narrator (Sprint 1, FRONTIER_IDEAS 4.1).

A separate LLM voice that reads the raw event stream and retells it as a saga —
not "Boris gathered 5 wood" but prose a spectator wants to follow. Runs every N
ticks over whatever happened since its last entry (chronicle + notable feed),
keeps continuity with its own previous line, and appends to `world.saga`
(serialized to the observer UI, mirrored into the typed event stream).

Costs one small LLM call per interval; disabled automatically in stub-only
worlds (no client / no model to narrate with). Never breaks the simulation —
any failure just means no saga entry this interval.
"""
from __future__ import annotations

SAGA_LIMIT = 60          # entries kept on the world (UI shows the tail)
MATERIAL_LINES = 28      # max raw lines fed to the narrator per interval


class Narrator:
    def __init__(self, client, model: str, every_ticks: int = 12) -> None:
        self.client = client               # an OpenRouterLLM (shared or dedicated)
        self.model = model
        self.every_ticks = max(1, int(every_ticks))
        self.last_tick = -1

    # ── material gathering ─────────────────────────────────────────────────────
    def _material(self, world) -> str:
        """Everything noteworthy since the previous saga entry, as plain lines."""
        since = self.last_tick
        lines: list[str] = []
        for c in world.chronicle:
            if c["tick"] > since:
                lines.append(f"[важное] {c['text']}")
        for f in world.feed:
            if f["tick"] <= since:
                continue
            if f["kind"] == "speech":
                lines.append(f"{f['agent']}: {f['result']}")
            elif f["kind"] == "social":
                lines.append(f"[между людьми] {f['agent']}: {f['result']}")
        return "\n".join(lines[-MATERIAL_LINES:])

    # ── narration ──────────────────────────────────────────────────────────────
    def maybe_tick(self, world, force: bool = False) -> str | None:
        if not force and world.tick - self.last_tick < self.every_ticks:
            return None
        material = self._material(world)
        prev = world.saga[-1]["text"] if world.saga else ""
        if not material and not force:
            self.last_tick = world.tick
            return None

        phase = "ночь" if world.is_night else "день"
        weather = f", {world.weather}" if world.weather else ""
        alive = len(world.living_agents())
        messages = [
            {"role": "system", "content":
                "Ты рассказчик — голос за кадром хроники выживших. По сырым записям "
                "напиши СЛЕДУЮЩИЙ фрагмент саги: 2-3 предложения по-русски, живо и "
                "образно, в настоящем времени, о людях и их отношениях, не о цифрах. "
                "Никаких координат, названий инструментов и чисел. Не пересказывай "
                "всё — выбери главное напряжение момента. Только сам фрагмент."},
            {"role": "user", "content":
                (f"Предыдущий фрагмент саги: {prev}\n\n" if prev else "") +
                f"День {world.day}, {phase}{weather}. Живых: {alive}.\n"
                f"Записи с прошлого фрагмента:\n{material or '(тихое время — жизнь идёт своим чередом)'}\n\n"
                "Следующий фрагмент саги:"},
        ]
        try:
            data = self.client._post_with_retry(self.model, messages)
            usage = data.get("usage", {}) or {}
            self.client.budget.add(usage)
            text = (data["choices"][0]["message"].get("content") or "").strip()
            text = text.strip('"').strip()
        except Exception:
            self.last_tick = world.tick    # don't retry every tick on a dead API
            return None
        if not text:
            self.last_tick = world.tick
            return None

        self.last_tick = world.tick
        entry = {"tick": world.tick, "day": world.day, "text": text[:500]}
        world.saga.append(entry)
        if len(world.saga) > SAGA_LIMIT:
            world.saga = world.saga[-SAGA_LIMIT:]
        world.emit("saga", payload=entry)
        rec = getattr(world, "recorder", None)
        if rec is not None:
            rec.llm({"t": world.tick, "day": world.day, "kind": "saga",
                     "agent": "narrator", "name": "Рассказчик", "model": self.model,
                     "provider": getattr(self.client, "provider", "?"),
                     "prompt": messages, "response": text, "usage": usage, "error": None})
        return text
