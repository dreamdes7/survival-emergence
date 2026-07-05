"""The stub path must be bit-for-bit reproducible from a seed — this is the
property that lets a run be a controlled experiment. Guards against accidental
nondeterminism (unseeded random, dict-order leaks, time in state)."""
from __future__ import annotations
import hashlib
import json

from engine.serialize import world_snapshot
from conftest import build_sim, run_ticks


def _hash(world) -> str:
    snap = world_snapshot(world)
    snap.pop("provenance", None)   # depends on recorder attachment, not world state
    blob = json.dumps(snap, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def test_same_seed_same_world():
    w1, l1, _ = build_sim({"seed": 42})
    w2, l2, _ = build_sim({"seed": 42})
    run_ticks(w1, l1, 24)
    run_ticks(w2, l2, 24)
    assert _hash(w1) == _hash(w2), "stub run diverged under identical seed"


def test_different_seed_different_world():
    w1, l1, _ = build_sim({"seed": 1})
    w2, l2, _ = build_sim({"seed": 2})
    run_ticks(w1, l1, 24)
    run_ticks(w2, l2, 24)
    assert _hash(w1) != _hash(w2), "different seeds produced identical worlds"
