"""Shared reader for a recorded run directory (logs/runs/<id>/).

The three Sprint-2 analysis tools (documentary, myth_vs_history, belief_ledger)
all reconstruct a run from the SAME on-disk artifacts, so the loading, response
parsing and corpus-building live here once.

On disk (see engine/event_log.py):
  meta.json     manifest: agents, dead/survivors, structures, culture, provenance
  events.jsonl  typed stream: chronicle, saga, story_told, decision, dialogue, …
  llm.jsonl     full prompt+response per real model call (real runs only)

An `Utterance` is one attributable piece of text — an agent's thought, a spoken
line, a dream, a chronicle fact, a saga fragment — the common substrate the
analysis tools mine.
"""
from __future__ import annotations
import json
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNS_DIR = ROOT / "logs" / "runs"


def resolve_run(arg: str) -> Path:
    """Accept a run_id, a path, or a logs/runs-relative dir; return the directory."""
    p = Path(arg)
    for cand in (p, RUNS_DIR / arg, ROOT / arg):
        if (cand / "meta.json").exists() or (cand / "events.jsonl").exists():
            return cand
    return p


def load_meta(run_dir: Path) -> dict:
    p = run_dir / "meta.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def iter_events(run_dir: Path):
    p = run_dir / "events.jsonl"
    if not p.exists():
        return
    for line in p.open(encoding="utf-8"):
        line = line.strip()
        if line:
            try:
                yield json.loads(line)
            except ValueError:
                continue


def iter_llm(run_dir: Path):
    p = run_dir / "llm.jsonl"
    if not p.exists():
        return
    for line in p.open(encoding="utf-8"):
        line = line.strip()
        if line:
            try:
                yield json.loads(line)
            except ValueError:
                continue


def parse_response(resp) -> dict:
    """Normalise a recorded model response into {thought, say, text}.

    Decision calls store a JSON string ({thought, tool, args}); dialogue / dream /
    reflection store a plain string. Returns whatever text each carries."""
    out = {"thought": "", "say": "", "text": ""}
    if resp is None:
        return out
    if isinstance(resp, dict):
        data = resp
    elif isinstance(resp, str):
        s = resp.strip()
        if s.startswith("{") and '"' in s:
            try:
                data = json.loads(s)
            except ValueError:
                out["text"] = s
                return out
        else:
            out["text"] = s
            return out
    else:
        return out
    out["thought"] = str(data.get("thought", "")).strip()
    args = data.get("args", {}) if isinstance(data.get("args"), dict) else {}
    out["say"] = str(args.get("message") or data.get("say") or "").strip()
    return out


@dataclass
class Utterance:
    tick: int
    day: int
    agent: str
    kind: str          # thought | speech | dream | reflection | chronicle | saga | story
    text: str


def _day_of(tick: int, meta: dict) -> int:
    dl = int(((meta.get("config") or {}).get("sim") or {}).get("day_length_ticks", 12) or 12)
    return tick // max(1, dl) + 1


def corpus(run_dir: Path, meta: dict | None = None,
           voices=("thought", "speech", "dream", "reflection", "chronicle", "saga", "story")):
    """Yield Utterances across the requested voices. First-person voices (thought/
    speech/dream/reflection) come from llm.jsonl (real runs); chronicle/saga/story
    come from events.jsonl and always exist."""
    meta = meta if meta is not None else load_meta(run_dir)
    want = set(voices)

    if want & {"thought", "speech", "dream", "reflection"}:
        for r in iter_llm(run_dir):
            kind = r.get("kind", "")
            agent = r.get("name", "?")
            tick = int(r.get("t", 0))
            day = int(r.get("day", _day_of(tick, meta)))
            p = parse_response(r.get("response"))
            if "thought" in want and kind == "decision" and p["thought"]:
                yield Utterance(tick, day, agent, "thought", p["thought"])
            if "speech" in want and kind == "dialogue" and (p["text"] or p["say"]):
                yield Utterance(tick, day, agent, "speech", p["text"] or p["say"])
            if "speech" in want and kind == "decision" and p["say"]:
                yield Utterance(tick, day, agent, "speech", p["say"])
            if "dream" in want and kind == "dream" and p["text"]:
                yield Utterance(tick, day, agent, "dream", p["text"])
            if "reflection" in want and kind == "reflection" and p["text"]:
                yield Utterance(tick, day, agent, "reflection", p["text"])

    if want & {"chronicle", "saga", "story"}:
        for e in iter_events(run_dir):
            kind = e.get("kind", "")
            pay = e.get("payload") or {}
            tick = int(e.get("tick", 0))
            day = int(e.get("day", _day_of(tick, meta)))
            if "chronicle" in want and kind == "chronicle":
                agents = pay.get("agents") or []
                yield Utterance(tick, day, agents[0] if agents else "—",
                                "chronicle", str(pay.get("text", "")))
            elif "saga" in want and kind == "saga":
                yield Utterance(tick, day, "narrator", "saga", str(pay.get("text", "")))
            elif "story" in want and kind == "story_told":
                yield Utterance(tick, day, e.get("actor", "?"), "story",
                                str(pay.get("text", "")))


def death_records(run_dir: Path):
    """Ground truth: who died, when, and of what — parsed from chronicle deaths."""
    out = []
    for e in iter_events(run_dir):
        if e.get("kind") != "chronicle":
            continue
        pay = e.get("payload") or {}
        if pay.get("kind") != "death":
            continue
        text = str(pay.get("text", ""))
        agents = pay.get("agents") or []
        name = agents[0] if agents else (text.split()[0] if text else "?")
        cause = ""
        if "(" in text and ")" in text:
            cause = text[text.find("(") + 1:text.find(")")]
        out.append({"name": name, "day": int(e.get("day", 0)),
                    "tick": int(e.get("tick", 0)), "cause": cause, "text": text})
    return out


def story_chains(run_dir: Path):
    """Reconstruct tell_story chains from story_told events (telephone game)."""
    chains: dict = {}
    for e in iter_events(run_dir):
        if e.get("kind") != "story_told":
            continue
        pay = e.get("payload") or {}
        cid = pay.get("chain")
        ch = chains.setdefault(cid, {"id": cid, "versions": [], "drift": 0.0})
        ch["versions"].append({"tick": int(e.get("tick", 0)), "teller": e.get("actor", "?"),
                               "text": str(pay.get("text", ""))})
        ch["drift"] = float(pay.get("drift", ch["drift"]))
    return list(chains.values())
