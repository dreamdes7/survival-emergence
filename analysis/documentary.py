"""Run documentary — one shareable page from a finished run.

Folds a recorded run into a single self-contained HTML file: the verdict, the
cast and their fates, a day-by-day chronicle, the narrator's saga, real voices
(spoken lines and a dream), the dead and what built them, and what was left
standing. One click after a run → a post ready for reddit/twitter.

    py -3.12 -m analysis.documentary logs/runs/<run_id>

Everything is already written by the recorder — this only lays it out. The file
is fully self-contained (inline CSS, no external assets), so it opens anywhere.
"""
from __future__ import annotations
import argparse
import html
import sys
from collections import defaultdict
from pathlib import Path

from analysis.runlog import (resolve_run, load_meta, iter_events, corpus, death_records)

_KIND_EMOJI = {"death": "💀", "role": "👑", "build": "🏗️", "culture": "📖", "feast": "🔥",
               "taboo": "🩸", "theft": "👐", "burial": "⚰️", "gossip": "🗣️", "promise": "🤝",
               "rule": "⚖️", "escape": "🚢", "palimpsest": "🏝️", "fear_sign": "🌒"}


def _e(s) -> str:
    return html.escape(str(s))


def _chronicle(run_dir):
    by_day = defaultdict(list)
    for ev in iter_events(run_dir):
        if ev.get("kind") != "chronicle":
            continue
        pay = ev.get("payload") or {}
        by_day[int(ev.get("day", 0))].append(
            {"kind": pay.get("kind", ""), "text": pay.get("text", "")})
    return by_day


def _saga(run_dir):
    out = []
    for ev in iter_events(run_dir):
        if ev.get("kind") == "saga":
            out.append((int(ev.get("day", 0)), (ev.get("payload") or {}).get("text", "")))
    return out


