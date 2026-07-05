"""Batch experiment runner — turn a hypothesis into data.

An experiment is a YAML file describing a matrix of config overrides. The runner
takes the cross-product, runs one simulation per cell (writing a full
logs/runs/<id>/ directory each), and aggregates the run manifests into a single
summary so you can compare cells across seeds.

    py -3.12 -m engine.batch experiments/blank_vs_library.yaml

Experiment format:

    name: blank-vs-library
    scenario: island            # optional base scenario
    matrix:                     # every key is a dotted path into config/world.yaml
      seed: [1, 2, 3, 4, 5]
      agents.persona_mode: [blank, library]
      sim.emergency_multiplier: [2.0, 1.2]

Each combination becomes one run. Five seeds x two persona modes x two
multipliers = 20 runs. The summary lists, per cell, survival/escape outcomes and
the decision-provenance (heuristic share + tainted flag) so stub/heuristic
contamination is visible at a glance.
"""
from __future__ import annotations
import argparse
import itertools
import json
import sys
from datetime import datetime
from pathlib import Path

import yaml

from engine.event_log import RUNS_DIR
from engine.orchestrator import load_config, run_config

ROOT = Path(__file__).resolve().parent.parent


def _deep_set(d: dict, dotted: str, value) -> None:
    """Set cfg['a']['b'] = value from the path 'a.b', creating dicts as needed."""
    keys = dotted.split(".")
    node = d
    for k in keys[:-1]:
        node = node.setdefault(k, {})
    node[keys[-1]] = value


def _cell_cfg(base_cfg: dict, cell: dict) -> tuple[dict, dict]:
    """Clone the base config, apply one matrix cell's dotted overrides, and load
    the matching scenario (re-read in case the cell changed `scenario`)."""
    cfg = json.loads(json.dumps(base_cfg))   # deep copy via round-trip (yaml-safe)
    for dotted, value in cell.items():
        _deep_set(cfg, dotted, value)
    scenario = yaml.safe_load(
        (ROOT / "scenarios" / f"{cfg['scenario']}.yaml").read_text(encoding="utf-8"))
    return cfg, scenario


def run_experiment(exp_path: Path) -> Path:
    exp = yaml.safe_load(exp_path.read_text(encoding="utf-8"))
    name = exp.get("name", exp_path.stem)
    matrix: dict = exp.get("matrix", {})

    # Base config: the master yaml, plus any experiment-level scenario override.
    base_overrides = {}
    if exp.get("scenario"):
        base_overrides["scenario"] = exp["scenario"]
    base_cfg, _ = load_config(base_overrides)

    keys = list(matrix.keys())
    value_lists = [matrix[k] if isinstance(matrix[k], list) else [matrix[k]] for k in keys]
    cells = [dict(zip(keys, combo)) for combo in itertools.product(*value_lists)]

    print(f"[batch] experiment '{name}': {len(cells)} runs "
          f"({' x '.join(f'{k}={len(v)}' for k, v in zip(keys, value_lists))})")

    results = []
    for i, cell in enumerate(cells, 1):
        cfg, scenario = _cell_cfg(base_cfg, cell)
        print(f"[batch] {i}/{len(cells)} {cell}")
        try:
            recorder = run_config(cfg, scenario, quiet=True)
        except Exception as exc:
            print(f"[batch]   FAILED: {exc!r}")
            results.append({"cell": cell, "error": repr(exc)})
            continue
        meta = getattr(recorder, "meta", {}) if recorder else {}
        results.append({
            "cell": cell,
            "run_id": meta.get("run_id"),
            "mode": meta.get("mode"),
            "escaped": meta.get("escaped"),
            "survivors": len(meta.get("survivors", [])),
            "dead": len(meta.get("dead", [])),
            "last_tick": meta.get("last_tick"),
            "heuristic_share": meta.get("provenance", {}).get("heuristic_share"),
            "tainted": meta.get("tainted"),
        })

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = RUNS_DIR / f"_batch_{name}_{ts}"
    out_dir.mkdir(parents=True, exist_ok=True)
    summary = {"experiment": name, "started": ts, "runs": len(cells), "results": results}
    (out_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n[batch] done -> {out_dir / 'summary.json'}")
    _print_table(results)
    return out_dir / "summary.json"


def _print_table(results: list[dict]) -> None:
    if not results:
        return
    print(f"\n  {'cell':<48} {'esc':<4} {'surv':<5} {'heur%':<6} tainted")
    print("  " + "-" * 78)
    for r in results:
        if "error" in r:
            print(f"  {str(r['cell'])[:46]:<48} ERROR")
            continue
        cell = ", ".join(f"{k}={v}" for k, v in r["cell"].items())
        hs = r.get("heuristic_share")
        hs_s = f"{hs*100:.0f}%" if hs is not None else "-"
        print(f"  {cell[:46]:<48} {str(r['escaped'])[:4]:<4} "
              f"{r['survivors']:<5} {hs_s:<6} {'⚠' if r.get('tainted') else ''}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Run a batch experiment matrix.")
    ap.add_argument("experiment", help="Path to an experiment YAML file.")
    args = ap.parse_args()
    path = Path(args.experiment)
    if not path.is_absolute():
        path = ROOT / path
    run_experiment(path)


if __name__ == "__main__":
    sys.exit(main())
