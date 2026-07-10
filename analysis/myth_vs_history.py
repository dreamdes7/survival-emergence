"""Myth vs history — how the island turns the dead into legend.

Ground truth is the event stream: who died, when, of what. Myth is everything the
survivors say afterwards. This tool lines the two up — for each death it holds the
factual record against how (and whether) the dead are spoken of later — and reports
the drift. Where survivors actually retold stories (tell_story), it also reports the
telephone-game drift from a story's first telling to its last.

    py -3.12 -m analysis.myth_vs_history logs/runs/<run_id>

Writes myth_vs_history.json and prints a report. No fabrication: it surfaces the
true record and the real later words side by side — the gap between them IS the
artifact. Such a measurement of memory drift exists in no other multi-agent sim.
"""
from __future__ import annotations
import argparse
import json
import re
import sys
from pathlib import Path

from analysis.runlog import (resolve_run, load_meta, corpus, death_records, story_chains)

_CAUSE_RU = {"hunger": ("голод", "есть", "еда", "голодн"), "thirst": ("жажд", "вод", "пить"),
             "warmth": ("холод", "мёрз", "мерз", "замёрз", "тепл", "стуж"),
             "energy": ("устал", "сил", "измотан"), "oxygen": ("воздух", "кислород", "задох")}
_LEGEND = ("герой", "спас", "спасл", "дух", "призрак", "легенд", "вернул", "жив",
           "видел его", "видела её", "явил", "hero", "spirit", "ghost", "legend")


def _mentions(name: str, text: str) -> bool:
    if not name or name == "?":
        return False
    return re.search(r"\b" + re.escape(name), text, re.IGNORECASE) is not None


def analyse(run_dir: Path, meta: dict) -> dict:
    deaths = death_records(run_dir)
    # gather all later-voices once
    voices = list(corpus(run_dir, meta,
                         voices=("thought", "speech", "dream", "reflection", "saga", "story")))

    per_dead = []
    for d in deaths:
        after = [u for u in voices if u.tick >= d["tick"] and _mentions(d["name"], u.text)]
        cause_keys = [c for c in d["cause"].replace(" ", "").split(",") if c]
        cause_vocab = tuple(w for k in cause_keys for w in _CAUSE_RU.get(k, ()))
        recalled_cause = any(any(w in u.text.lower() for w in cause_vocab) for u in after) \
            if cause_vocab else False
        legendized = [u for u in after if any(w in u.text.lower() for w in _LEGEND)]
        per_dead.append({
            "name": d["name"], "day": d["day"], "true_cause": d["cause"],
            "mentions_after_death": len(after),
            "remembered": bool(after),
            "true_cause_recalled": recalled_cause,
            "legendized": len(legendized),
            "sample_remembrance": [f"D{u.day} {u.agent} ({u.kind}): {u.text[:120]}"
                                   for u in after[:3]],
        })

    chains = story_chains(run_dir)
    chain_report = [{"id": c["id"], "retellings": len(c["versions"]), "drift": c["drift"],
                     "first": c["versions"][0]["text"][:110] if c["versions"] else "",
                     "last": c["versions"][-1]["text"][:110] if c["versions"] else ""}
                    for c in chains if len(c["versions"]) >= 2]

    n_dead = len(per_dead)
    remembered = sum(1 for d in per_dead if d["remembered"])
    cause_kept = sum(1 for d in per_dead if d["true_cause_recalled"])
    mean_drift = round(sum(c["drift"] for c in chain_report) / len(chain_report), 3) \
        if chain_report else 0.0
    return {
        "run_id": meta.get("run_id"),
        "dead": n_dead,
        "remembered_share": round(remembered / n_dead, 3) if n_dead else 0.0,
        "true_cause_retained_share": round(cause_kept / n_dead, 3) if n_dead else 0.0,
        "story_chains": len(chain_report),
        "mean_story_drift": mean_drift,
        "per_dead": per_dead,
        "chains": chain_report,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Measure memory drift: history vs myth.")
    ap.add_argument("run", help="run_id or path to logs/runs/<id>")
    args = ap.parse_args()
    run_dir = resolve_run(args.run)
    meta = load_meta(run_dir)
    rep = analyse(run_dir, meta)
    out = run_dir / "myth_vs_history.json"
    out.write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"\n📜 MYTH vs HISTORY — {rep['run_id']}")
    print(f"   dead                    : {rep['dead']}")
    print(f"   remembered after death  : {rep['remembered_share']*100:.0f}%")
    print(f"   true cause still spoken : {rep['true_cause_retained_share']*100:.0f}%")
    print(f"   story chains / drift    : {rep['story_chains']} / {rep['mean_story_drift']}")
    for d in rep["per_dead"]:
        tag = "forgotten" if not d["remembered"] else (
            "cause kept" if d["true_cause_recalled"] else "cause drifted")
        leg = f", legendized×{d['legendized']}" if d["legendized"] else ""
        print(f"     · {d['name']:<8} D{d['day']} died of ({d['true_cause']}) — "
              f"{d['mentions_after_death']} mentions, {tag}{leg}")
    if rep["chains"]:
        print("   telephone game:")
        for c in rep["chains"][:4]:
            print(f"     · chain {c['id']}: {c['retellings']} tellings, drift {c['drift']}")
            print(f"         first «{c['first']}»")
            print(f"         last  «{c['last']}»")
    print(f"   → {out}")


if __name__ == "__main__":
    sys.exit(main())