def build_html(run_dir: Path, meta: dict) -> str:
    agents = meta.get("agents", [])
    dead = set(meta.get("dead", []))
    survivors = set(meta.get("survivors", []))
    deaths = {d["name"]: d for d in death_records(run_dir)}
    chron = _chronicle(run_dir)
    saga = _saga(run_dir)

    # a handful of real voices
    quotes, dream = [], ""
    for u in corpus(run_dir, meta, voices=("speech", "dream")):
        if u.kind == "speech" and len(u.text) > 8 and len(quotes) < 6:
            quotes.append((u.agent, u.text))
        elif u.kind == "dream" and not dream and len(u.text) > 20:
            dream = u.text

    scenario = meta.get("scenario") or (meta.get("config") or {}).get("scenario", "world")
    days = meta.get("day", "?")
    total = len(agents)
    if meta.get("escaped"):
        verdict = "🚢 escaped the island"
    elif survivors:
        verdict = f"{len(survivors)}/{total} survived {days} days"
    else:
        verdict = f"the island took them all by day {days}"

    css = """
    :root{color-scheme:dark}
    *{box-sizing:border-box}
    body{margin:0;background:#0c0f10;color:#d7d2c6;font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif}
    .wrap{max-width:760px;margin:0 auto;padding:40px 22px 80px}
    h1{font-size:30px;margin:0 0 6px;color:#f0ebdd;letter-spacing:.3px}
    .sub{color:#8b857a;font-size:14px;margin-bottom:26px}
    .verdict{font-size:20px;color:#e6dfcd;background:#15191a;border:1px solid #232a2b;
      border-radius:10px;padding:16px 20px;margin:22px 0}
    h2{font-size:13px;text-transform:uppercase;letter-spacing:2px;color:#7f8a7a;
      margin:38px 0 14px;border-bottom:1px solid #1e2423;padding-bottom:6px}
    .cast{display:flex;flex-wrap:wrap;gap:10px}
    .card{background:#14181a;border:1px solid #222827;border-radius:9px;padding:10px 13px;min-width:150px;flex:1}
    .card .n{font-size:16px;color:#e6dfcd}
    .card .f{font-size:13px;color:#8b857a}
    .dead .n{color:#9d221c}
    .day{margin:16px 0}
    .day .d{font-size:12px;color:#5f6b5c;letter-spacing:1px;margin-bottom:4px}
    .ev{padding:3px 0;color:#c8c2b4}
    .saga{border-left:2px solid #3a3f39;padding:4px 0 4px 16px;margin:14px 0;color:#b5b0a3;font-style:italic}
    .q{margin:10px 0;color:#cfc9bb}
    .q b{color:#9aa08f;font-style:normal}
    .dream{background:#111517;border:1px dashed #2a302f;border-radius:9px;padding:16px 20px;
      color:#a9a99c;font-style:italic}
    .foot{margin-top:50px;color:#4f574c;font-size:12px;text-align:center}
    """

    P = []
    P.append(f"<div class=wrap><h1>{_e(scenario).title()} — a run</h1>")
    P.append(f"<div class=sub>{_e(meta.get('run_id',''))} · "
             f"seed {_e(meta.get('seed'))} · {_e(', '.join(meta.get('models', [])))}</div>")
    P.append(f"<div class=verdict>{_e(verdict)}</div>")

    P.append("<h2>The cast</h2><div class=cast>")
    for a in agents:
        nm = a.get("name", "?")
        is_dead = nm in dead
        if is_dead and nm in deaths:
            fate = f"died D{deaths[nm]['day']} · {deaths[nm]['cause']}"
        elif is_dead:
            fate = "perished"
        else:
            fate = "survived"
        P.append(f"<div class='card{' dead' if is_dead else ''}'>"
                 f"<div class=n>{_e(nm)}</div><div class=f>{_e(fate)} · {_e(a.get('model',''))}</div></div>")
    P.append("</div>")

    P.append("<h2>The chronicle</h2>")
    saga_by_day = defaultdict(list)
    for d, t in saga:
        saga_by_day[d].append(t)
    for day in sorted(set(chron) | set(saga_by_day)):
        P.append(f"<div class=day><div class=d>DAY {day}</div>")
        for s in saga_by_day.get(day, []):
            if s:
                P.append(f"<div class=saga>{_e(s)}</div>")
        for ev in chron.get(day, []):
            em = _KIND_EMOJI.get(ev["kind"], "·")
            P.append(f"<div class=ev>{em} {_e(ev['text'])}</div>")
        P.append("</div>")

    if quotes:
        P.append("<h2>Voices</h2>")
        for who, txt in quotes:
            P.append(f"<div class=q><b>{_e(who)}:</b> «{_e(txt)}»</div>")
    if dream:
        P.append(f"<h2>A dream</h2><div class=dream>{_e(dream)}</div>")

    structs = meta.get("structures", [])
    if structs:
        P.append("<h2>What they left</h2>")
        P.append(f"<div class=ev>{_e(', '.join(structs))}</div>")

    P.append("<div class=foot>generated from logs/runs — survival-emergence</div></div>")
    return (f"<!doctype html><html lang=en><head><meta charset=utf-8>"
            f"<meta name=viewport content='width=device-width,initial-scale=1'>"
            f"<title>{_e(meta.get('run_id','run'))}</title><style>{css}</style></head>"
            f"<body>{''.join(P)}</body></html>")


def main() -> None:
    ap = argparse.ArgumentParser(description="Render a shareable HTML documentary of a run.")
    ap.add_argument("run", help="run_id or path to logs/runs/<id>")
    args = ap.parse_args()
    run_dir = resolve_run(args.run)
    meta = load_meta(run_dir)
    if not meta:
        print(f"no meta.json under {run_dir}")
        return
    out = run_dir / "documentary.html"
    out.write_text(build_html(run_dir, meta), encoding="utf-8")
    print(f"🎬 documentary → {out}")


if __name__ == "__main__":
    sys.exit(main())
