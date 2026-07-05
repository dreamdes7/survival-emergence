"""Compare simulation runs from their logs/runs/<id>/ directories.

Reads the metrics.jsonl + meta.json of one or more runs (or a batch summary) and
prints a side-by-side table of final AWI indicators, outcome, and decision
provenance. This is the minimum viable "did the hypothesis hold" tool — point it
at run dirs and read the columns.

    py -3.12 -m analysis.compare logs/runs/island_*_seed1 logs/runs/island_*_seed2
    py -3.12 -m analysis.compare --batch logs/runs/_batch_blank-vs-library_*/summary.json

For deeper work (per-tick curves, relationship-graph timelines) load metrics.jsonl
directly — each line is {t, day, alive, metrics, relationships, sources}.
"""
from __future__ import annotations
import argparse
import json
import sys
from glob import glob
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# The indicators worth eyeballing across runs (subset of the AWI set).
KEY_INDICATORS = [
    "population_survival_rate", "social_graph_density", "safety",
    "map_exploration_coverage", "tool_usage_diversity", "escape_progress",
]


def _load_run(run_dir: Path) -> dict | None:
    meta_p = run_dir / "meta.json"
    metrics_p = run_dir / "metrics.jsonl"
    if not meta_p.exists():
        return None
    meta = json.loads(meta_p.read_text(encoding="utf-8"))
    last_metrics = {}
    if metrics_p.exists():
        lines = [ln for ln in metrics_p.read_text(encoding="utf-8").splitlines() if ln.strip()]
        if lines:
            last_metrics = json.loads(lines[-1]).get("metrics", {}).get("indicators", {})
    return {"run_id": meta.get("run_id", run_dir.name), "meta": meta, "final": last_metrics}


def _fmt(v) -> str:
    return f"{v:.2f}" if isinstance(v, (int, float)) else "-"


def compare(run_dirs: list[Path]) -> None:
    runs = [r for r in (_load_run(d) for d in run_dirs) if r]
    if not runs:
        print("No runs found (need meta.json in each dir).")
        return

    cols = ["run", "mode", "esc", "surv", "heur%"] + [k[:10] for k in KEY_INDICATORS]
    widths = [26, 8, 4, 5, 6] + [11] * len(KEY_INDICATORS)
    header = "  ".join(c.ljust(w) for c, w in zip(cols, widths))
    print(header)
    print("-" * len(header))
    for r in runs:
        meta, final = r["meta"], r["final"]
        prov = meta.get("provenance", {})
        hs = prov.get("heuristic_share")
        row = [
            r["run_id"][:26],
            str(meta.get("mode", "?"))[:8],
            str(meta.get("escaped", "?"))[:4],
            str(len(meta.get("survivors", []))),
            (f"{hs*100:.0f}{'⚠' if meta.get('tainted') else ''}" if hs is not None else "-"),
        ] + [_fmt(final.get(k)) for k in KEY_INDICATORS]
        print("  ".join(str(c).ljust(w) for c, w in zip(row, widths)))


def compare_batch(summary_path: Path) -> None:
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    run_dirs = []
    base = (ROOT / "logs" / "runs")
    for res in summary.get("results", []):
        rid = res.get("run_id")
        if rid:
            run_dirs.append(base / rid)
    print(f"Batch '{summary.get('experiment')}' — {len(run_dirs)} runs\n")
    compare(run_dirs)


def _expand(patterns: list[str]) -> list[Path]:
    out: list[Path] = []
    for p in patterns:
        matches = glob(p) or glob(str(ROOT / p))
        out.extend(Path(m) for m in matches)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Compare simulation runs.")
    ap.add_argument("runs", nargs="*", help="Run directories (globs ok).")
    ap.add_argument("--batch", help="A batch summary.json to expand + compare.")
    args = ap.parse_args()
    if args.batch:
        path = Path(args.batch)
        if not path.is_absolute():
            path = ROOT / path
        compare_batch(path)
    elif args.runs:
        compare(_expand(args.runs))
    else:
        ap.print_help()


if __name__ == "__main__":
    sys.exit(main())
