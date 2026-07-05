"""Model leaderboard: which model builds the better society?

Aggregates run manifests (meta.json) grouped by model and prints the benchmark
table: survival, escape, decision cleanliness (heuristic share), theory-of-mind
accuracy, cultural output (memes/myths), and API cost.

    py -3.12 -m analysis.leaderboard logs/runs/run_a logs/runs/run_b ...
    py -3.12 -m analysis.leaderboard --batch logs/runs/_batch_model-arena_*/summary.json

A run's model key is `agents.model_override` from its config (or "mixed" when a
roster mixes models). Pure-stub runs group under "stub" — a debug baseline, not
a contestant.
"""
from __future__ import annotations
import argparse
import json
import sys
from glob import glob
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _model_key(meta: dict) -> str:
    models = [m for m in meta.get("models", []) if m]
    if len(models) == 1:
        return models[0]
    real = [m for m in models if m != "stub"]
    if not real:
        return "stub"
    return real[0] if len(real) == 1 else "mixed"


def _load(run_dir: Path) -> dict | None:
    p = run_dir / "meta.json"
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def aggregate(run_dirs: list[Path]) -> list[dict]:
    """Group manifests by model; return sorted leaderboard rows."""
    groups: dict[str, list[dict]] = {}
    for d in run_dirs:
        meta = _load(d)
        if meta is None:
            continue
        groups.setdefault(_model_key(meta), []).append(meta)

    rows: list[dict] = []
    for model, metas in groups.items():
        n = len(metas)
        surv = esc = heur = tom = memes = myths = cost = 0.0
        tom_n = 0
        tainted = 0
        for m in metas:
            agents_total = max(1, len(m.get("agents", [])))
            surv += len(m.get("survivors", [])) / agents_total
            esc += 1.0 if m.get("escaped") else 0.0
            heur += m.get("provenance", {}).get("heuristic_share", 0.0)
            tainted += 1 if m.get("tainted") else 0
            t = m.get("tom", {})
            if t:
                tom += t.get("mean", 0.0)
                tom_n += 1
            c = m.get("culture", {})
            memes += c.get("memes", {}).get("count", 0)
            myths += c.get("stories", {}).get("myths", 0)
            cost += m.get("llm_usage", {}).get("cost_usd", 0.0)
        rows.append({
            "model": model, "runs": n,
            "survival": surv / n, "escape": esc / n,
            "heuristic_share": heur / n, "tainted": tainted,
            "tom": (tom / tom_n) if tom_n else None,
            "memes": memes / n, "myths": myths / n,
            "cost_usd": cost,
        })
    # Rank: survival first, then ToM, then cultural output; stub sinks last.
    rows.sort(key=lambda r: (r["model"] == "stub", -r["survival"],
                             -(r["tom"] or 0), -r["memes"]))
    return rows


def print_table(rows: list[dict]) -> None:
    if not rows:
        print("No runs found (need meta.json in each dir).")
        return
    hdr = f"{'model':<36} {'runs':<5} {'surv%':<6} {'esc%':<5} {'heur%':<6} {'ToM':<5} {'memes':<6} {'myths':<6} {'cost$':<7}"
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        tom = f"{r['tom']:.2f}" if r["tom"] is not None else "-"
        taint = "⚠" if r["tainted"] else ""
        print(f"{r['model'][:36]:<36} {r['runs']:<5} "
              f"{r['survival']*100:>4.0f}%  {r['escape']*100:>3.0f}%  "
              f"{r['heuristic_share']*100:>4.0f}%{taint} {tom:<5} "
              f"{r['memes']:>5.1f} {r['myths']:>6.1f} {r['cost_usd']:>6.2f}")


def _expand(patterns: list[str]) -> list[Path]:
    out: list[Path] = []
    for p in patterns:
        matches = glob(p) or glob(str(ROOT / p))
        out.extend(Path(m) for m in matches)
    return out


def _from_batch(summary_path: Path) -> list[Path]:
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    base = ROOT / "logs" / "runs"
    return [base / r["run_id"] for r in summary.get("results", []) if r.get("run_id")]


def main() -> None:
    ap = argparse.ArgumentParser(description="Model leaderboard over run manifests.")
    ap.add_argument("runs", nargs="*", help="Run directories (globs ok).")
    ap.add_argument("--batch", help="Batch summary.json to expand.")
    args = ap.parse_args()
    dirs: list[Path] = []
    if args.batch:
        path = Path(args.batch)
        if not path.is_absolute():
            path = ROOT / path
        dirs += _from_batch(path)
    dirs += _expand(args.runs)
    if not dirs:
        ap.print_help()
        return
    print_table(aggregate(dirs))


if __name__ == "__main__":
    sys.exit(main())
