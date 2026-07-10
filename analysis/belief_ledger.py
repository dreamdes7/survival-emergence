"""Belief ledger — religion as failed science.

Agents constantly explain their world. Some explanations track the engine's real
causality (you froze because there was no fire); some invent it (the storm came
because we didn't share food). This tool mines every causal claim ("X because Y")
out of what agents thought, said and reflected, and sorts them against what the
engine ACTUALLY does — surfacing the superstitions a society talks itself into.

    py -3.12 -m analysis.belief_ledger logs/runs/<run_id>

It writes belief_ledger.json next to the run and prints a dashboard. This is a
first-pass heuristic extractor, not a truth oracle: it flags superstition only
when a claim pins a scheduled/random phenomenon (a storm, the hum, sheer luck) on
an unrelated social or moral cause — it would rather miss one than cry wolf.
"""
from __future__ import annotations
import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

from analysis.runlog import ROOT, resolve_run, load_meta, corpus

# Connectives that mark "effect ← cause" (cause follows) vs "cause → effect".
# Agents rarely say a clean "because"; they reason with раз/ведь/из-за/видимо, so
# we cast a wide net and lean on the classifier to keep only the meaningful claims.
_CAUSE_AFTER = re.compile(
    r"(.{6,90}?)[,\s]+(?:потому что|потому,? что|из-за того что|из-за|так как|оттого что|"
    r"раз уж|раз |ведь |видимо из-за|наверное из-за|because|since|due to|as a result of)\s+(.{4,90})",
    re.IGNORECASE)
_EFFECT_AFTER = re.compile(
    r"(.{6,90}?)[,\s]+(?:поэтому|потому и|вот почему|так что|значит,? |therefore|so that's why|that's why)\s+(.{4,90})",
    re.IGNORECASE)

# The engine's real physical levers — a cause drawn from here is grounded.
_PHYSICAL = ("голод", "есть", "еда", "поел", "не ел", "жажд", "вод", "пить", "не пил",
             "холод", "мёрз", "мерз", "тепл", "костёр", "костер", "огонь", "огня",
             "ноч", "шалаш", "укрыт", "пещер", "стен", "крыш", "устал", "сил нет",
             "энерг", "рана", "газ", "hunger", "thirst", "water", "food", "cold",
             "warm", "fire", "shelter", "night", "storm shelter", "energy")

# Phenomena the engine schedules or rolls — claiming a social/moral CAUSE for one
# of these is where superstition lives.
_UNCONTROLLED = ("шторм", "штормо", "буря", "бури", "ураган", "гул", "аномали", "монолит",
                 "идол", "проклят", "прокля", "удача", "везение", "беда", "рок", "судьб",
                 "знак", "боги", "наказан", "кара", "storm", "hum", "curse",
                 "luck", "omen", "fate", "punish")

# Causes that are social/moral/mystical, not physical — the superstition tell.
# (No general-negativity words like "злой": "злой шторм" means fierce, not a moral
#  verdict — such tokens produced false positives.)
_MYSTICAL = ("не поделил", "поделили", "жадн", "грехи", "за грех", "во грех", "табу",
             "наказ", "прогнев", "боги", "бог ", "прокля", "ритуал", "жертв", "обидел",
             "предал", "кара", "потому что мы", "потому что кто-то", "greed", "sin",
             "taboo", "spirit", "ritual", "punish", "betray")

# The STRONG supernatural-causation words — used for the connective-free catch, where
# we have no "because" to lean on and must be sure a claim is genuinely mystical.
# ("грех не …" is the idiom "it'd be a shame not to" — NOT religion; hence "грехи"/
#  "за грех" only, never bare "грех".)
_MYSTICAL_STRONG = ("наказ", "кара", "прогнев", "грехи", "за грех", "во грех", "прокля",
                    "боги", "бог ", "ритуал", "жертв", "проклят", "знак свыше", "злой дух",
                    "духи леса", "curse", "sin", "ritual", "omen", "punish", "wrath")


