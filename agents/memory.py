"""Generative-Agents style memory: stream + scored retrieval + reflection diary."""
from __future__ import annotations
from dataclasses import dataclass


@dataclass
class MemoryEntry:
    tick: int
    day: int
    kind: str            # observation | action | social | reflection
    text: str
    importance: float    # 1 (mundane) .. 3 (significant)


class MemoryStream:
    def __init__(self) -> None:
        self.entries: list[MemoryEntry] = []
        self.diary: list[tuple[int, str]] = []   # (tick, text)

    def add(self, tick: int, day: int, kind: str, text: str, importance: float = 1.0) -> None:
        self.entries.append(MemoryEntry(tick, day, kind, text, importance))

    def add_diary(self, tick: int, text: str) -> None:
        self.diary.append((tick, text))

    def recent(self, n: int = 8) -> list[MemoryEntry]:
        return self.entries[-n:]

    def compact(self, keep_recent: int = 120, summary_kind: str = "reflection") -> None:
        """Recursive summarisation: once the stream grows past ~2x keep_recent,
        fold the oldest half into a single summary entry so the stream stays
        bounded and old detail doesn't crowd retrieval. High-importance memories
        (reflections, deaths, bonds) are preserved verbatim; the rest collapse
        into one dated digest. Cheap, deterministic, no LLM required."""
        if len(self.entries) <= keep_recent * 2:
            return
        cutoff = len(self.entries) - keep_recent
        old, recent = self.entries[:cutoff], self.entries[cutoff:]
        preserved = [e for e in old if e.importance >= 2.3]
        minor = [e for e in old if e.importance < 2.3]
        if minor:
            by_kind: dict[str, int] = {}
            for e in minor:
                by_kind[e.kind] = by_kind.get(e.kind, 0) + 1
            span = f"ticks {minor[0].tick}–{minor[-1].tick}"
            digest = ", ".join(f"{k}×{c}" for k, c in sorted(by_kind.items()))
            summary = MemoryEntry(
                tick=minor[-1].tick, day=minor[-1].day, kind=summary_kind,
                text=f"[итог {span}] за это время: {digest}", importance=1.8)
            self.entries = [summary] + preserved + recent
        else:
            self.entries = preserved + recent

    def retrieve(self, query: str = "", n: int = 6) -> list[MemoryEntry]:
        """Score by recency (decay) + importance + keyword relevance to query."""
        if not self.entries:
            return []
        last_tick = self.entries[-1].tick
        qwords = set(query.lower().split())
        scored: list[tuple[float, MemoryEntry]] = []
        for e in self.entries:
            recency = 0.94 ** max(0, last_tick - e.tick)
            relevance = 0.0
            if qwords:
                ewords = set(e.text.lower().split())
                relevance = len(qwords & ewords) / max(1, len(qwords))
            score = recency + 0.3 * e.importance + relevance
            scored.append((score, e))
        scored.sort(key=lambda x: -x[0])
        return [e for _, e in scored[:n]]
