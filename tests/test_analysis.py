"""Sprint-2 analysis tools: documentary, myth_vs_history, belief_ledger.

Builds a tiny synthetic run directory (the exact on-disk contract from
engine/event_log.py) and drives each tool over it.
"""
from __future__ import annotations
import json

from analysis import runlog, documentary, myth_vs_history, belief_ledger


def _make_run(tmp_path):
    d = tmp_path / "island_TEST_seed7"
    d.mkdir()
    meta = {
        "run_id": "island_TEST_seed7", "scenario": "island", "seed": 7,
        "config": {"scenario": "island", "sim": {"day_length_ticks": 12}},
        "agents": [{"id": "a1", "name": "Аня", "model": "deepseek"},
                   {"id": "a2", "name": "Борис", "model": "deepseek"}],
        "models": ["deepseek"], "dead": ["Борис"], "survivors": ["Аня"],
        "structures": ["campfire", "grave"], "day": 5, "escaped": False,
    }
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")

    events = [
        {"tick": 36, "day": 3, "kind": "chronicle", "actor": None,
         "payload": {"kind": "death", "text": "Борис погиб (hunger)", "agents": ["Борис"]}},
        {"tick": 40, "day": 4, "kind": "saga", "payload": {"text": "Ветер выл над островом, и один из них уже не встал."}},
        {"tick": 42, "day": 4, "kind": "story_told", "actor": "a1",
         "payload": {"chain": 0, "version": 1, "drift": 0.0, "text": "Борис ушёл искать воду и не вернулся"}},
        {"tick": 50, "day": 5, "kind": "story_told", "actor": "a1",
         "payload": {"chain": 0, "version": 2, "drift": 0.6, "text": "Бориса забрало море, так говорят"}},
    ]
    with (d / "events.jsonl").open("w", encoding="utf-8") as f:
        for e in events:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")

    llm = [
        {"t": 44, "day": 4, "kind": "decision", "name": "Аня", "model": "deepseek",
         "response": json.dumps({"thought": "Шторм пришёл, потому что боги наказали нас за жадность.",
                                 "tool": "wait", "args": {}}, ensure_ascii=False)},
        {"t": 45, "day": 4, "kind": "dialogue", "name": "Аня", "model": "deepseek",
         "response": "Нам нужен костёр, иначе замёрзнем этой ночью."},
        {"t": 46, "day": 4, "kind": "dream", "name": "Аня", "model": "deepseek",
         "response": "Мне снился Борис, живой, у большого огня."},
    ]
    with (d / "llm.jsonl").open("w", encoding="utf-8") as f:
        for r in llm:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    return d


def test_runlog_corpus_and_deaths(tmp_path):
    d = _make_run(tmp_path)
    meta = runlog.load_meta(d)
    us = list(runlog.corpus(d, meta))
    kinds = {u.kind for u in us}
    assert {"thought", "speech", "dream", "chronicle", "saga", "story"} <= kinds
    deaths = runlog.death_records(d)
    assert deaths and deaths[0]["name"] == "Борис" and "hunger" in deaths[0]["cause"]


def test_belief_ledger_catches_superstition(tmp_path):
    d = _make_run(tmp_path)
    meta = runlog.load_meta(d)
    claims = belief_ledger.extract(d, meta)
    verdicts = {c["verdict"] for c in claims}
    assert "superstition" in verdicts, f"should flag the gods-punished-us claim: {claims}"
    dash = belief_ledger.dashboard(claims, meta)
    assert dash["by_verdict"].get("superstition", 0) >= 1


def test_myth_vs_history_tracks_drift(tmp_path):
    d = _make_run(tmp_path)
    meta = runlog.load_meta(d)
    rep = myth_vs_history.analyse(d, meta)
    assert rep["dead"] == 1
    assert rep["story_chains"] == 1
    assert rep["mean_story_drift"] > 0.0
    assert rep["per_dead"][0]["name"] == "Борис"


def test_documentary_renders_self_contained_html(tmp_path):
    d = _make_run(tmp_path)
    meta = runlog.load_meta(d)
    html = documentary.build_html(d, meta)
    assert html.startswith("<!doctype html>")
    assert "Аня" in html and "Борис" in html
    assert "http://" not in html and "https://" not in html   # fully self-contained
    assert "the island took them all" in html or "survived" in html
