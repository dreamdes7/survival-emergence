"""Pure data structures shared across the engine. No engine/agent dependencies."""
from __future__ import annotations
from dataclasses import dataclass, field

# ── Item categories (used by survival tools + the decision heuristics) ─────────
# human_flesh is food that FEEDS and DAMNS — produced only by butchering the dead
# under true starvation (tools/survival.butcher_corpse); eating it costs the soul.
FOOD_ITEMS  = {"food", "food_ration", "food_plant", "fish", "coconut", "berries", "fruit", "dried_food", "human_flesh"}
WATER_ITEMS = {"water"}
WOOD_ITEMS  = {"wood"}
# Raw food spoils in a pack over days; preserved food (from a smokehouse) keeps —
# this is what makes storage/preservation structures worth building.
PRESERVED_FOOD = {"dried_food"}
PERISHABLE_FOOD = FOOD_ITEMS - PRESERVED_FOOD

# ── psychosocial drives (the "why build a society" layer) ──────────────────────
# Above survival sit needs that ONLY a society satisfies. They decay each tick and
# are refilled only by acts of connection / contribution / meaning — so once
# survival is met, the binding constraint becomes social, and building a camp,
# helping, leading and making culture become the way to feel whole. Each landed
# action nudges the matching drive. (belonging | esteem | purpose)
PSYCHE_ACT: dict[str, tuple[str, float]] = {
    # belonging — closeness, being part of something
    "say_to": ("belonging", 5), "accept_bond": ("belonging", 22),
    "propose_friendship": ("belonging", 10), "confess_feelings": ("belonging", 14),
    "hug": ("belonging", 12), "comfort": ("belonging", 10), "compliment": ("belonging", 8),
    "follow": ("belonging", 5),
    # esteem — being useful, capable, relied upon
    "build_structure": ("esteem", 12), "build": ("esteem", 10), "maintain": ("esteem", 6),
    "give": ("esteem", 9), "share_location": ("esteem", 6), "warn": ("esteem", 6),
    "craft": ("esteem", 11), "cook": ("esteem", 8), "plant": ("esteem", 8),
    "harvest_crop": ("esteem", 8), "repair": ("esteem", 12), "stash": ("esteem", 4),
    "gather": ("esteem", 2),
    # purpose — meaning, legacy, a mark left on the world / the group
    "name_place": ("purpose", 16), "tell_story": ("purpose", 12), "post": ("purpose", 8),
    "propose_rule": ("purpose", 14), "vote": ("purpose", 8), "assign_role": ("purpose", 10),
    "announce": ("purpose", 4), "investigate": ("purpose", 8), "examine": ("purpose", 6),
    "write_diary": ("purpose", 3),
}

# Maps a physiology stat -> (restore tool name, set of items that satisfy it).
# items=None means the restore action needs no inventory item (rest, refill).
STAT_RESTORE: dict[str, tuple[str, set | None]] = {
    "hunger": ("eat", FOOD_ITEMS),
    "thirst": ("drink", WATER_ITEMS),
    "energy": ("rest", None),
    "warmth": ("rest", None),
    "oxygen": ("refill_oxygen", None),
}


def chebyshev(ax: int, ay: int, bx: int, by: int) -> int:
    """King-move distance — 'adjacent' means result <= 1."""
    return max(abs(ax - bx), abs(ay - by))


# Footprint of each structure kind in TILES (w, h) — kept SQUARE so sprites never
# stretch; size scales with how big the thing reads in the world.
STRUCTURE_SIZE: dict[str, tuple[int, int]] = {
    # mars
    "shuttle_wreckage": (5, 5),
    "habitat_dome": (4, 4),
    "greenhouse": (3, 3),
    "oxygen_generator": (2, 2),
    "solar_panel": (2, 2),
    "signal_beacon": (2, 2),
    "storage_crate": (2, 2),
    "rover": (3, 3),
    # island
    "plane_wreckage": (5, 5),
    "lean_to": (3, 3),
    "signal_fire": (3, 3),
    "raft": (3, 3),
    "fishing_spot": (1, 1),
    "supply_pile": (2, 2),
    # future / event structures
    "distress_pod": (2, 2),
    "anomaly": (3, 3),
    "hazard_zone": (3, 3),
    "sealed_bunker": (3, 3),
    # agent-built
    "campfire": (1, 1),
    "tent": (2, 2),
    "water_still": (2, 2),
    "store": (3, 3),
    # island — new functional structures
    "workbench": (2, 2),
    "smokehouse": (2, 2),
    "garden": (3, 3),
    "well": (2, 2),
    "signpost": (1, 1),
    "watchtower": (3, 3),
    # island — natural landmarks
    "hotspring": (2, 2),
    "cave": (3, 3),
    "lighthouse": (4, 4),
    "radiotower": (4, 4),
    # island — anomalies
    "monolith": (2, 2),
    "idol": (2, 2),
    "hatch": (2, 2),
    "whisperzone": (4, 4),
    "relic": (1, 1),
}


def structure_size(kind: str) -> tuple[int, int]:
    return STRUCTURE_SIZE.get(kind, (1, 1))


@dataclass
class ResourceNode:
    id: str
    kind: str
    x: int
    y: int
    quantity: float
    max_quantity: float
    regen: float = 0.0
    yield_item: str = ""
    blocking: bool = True      # occupies its tile (can't walk through / build on)
    consumable: bool = False   # vanishes when fully harvested (a chopped tree / mined rock)

    def __post_init__(self) -> None:
        if not self.yield_item:
            self.yield_item = self.kind

    def harvest(self, amount: float = 5.0) -> float:
        taken = min(self.quantity, amount)
        self.quantity -= taken
        return taken

    def tick_regen(self) -> None:
        if self.regen:
            self.quantity = min(self.max_quantity, self.quantity + self.regen)


@dataclass
class Structure:
    id: str
    kind: str
    x: int
    y: int
    role: str = ""                       # refill_oxygen | escape | shelter | salvage
    state: dict = field(default_factory=dict)