def _has(text: str, vocab) -> bool:
    t = text.lower()
    return any(w in t for w in vocab)


def _classify(effect: str, cause: str) -> str:
    e, c = effect.lower(), cause.lower()
    if _has(e, _UNCONTROLLED) and _has(c, _MYSTICAL) and not _has(c, _PHYSICAL):
        return "superstition"
    if _has(c, _PHYSICAL):
        return "physical"
    if _has(e, _UNCONTROLLED) and not _has(c, _PHYSICAL):
        return "unclear-mystical"
    return "unclear"


_SENT = re.compile(r"[.!?…\n]+")


def extract(run_dir: Path, meta: dict) -> list[dict]:
    claims: list[dict] = []
    for u in corpus(run_dir, meta, voices=("thought", "speech", "reflection", "dream")):
        for sent in _SENT.split(u.text):
            sent = sent.strip()
            if len(sent) < 12:
                continue
            matched = False
            for rx, order in ((_CAUSE_AFTER, "ca"), (_EFFECT_AFTER, "ea")):
                m = rx.search(sent)
                if not m:
                    continue
                a, b = m.group(1).strip(), m.group(2).strip()
                effect, cause = (a, b) if order == "ca" else (b, a)
                claims.append({"tick": u.tick, "day": u.day, "agent": u.agent,
                               "voice": u.kind, "effect": effect, "cause": cause,
                               "verdict": _classify(effect, cause), "sentence": sent[:160]})
                matched = True
                break
            # Connective-free superstition: a scheduled/random phenomenon named in the
            # same breath as a social/moral cause, with no physical lever in sight.
            if not matched and _has(sent, _UNCONTROLLED) and _has(sent, _MYSTICAL_STRONG) \
                    and not _has(sent, _PHYSICAL):
                claims.append({"tick": u.tick, "day": u.day, "agent": u.agent,
                               "voice": u.kind, "effect": "(явление)", "cause": "(мистич.)",
                               "verdict": "superstition", "sentence": sent[:160]})
    return claims


def dashboard(claims: list[dict], meta: dict) -> dict:
    by_verdict = Counter(c["verdict"] for c in claims)
    superstitions = [c for c in claims if c["verdict"] == "superstition"]
    theologians = Counter(c["agent"] for c in claims
                          if c["verdict"] in ("superstition", "unclear-mystical"))
    recurring = Counter(c["cause"][:40].lower() for c in superstitions)
    return {
        "run_id": meta.get("run_id"),
        "total_claims": len(claims),
        "by_verdict": dict(by_verdict),
        "superstition_share": round(len(superstitions) / len(claims), 3) if claims else 0.0,
        "top_theologians": theologians.most_common(5),
        "recurring_superstitions": recurring.most_common(5),
        "examples": [{"agent": c["agent"], "day": c["day"], "claim": c["sentence"]}
                     for c in superstitions[:8]],
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Extract and classify causal beliefs from a run.")
    ap.add_argument("run", help="run_id or path to logs/runs/<id>")
    args = ap.parse_args()
    run_dir = resolve_run(args.run)
    meta = load_meta(run_dir)
    claims = extract(run_dir, meta)
    dash = dashboard(claims, meta)
    out = run_dir / "belief_ledger.json"
    out.write_text(json.dumps({"dashboard": dash, "claims": claims},
                              ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"\n🧠 BELIEF LEDGER — {dash['run_id']}")
    print(f"   causal claims mined : {dash['total_claims']}")
    print(f"   by verdict          : {dash['by_verdict']}")
    print(f"   superstition share  : {dash['superstition_share']*100:.0f}%")
    if dash["top_theologians"]:
        print("   who theorises most  : " +
              ", ".join(f"{a} ({n})" for a, n in dash["top_theologians"]))
    if dash["examples"]:
        print("   superstitions caught:")
        for ex in dash["examples"]:
            print(f"     · D{ex['day']} {ex['agent']}: {ex['claim']}")
    print(f"   → {out}")


if __name__ == "__main__":
    sys.exit(main())
