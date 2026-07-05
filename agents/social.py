"""Relationship state — explicit social labels + affinity history per agent pair."""
from __future__ import annotations
from dataclasses import dataclass


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


@dataclass
class Relationship:
    label: str = "stranger"      # stranger | acquaintance | ally | rival
    affinity: float = 0.0        # -1 .. 1
    interactions: int = 0
    bond: str | None = None      # None | friend | best_friend | romantic | sworn_enemy


class RelationshipBook:
    def __init__(self) -> None:
        self.rel: dict[str, Relationship] = {}

    def get(self, other_id: str) -> Relationship:
        return self.rel.setdefault(other_id, Relationship())

    def record(self, other_id: str, delta: float) -> Relationship:
        r = self.get(other_id)
        r.affinity = _clamp(r.affinity + delta, -1.0, 1.0)
        r.interactions += 1
        r.label = self._label_for(r)
        # friends who grow very close become best friends
        if r.bond == "friend" and r.affinity >= 0.80 and r.interactions >= 12:
            r.bond = "best_friend"
        return r

    @staticmethod
    def _label_for(r: Relationship) -> str:
        if r.interactions == 0:
            return "stranger"
        if r.affinity >= 0.4:
            return "ally"
        if r.affinity <= -0.4:
            return "rival"
        return "acquaintance"

    def best_ally(self, min_aff: float = 0.4) -> tuple[str | None, "Relationship | None"]:
        best_id, best_rel = None, None
        for other_id, r in self.rel.items():
            if r.affinity >= min_aff:
                if best_rel is None or r.affinity > best_rel.affinity:
                    best_id, best_rel = other_id, r
        return (best_id, best_rel)

    def is_rival(self, other_id: str) -> bool:
        r = self.rel.get(other_id)
        return r is not None and r.label == "rival"
