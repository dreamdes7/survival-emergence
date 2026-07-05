"""Memory stream: relevance-aware retrieval and recursive summarisation."""
from __future__ import annotations

from agents.memory import MemoryStream


def test_retrieve_prefers_relevant_and_recent():
    m = MemoryStream()
    for i in range(20):
        m.add(tick=i, day=1, kind="observation", text=f"walked past a rock number {i}", importance=1.0)
    m.add(tick=20, day=1, kind="social", text="Борис gave me water at the spring", importance=2.0)
    top = m.retrieve("water spring Борис", n=3)
    assert any("water" in e.text for e in top), "relevant memory not surfaced"


def test_retrieve_empty_query_is_recency():
    m = MemoryStream()
    for i in range(10):
        m.add(tick=i, day=1, kind="observation", text=f"event {i}", importance=1.0)
    top = m.retrieve("", n=3)
    ticks = {e.tick for e in top}
    assert max(ticks) == 9, "most recent memory should rank without a query"


def test_compact_bounds_the_stream():
    m = MemoryStream()
    for i in range(300):
        imp = 2.6 if i % 50 == 0 else 1.0     # a few high-importance memories
        m.add(tick=i, day=1, kind="observation", text=f"minor {i}", importance=imp)
    before = len(m.entries)
    m.compact(keep_recent=120)
    after = len(m.entries)
    assert after < before, "compact did not shrink the stream"
    # High-importance memories survive verbatim; a digest replaces the minor bulk.
    assert any(e.text.startswith("[итог") for e in m.entries)
    assert sum(1 for e in m.entries if e.importance >= 2.3) >= 1


def test_compact_noop_when_small():
    m = MemoryStream()
    for i in range(50):
        m.add(tick=i, day=1, kind="observation", text=f"x{i}")
    m.compact(keep_recent=120)
    assert len(m.entries) == 50
