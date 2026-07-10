"""The world: tile grid, resource nodes, structures, agents, and per-tick physics
(physiology decay, day/night, weather, resource regen, death, escape)."""
from __future__ import annotations
import math
import random
from collections import deque

from .models import ResourceNode, Structure, chebyshev, structure_size
from tools.base import ToolRegistry
from tools.core import build_core_tools
from tools.survival import build_survival_tools
from tools.social import build_social_tools
from tools.governance import build_governance_tools
from tools.sites import build_site_tools
from tools.build import build_tools
from tools.settlement import build_settlement_tools
from tools.anomaly import build_anomaly_tools
from engine.anomaly import anomaly_tick
from tools.culture import build_culture_tools
from tools.bonds import build_bond_tools


class World:
    def __init__(self, scenario: dict, seed: int, day_length_ticks: int) -> None:
        self.scenario = scenario
        self.rng = random.Random(seed)
        self.size = int(scenario["map"]["size"])
        self.day_length_ticks = day_length_ticks

        self.tick = 0
        self.day = 1
        self.is_night = False
        self.weather: str | None = None
        self.weather_ticks_left = 0

        self.escaped = False
        self.escape_winner = None
        self.escape_progress = 0.0
        self.tool_usage: dict[str, int] = {}
        self.barter_count = 0
        self.feed: list[dict] = []        # recent thoughts/speech/actions for the UI
        self.chronicle: list[dict] = []   # significant emergent events (the saga)
        self.events: list[dict] = []      # typed event stream (bounded; mirrored to recorder)
        self.recorder = None              # RunRecorder, when a run is being logged
        self.saga: list[dict] = []        # narrator's literary retelling of the run
        # Culture as data: memes (transmission-proven phrases), story chains
        # with measurable drift, and the optional currency experiment.
        from engine.culture import CultureTracker
        self.culture = CultureTracker(currency_item=scenario.get("currency_item"))
        self.tom_scores: dict[str, list[float]] = {}   # theory-of-mind probe accuracy

        # Sprint 2 — commitments, culture, ritual
        self.commitments: list[dict] = []   # promises between agents
        self.placenames: list[dict] = []    # agent-coined names for places
        self.gatherings = 0                 # times a fireside gathering happened
        self.fireside_tradition = False     # has nightly gathering become tradition?
        self.feasts = 0                     # communal feasts hosted (host_feast)
        self.feast_tradition = False        # has feasting become a recurring ritual?
        self.move_speed = 1               # tiles an agent crosses per go_to (set by config)
        self.last_death_notices: list[str] = []
        self.last_death_reasons: dict[str, list[str]] = {}

        # governance (self-rule) state
        self.proposals: list[dict] = []
        self.rules: list[str] = []
        self.roles: dict[str, str] = {}
        self.gov_participants: set[str] = set()
        self.claims: dict[str, dict] = {}   # node_id → {owner_id, owner, tick}
        self.expel_votes: dict[str, set] = {}   # target_id → set of voter ids calling to expel
        self.territories: list[dict] = []       # area claims: {owner_id, owner, x, y, r, tick, group}

        self.camp_radius = max(2, self.size // 8)

        self.grid = self._generate_terrain()
        self._index_terrain()                       # _water / _land / _beach / _coast
        # Crash camp sits on land near the middle; agents spawn here and know it.
        self.camp_center = self._pick_camp_center()
        self.nodes: list[ResourceNode] = self._place_resources()
        self.structures: list[Structure] = self._place_structures()
        self._add_hazard_rewards()
        self.agents: list = []
        self.anomaly = None          # set by engine.anomaly.place_anomaly when enabled

        self.tools = ToolRegistry()
        self.tools.register_all(build_core_tools())
        self.tools.register_all(build_survival_tools())
        self.tools.register_all(build_social_tools())
        self.tools.register_all(build_governance_tools())
        self.tools.register_all(build_site_tools())
        self.tools.register_all(build_tools(self))
        self.tools.register_all(build_settlement_tools(self))
        self.tools.register_all(build_anomaly_tools(self))
        self.tools.register_all(build_culture_tools())
        self.tools.register_all(build_bond_tools())

    # ── generation ────────────────────────────────────────────────────────────
    def _value_noise(self, n: int, grid_points: int) -> list[list[float]]:
        """Smooth value-noise field in [0,1] via bilinear + smoothstep upscaling
        of a low-res random lattice."""
        g = max(2, grid_points)
        lat = [[self.rng.random() for _ in range(g + 1)] for _ in range(g + 1)]
        field = [[0.0] * n for _ in range(n)]
        for y in range(n):
            fy = y / n * g
            iy = int(fy)
            ty = fy - iy
            sy = ty * ty * (3 - 2 * ty)
            for x in range(n):
                fx = x / n * g
                ix = int(fx)
                tx = fx - ix
                sx = tx * tx * (3 - 2 * tx)
                a, b = lat[iy][ix], lat[iy][ix + 1]
                c, d = lat[iy + 1][ix], lat[iy + 1][ix + 1]
                top = a + (b - a) * sx
                bot = c + (d - c) * sx
                field[y][x] = top + (bot - top) * sy
        return field

    def _generate_terrain(self) -> list[list[str]]:
        if self.scenario["map"].get("shape") == "island":
            return self._generate_island()
        return self._generate_noise_bands()

    def _generate_noise_bands(self) -> list[list[str]]:
        """Organic open terrain (Mars): two octaves of value noise mapped to bands,
        each terrain a contiguous region sized by its configured weight."""
        palette = self.scenario["map"]["terrains"]
        kinds = list(palette.keys())
        weights = list(palette.values())
        n = self.size

        f1 = self._value_noise(n, max(3, n // 10))
        f2 = self._value_noise(n, max(6, n // 4))
        field = [[0.65 * f1[y][x] + 0.35 * f2[y][x] for x in range(n)] for y in range(n)]

        flat = [v for row in field for v in row]
        lo, hi = min(flat), max(flat)
        span = (hi - lo) or 1.0

        total = sum(weights) or 1.0
        bands: list[tuple[float, str]] = []
        acc = 0.0
        for k, w in zip(kinds, weights):
            acc += w / total
            bands.append((acc, k))

        grid: list[list[str]] = []
        for y in range(n):
            row = []
            for x in range(n):
                v = (field[y][x] - lo) / span
                terrain = kinds[-1]
                for thr, k in bands:
                    if v <= thr:
                        terrain = k
                        break
                row.append(terrain)
            grid.append(row)
        return grid

    def _generate_island(self) -> list[list[str]]:
        """A real island with a CLEAN coastline. Build a land mask via radial
        falloff + noise, smooth away specks, then assign a 1-tile sand beach ring,
        jungle interior and rocky core."""
        n = self.size
        c = (n - 1) / 2
        maxd = math.hypot(c, c) or 1.0
        f1 = self._value_noise(n, max(3, n // 9))    # big lobes (bays/peninsulas)
        f2 = self._value_noise(n, max(6, n // 4))    # finer coast detail
        f3 = self._value_noise(n, max(2, n // 14))   # low-freq shape warp
        f4 = self._value_noise(n, max(8, n // 2))    # high-freq ragged shoreline
        moist = self._value_noise(n, max(3, n // 7)) # moisture -> jungle vs meadow
        cfg = self.scenario.get("map", {})
        north_bias = float(cfg.get("north_bias", 0.0))   # >0: land reaches the top edge

        # 1) land mask + elevation — radial falloff warped by noise (irregular coast)
        land = [[False] * n for _ in range(n)]
        elev = [[0.0] * n for _ in range(n)]
        for y in range(n):
            for x in range(n):
                d = math.hypot(x - c, y - c) / maxd
                d *= 1.0 + (f3[y][x] - 0.5) * 0.8         # warp distance -> bays/capes
                base = 0.64 * f1[y][x] + 0.24 * f2[y][x] + 0.12 * f4[y][x]
                h = base + 0.40 - (d * d) * 1.18
                if north_bias:
                    h += (1.0 - y / (n - 1)) * north_bias  # merge island into the top edge
                elev[y][x] = h
                land[y][x] = h > 0.50

        # 2) smooth the coastline — remove isolated specks / fill pinholes
        for _ in range(3):
            nl = [row[:] for row in land]
            for y in range(n):
                for x in range(n):
                    cnt = tot = 0
                    for dy in (-1, 0, 1):
                        for dx in (-1, 0, 1):
                            if dy == 0 and dx == 0:
                                continue
                            ny, nx = y + dy, x + dx
                            if 0 <= ny < n and 0 <= nx < n:
                                tot += 1
                                cnt += 1 if land[ny][nx] else 0
                    if cnt >= tot * 0.5 + 1:
                        nl[y][x] = True
                    elif cnt <= tot * 0.5 - 1:
                        nl[y][x] = False
            land = nl

        def is_water(x: int, y: int) -> bool:
            return not (0 <= x < n and 0 <= y < n and land[y][x])

        def near_water(x: int, y: int, reach: int) -> bool:
            for dy in range(-reach, reach + 1):
                for dx in range(-reach, reach + 1):
                    if is_water(x + dx, y + dy):
                        return True
            return False

        # 2b) coast distance (BFS from every water tile) — drives where beaches,
        #     cliffs, forests and meadows sit, the way they do on a real island.
        INF = 10 ** 9
        cdist = [[INF] * n for _ in range(n)]
        dq: deque[tuple[int, int]] = deque()
        for y in range(n):
            for x in range(n):
                if not land[y][x]:
                    cdist[y][x] = 0
                    dq.append((x, y))
        while dq:
            x, y = dq.popleft()
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < n and 0 <= ny < n and cdist[ny][nx] > cdist[y][x] + 1:
                    cdist[ny][nx] = cdist[y][x] + 1
                    dq.append((nx, ny))
        self._coast_dist = cdist

        # 3) biomes from elevation + moisture + coast distance:
        #    • shore: low sheltered coves become SAND beaches; high/exposed capes
        #      (big-lobe noise) become rocky CLIFF shore — beaches aren't a ring.
        #    • interior: tall ground is rocky HIGHLAND; wet mid/low ground grows
        #      dense FOREST; the rest is open MEADOW. Moisture rises near the coast
        #      and falls with height, so forests band the wet lowlands like reality.
        grid: list[list[str]] = []
        for y in range(n):
            row = []
            for x in range(n):
                if not land[y][x]:
                    row.append("island_water_shore")
                    continue
                t = elev[y][x] - 0.50                       # height above sea level
                cd = cdist[y][x]                            # 1 = touching water
                # moisture, wetter by the sea & in the lowlands, drier up high
                m = moist[y][x] + max(0.0, (4 - cd)) * 0.05 - t * 0.45
                if cd <= 2:                                 # the shoreline
                    if t > 0.42 or f1[y][x] > 0.60:
                        row.append("island_rock")           # steep / exposed cape -> cliff
                    else:
                        row.append("island_sand")           # low cove -> beach
                elif t > 0.58:
                    row.append("island_rock")               # interior peaks
                elif m > 0.50 and t < 0.52:
                    row.append("island_foliage_dense")      # wet lowland -> forest
                else:
                    row.append("island_jungle_grass")       # meadow
            grid.append(row)
        return grid

    # ── terrain indexing & terrain-aware placement ─────────────────────────────
    def _index_terrain(self) -> None:
        self._water: list[tuple[int, int]] = []
        self._land: list[tuple[int, int]] = []
        self._beach: list[tuple[int, int]] = []
        self._grass: list[tuple[int, int]] = []      # meadow (jungle_grass)
        self._jungle: list[tuple[int, int]] = []     # dense jungle (foliage)
        self._highland: list[tuple[int, int]] = []   # rocky highland
        for y in range(self.size):
            for x in range(self.size):
                t = self.grid[y][x]
                if "water" in t:
                    self._water.append((x, y))
                    continue
                self._land.append((x, y))
                if "sand" in t:
                    self._beach.append((x, y))
                elif "foliage" in t:
                    self._jungle.append((x, y))
                elif "rock" in t:
                    self._highland.append((x, y))
                else:
                    self._grass.append((x, y))
        waterset = set(self._water)
        self._coast = [(x, y) for (x, y) in self._land
                       if any((x + dx, y + dy) in waterset
                              for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))]

    def _pick_camp_center(self) -> tuple[int, int]:
        gc = self.size // 2
        inner = [p for p in self._land if chebyshev(gc, gc, p[0], p[1]) <= self.size // 4]
        if inner:
            return self.rng.choice(inner)
        return self.rng.choice(self._land) if self._land else (gc, gc)

    def _tile_pool(self, pref: str) -> list[tuple[int, int]]:
        if pref == "water":
            return self._water or self._land
        if pref == "beach":
            return self._beach or self._coast or self._land
        if pref == "coast":
            return self._coast or self._beach or self._land
        if pref == "grass":                          # meadow
            return self._grass or self._land
        if pref == "jungle":                         # dense forest interior
            return self._jungle or self._grass or self._land
        if pref == "highland":                       # rocky core
            return self._highland or self._grass or self._land
        if pref == "any":
            return self._land + self._water
        return self._land or [self.camp_center]      # default: land

    def blocked(self, x: int, y: int) -> bool:
        """A tile is impassable if it's water or holds a standing blocking node
        (tree / rock / thicket). Agents route around these and can't build on them."""
        if not (0 <= x < self.size and 0 <= y < self.size):
            return True
        if "water" in self.grid[y][x]:
            return True
        for n in self.nodes:
            if n.blocking and n.quantity > 0 and n.x == x and n.y == y:
                return True
        return False

    def structure_rect_for(self, kind: str, x: int, y: int) -> tuple[int, int, int, int]:
        """Rendered tile footprint for a structure anchored at (x, y)."""
        w, h = structure_size(kind)
        x0 = x - (w - 1) // 2
        y0 = y - (h - 1)
        return x0, y0, x0 + w - 1, y0 + h - 1

    def structure_rect(self, structure: Structure) -> tuple[int, int, int, int]:
        return self.structure_rect_for(structure.kind, structure.x, structure.y)

    @staticmethod
    def _rects_overlap(a: tuple[int, int, int, int],
                       b: tuple[int, int, int, int]) -> bool:
        ax0, ay0, ax1, ay1 = a
        bx0, by0, bx1, by1 = b
        return ax0 <= bx1 and ax1 >= bx0 and ay0 <= by1 and ay1 >= by0

    def structure_contains(self, structure: Structure, x: int, y: int) -> bool:
        x0, y0, x1, y1 = self.structure_rect(structure)
        return x0 <= x <= x1 and y0 <= y <= y1

    def structure_distance(self, x: int, y: int, structure: Structure) -> int:
        """Chebyshev distance from a tile to a structure footprint; 0 if inside."""
        x0, y0, x1, y1 = self.structure_rect(structure)
        dx = 0 if x0 <= x <= x1 else min(abs(x - x0), abs(x - x1))
        dy = 0 if y0 <= y <= y1 else min(abs(y - y0), abs(y - y1))
        return max(dx, dy)

    def adjacent_to_structure(self, agent, structure: Structure, reach: int = 1) -> bool:
        return self.structure_distance(agent.x, agent.y, structure) <= reach

    def structure_footprint_clear(self, kind: str, x: int, y: int,
                                  ignore: Structure | None = None) -> bool:
        x0, y0, x1, y1 = self.structure_rect_for(kind, x, y)
        for tx in range(x0, x1 + 1):
            for ty in range(y0, y1 + 1):
                if self.blocked(tx, ty):
                    return False
        new_rect = (x0, y0, x1, y1)
        for other in getattr(self, "structures", []):
            if other is ignore:
                continue
            if self._rects_overlap(new_rect, self.structure_rect(other)):
                return False
        return True

    def find_clear_structure_site(self, kind: str, near_x: int, near_y: int,
                                  radius: int = 4) -> tuple[int, int] | None:
        for dist in range(radius + 1):
            candidates: list[tuple[int, int]] = []
            for y in range(near_y - dist, near_y + dist + 1):
                for x in range(near_x - dist, near_x + dist + 1):
                    if chebyshev(near_x, near_y, x, y) == dist:
                        candidates.append((x, y))
            candidates.sort(key=lambda p: (abs(p[1] - near_y), abs(p[0] - near_x), p[1], p[0]))
            for x, y in candidates:
                if self.structure_footprint_clear(kind, x, y):
                    return x, y
        return None

    def structure_at(self, x: int, y: int):
        for s in self.structures:
            if self.structure_contains(s, x, y):
                return s
        return None

    def agent_spawn_tile(self) -> tuple[int, int]:
        cx, cy = self.camp_center
        near = [p for p in self._land
                if chebyshev(cx, cy, p[0], p[1]) <= self.camp_radius + 3
                and not self.blocked(p[0], p[1])]
        if near:
            return self.rng.choice(near)
        free = [p for p in self._land if not self.blocked(p[0], p[1])]
        return self.rng.choice(free) if free else self.camp_center

    def _rand_pos(self) -> tuple[int, int]:
        return self.rng.randrange(self.size), self.rng.randrange(self.size)

    def _rand_pos_near(self, cx: int, cy: int, radius: int) -> tuple[int, int]:
        x = max(0, min(self.size - 1, cx + self.rng.randint(-radius, radius)))
        y = max(0, min(self.size - 1, cy + self.rng.randint(-radius, radius)))
        return x, y

    def _rand_pos_far(self, cx: int, cy: int, min_dist: int) -> tuple[int, int]:
        for _ in range(40):
            x, y = self._rand_pos()
            if chebyshev(cx, cy, x, y) >= min_dist:
                return x, y
        return self._rand_pos()

    def _place_resources(self) -> list[ResourceNode]:
        nodes: list[ResourceNode] = []
        occupied: set[tuple[int, int]] = set()
        cx, cy = self.camp_center
        coast_dist = getattr(self, "_coast_dist", None)
        for spec in self.scenario.get("resources", []):
            pool = self._tile_pool(spec.get("terrain", "land"))
            min_coast = int(spec.get("min_coast_dist", 0))   # keep e.g. springs off the beach
            for i in range(int(spec.get("count", 1))):
                tile = None
                for _ in range(30):
                    p = self.rng.choice(pool) if pool else self._rand_pos()
                    if p in occupied or chebyshev(cx, cy, p[0], p[1]) <= 2:
                        continue   # one node per tile; keep a clearing round camp
                    if min_coast and coast_dist is not None and coast_dist[p[1]][p[0]] < min_coast:
                        continue   # too close to the shore for this resource
                    tile = p
                    break
                if tile is None:
                    continue
                occupied.add(tile)
                x, y = tile
                nodes.append(ResourceNode(
                    id=f"{spec['kind']}#{i}", kind=spec["kind"], x=x, y=y,
                    quantity=float(spec.get("quantity", 30)),
                    max_quantity=float(spec.get("quantity", 30)),
                    regen=float(spec.get("regen", 0.0)),
                    yield_item=spec.get("yield_item", ""),
                    blocking=bool(spec.get("blocking", True)),
                    consumable=bool(spec.get("consumable", False)),
                ))
        return nodes

    def _place_structures(self) -> list[Structure]:
        """place: camp (near centre) | far (mystery sites) | beach | coast.
        Everything lands on a sensible tile (never in open ocean unless asked)."""
        structs: list[Structure] = []
        cx, cy = self.camp_center
        used: set[tuple[int, int]] = set()
        for spec in self.scenario.get("structures", []):
            # back-compat: old `far: true` maps to place=far
            place = spec.get("place") or ("far" if spec.get("far") else "camp")
            for i in range(int(spec.get("count", 1))):
                if place == "far":
                    cand = [p for p in self._land
                            if chebyshev(cx, cy, p[0], p[1]) >= self.size // 3] or self._land
                elif place == "beach":
                    cand = self._tile_pool("beach")
                elif place == "coast":
                    cand = self._tile_pool("coast")
                elif place == "inland":     # away from the shore, anywhere on land
                    cand = [p for p in self._land
                            if self._coast_dist[p[1]][p[0]] >= 3] or self._land
                elif place == "highland":   # rocky core
                    cand = self._highland or self._land
                else:  # camp
                    cand = [p for p in self._land
                            if chebyshev(cx, cy, p[0], p[1]) <= self.camp_radius] or self._land
                cand = [p for p in cand if p not in used] or cand
                x, y = self.rng.choice(cand) if cand else (cx, cy)
                used.add((x, y))
                structs.append(Structure(
                    id=f"{spec['kind']}#{i}", kind=spec["kind"], x=x, y=y,
                    role=spec.get("role", ""),
                    state=self._initial_struct_state(spec),
                ))
        return structs

    @staticmethod
    def _initial_struct_state(spec: dict) -> dict:
        """Starting state for a pre-placed structure, by role."""
        role = spec.get("role", "")
        if role == "shelter":               # natural shelter (cave) — ready to use
            # comfort < 1 = damp cold stone: it keeps you alive through a storm,
            # but rests you poorly — a BUILT home is strictly nicer to live in.
            return {"complete": True, "capacity": int(spec.get("capacity", 3)),
                    "comfort": float(spec.get("comfort", 1.0))}
        if role in ("beacon", "signal"):    # abandoned tech — must be repaired first
            return {"active": False, "repair": 0.0,
                    "required": float(spec.get("repair_required", 60))}
        return {}

    def _add_hazard_rewards(self) -> None:
        """A rich resource node sits just outside each hazard zone — the lure."""
        for s in self.structures:
            if s.role != "hazard":
                continue
            x = max(0, min(self.size - 1, s.x + 2))
            y = s.y
            self.nodes.append(ResourceNode(
                id=f"rich_{s.id}", kind="ore_vein", yield_item="ore",
                x=x, y=y, quantity=120, max_quantity=120, regen=0.0,
            ))

    # ── spatial queries ───────────────────────────────────────────────────────
    def adjacent_nodes(self, agent) -> list[ResourceNode]:
        return [n for n in self.nodes
                if n.quantity > 0 and chebyshev(agent.x, agent.y, n.x, n.y) <= 1]

    def adjacent_structures(self, agent, role: str | None = None) -> list[Structure]:
        return [s for s in self.structures
                if (role is None or s.role == role)
                and self.adjacent_to_structure(agent, s)]

    def agent_by_name(self, name: str):
        for a in self.agents:
            if a.name == name:
                return a
        return None

    def agent_by_id(self, agent_id: str):
        for a in self.agents:
            if a.id == agent_id:
                return a
        return None

    def node_by_id(self, nid: str):
        for n in self.nodes:
            if n.id == nid:
                return n
        return None

    def node_at(self, x: int, y: int):
        """Return a live (quantity > 0) node at exactly (x, y), or None."""
        for n in self.nodes:
            if n.x == x and n.y == y and n.quantity > 0:
                return n
        return None

    # ── warmth: fire & shelter ──────────────────────────────────────────────────
    def near_fire(self, agent) -> bool:
        exiled = self.is_exiled(agent)
        for s in self.structures:
            if chebyshev(agent.x, agent.y, s.x, s.y) > 2:
                continue
            if s.role == "hotspring":                      # natural warmth judges no one
                return True
            # the communal fire turns its back on the exiled — they get no heat here
            if s.role == "campfire" and s.state.get("complete") and s.state.get("fuel", 0) > 0:
                if not exiled:
                    return True
        return False

    # ── governance: assigned-role edges & exile from the commons ────────────────
    def role_bonus(self, agent, domain: str) -> float:
        """Extra yield/rate an agent gets in `domain` from an ASSIGNED matching role."""
        from engine.skills import role_domain, ROLE_DOMAIN_BONUS
        if role_domain(self.roles.get(agent.id)) == domain:
            return ROLE_DOMAIN_BONUS.get(domain, 0.0)
        return 0.0

    def is_leader(self, agent) -> bool:
        from engine.skills import role_domain
        return role_domain(self.roles.get(agent.id)) == "leader"

    def is_exiled(self, agent) -> bool:
        return bool(getattr(agent, "exiled", False))

    def exile(self, agent) -> None:
        agent.exiled = True

    def readmit(self, agent) -> None:
        agent.exiled = False
        self.expel_votes.pop(agent.id, None)

    # ── fear signs: ambiguous night terror, never a named creature ──────────────
    # Hunger + darkness + loneliness produce SIGNS. The engine never says what
    # (if anything) made them — whether the survivors blame a beast, the hum, or
    # their own nerves is culture being born, and the culture tracker will see it.
    _FEAR_SIGNS = [
        "в темноте за деревьями что-то протяжно завыло — и это был не ветер",
        "на земле цепочка следов: похожи на человечьи, но длиннее, и пальцы врозь",
        "совсем рядом хрустнула ветка; ты обернулся — никого",
        "накатил запах — сладковатый, гнилой — и тут же пропал",
        "краем глаза: высокий тонкий силуэт между стволов. моргнул — пусто",
        "кто-то долго смотрел тебе в спину из темноты — ты чувствовал это кожей",
        "тишина упала разом, будто весь лес затаил дыхание",
        "у кромки зарослей — ободранная кора и глубокие борозды, свежие",
    ]

    def _fear_signs(self) -> None:
        cfg = self.scenario.get("fear", {})
        if not cfg.get("night_signs") or not self.is_night:
            return
        night_no = self.tick // self.day_length_ticks
        for a in self.living_agents():
            if getattr(a, "_last_sign_night", -1) == night_no:
                continue                                   # at most one sign a night
            hunger = a.physiology.get("hunger", 100.0)
            if hunger > 60:
                continue                                   # fear feeds on an empty belly
            alone = all(o is a or o.status == "dead"
                        or chebyshev(a.x, a.y, o.x, o.y) > 4 for o in self.agents)
            if not alone or self.near_fire(a):
                continue                                   # company and fire keep it away
            p = 0.10 + (60.0 - hunger) / 200.0 + getattr(a, "dread", 0.0) / 400.0
            if self.rng.random() > p:
                continue
            sign = self.rng.choice(self._FEAR_SIGNS)
            a._last_sign_night = night_no
            a.memory.add(self.tick, self.day, "observation", sign, 2.3)
            a.dread = min(100.0, getattr(a, "dread", 0.0) + self.rng.uniform(6.0, 12.0))
            self.emit("fear_sign", actor=a.id, payload={"name": a.name, "sign": sign})

    def _legacy_anchor_usable_shelter(self, agent):
        """A finished adjacent shelter with room: of the agents crowding it, the
        first `capacity` (stable order) get the slot — extras must find another."""
        return None

    def shelter_occupants(self, shelter: Structure) -> list:
        if shelter.role != "shelter" or not shelter.state.get("complete", True):
            return []
        cap = int(shelter.state.get("capacity", 2))
        inside = sorted((o for o in self.living_agents()
                         if self.structure_contains(shelter, o.x, o.y)),
                        key=lambda o: o.id)
        return inside[:cap]

    def shelter_has_room_for(self, agent, shelter: Structure) -> bool:
        if shelter.role != "shelter" or not shelter.state.get("complete", True):
            return False
        occupants = self.shelter_occupants(shelter)
        if agent in occupants:
            return True
        return len(occupants) < int(shelter.state.get("capacity", 2))

    def usable_shelter(self, agent):
        """A finished shelter only counts when the agent is inside its footprint.
        The exiled are turned away from the group's tents and caves."""
        if self.is_exiled(agent):
            return None
        for s in self.structures:
            if self.structure_contains(s, agent.x, agent.y) and self.shelter_has_room_for(agent, s):
                return s
        return None

    def warm_spot(self, agent) -> bool:
        """Can the agent stay warm here? A lit fire OR a roomy shelter — EXCEPT in
        a storm, when wind and rain tear the heat off a bare fire: then only walls
        (a tent, a cave, the wreckage) truly keep you warm. This is what makes
        shelter matter — the fire carries the calm nights, the roof carries the storm."""
        if self.usable_shelter(agent) is not None:
            return True
        if self.weather == "storm":
            return False            # a bare fire is not enough against a storm
        return self.near_fire(agent)

    def active_agents(self) -> list:
        return [a for a in self.agents if a.status == "active"]

    def living_agents(self) -> list:
        return [a for a in self.agents if a.status != "dead"]

    # ── tick physics ──────────────────────────────────────────────────────────
    def begin_tick(self) -> None:
        self.day = self.tick // self.day_length_ticks + 1
        self.is_night = (self.tick % self.day_length_ticks) >= self.day_length_ticks // 2

        if self.weather_ticks_left > 0:
            self.weather_ticks_left -= 1
            if self.weather_ticks_left == 0:
                self.weather = None

        for n in self.nodes:
            n.tick_regen()

        phys_cfg = self.scenario["physiology"]
        for a in self.living_agents():
            for stat, val in list(a.physiology.items()):
                dec = float(phys_cfg.get(stat, {}).get("decay", 0))
                mult = 1.0
                if self.is_night and stat == "warmth":   # night chills you, not tires
                    mult *= 1.75
                if self.weather == "dust_storm" and stat in ("oxygen", "energy"):
                    mult *= 1.5
                # a storm is meant to be OPPRESSIVE — it bites warmth/energy hard
                # and grinds morale down (huddling matters, shelter matters)
                if self.weather == "storm" and stat in ("warmth", "energy"):
                    mult *= 1.7
                if self.weather == "storm" and stat == "morale":
                    mult *= 1.8
                a.physiology[stat] = max(0.0, val - dec * mult)

        # Night cold: exposed agents (no fire, no shelter) lose extra warmth. The
        # penalty ESCALATES over consecutive nights — the first night stings, but
        # a survivor who still has no fire or shelter by night three is in trouble.
        if self.is_night:
            night_no = self.tick // self.day_length_ticks   # 0,1,2,… nights survived
            exposed_pen = 2.0 + 0.9 * min(night_no, 4)       # 2.0 → 5.6 by night 4
            for a in self.living_agents():
                if "warmth" in a.physiology and not self.warm_spot(a):
                    a.physiology["warmth"] = max(0.0, a.physiology["warmth"] - exposed_pen)
                    # exposure also robs sleep — the cold gnaws at your reserves
                    if "energy" in a.physiology:
                        a.physiology["energy"] = max(0.0, a.physiology["energy"] - 0.8)
                    # a felt lesson (not an order): when a storm freezes you even by
                    # the fire, the body learns that only real walls will do. Names
                    # the NEED (shelter), never the solution — the agent chooses how.
                    if self.weather == "storm" and self.near_fire(a) \
                            and a.physiology["warmth"] < 55:
                        a.memory.add(self.tick, self.day, "observation",
                                     "огонь не держит тепло в такую бурю — ветер и "
                                     "дождь выстуживают до костей. нужны стены, "
                                     "настоящее укрытие, а не костёр под открытым небом", 2.2)

        # Hazard zones sear anyone standing in or next to them.
        hazards = [s for s in self.structures if s.role == "hazard"]
        if hazards:
            for a in self.living_agents():
                if any(self.structure_distance(a.x, a.y, s) <= 1 for s in hazards):
                    if "oxygen" in a.physiology:
                        a.physiology["oxygen"] = max(0.0, a.physiology["oxygen"] - 12)
                    a.physiology["energy"] = max(0.0, a.physiology.get("energy", 0) - 6)
                    a.memory.add(self.tick, self.day, "observation",
                                 "the radiation here is searing me — I can't linger", 2.0)

        # Lit campfires warm nearby agents and lift their morale; fuel burns down.
        for s in self.structures:
            if s.role != "campfire" or not s.state.get("complete"):
                continue
            if s.state.get("fuel", 0) <= 0:
                continue
            s.state["fuel"] = max(0.0, s.state["fuel"] - 4.0)
            for a in self.living_agents():
                if self.is_exiled(a):        # cast out of the camp — no share of its fire
                    continue
                if chebyshev(a.x, a.y, s.x, s.y) <= 2:
                    # a fire gives WARMTH (physical). Happiness is no longer free
                    # here — morale now comes from connection, contribution and
                    # meaning (the psyche layer), so a warm camp is not a fulfilled
                    # one unless the survivors actually build a life together.
                    if "warmth" in a.physiology:
                        # a storm steals the fire's heat — it takes the edge off
                        # but can't hold you warm the way a roof would
                        gain = 3.0 if self.weather == "storm" else 8.0
                        a.physiology["warmth"] = min(100.0, a.physiology["warmth"] + gain)

        # Hot springs warm anyone soaking nearby (natural, no fuel). In a STORM the
        # wind strips that heat: +4 no longer beats the storm penalties, so a spring
        # camp is cosy on calm nights but NOT storm-immune — without this cap the
        # spring strictly dominated every fire and every shelter (proven by runs:
        # the sole survivor of the glm run was the one squatting a hot spring).
        spring_gain = 4.0 if self.weather == "storm" else 10.0
        for s in self.structures:
            if s.role != "hotspring":
                continue
            for a in self.living_agents():
                if chebyshev(a.x, a.y, s.x, s.y) <= 1 and "warmth" in a.physiology:
                    a.physiology["warmth"] = min(100.0, a.physiology["warmth"] + spring_gain)

        # A relit lighthouse lifts everyone's spirits at night (a beacon of hope).
        if self.is_night:
            for s in self.structures:
                if s.role == "beacon" and s.state.get("active"):
                    for a in self.living_agents():
                        if "morale" in a.physiology:
                            a.physiology["morale"] = min(100.0, a.physiology["morale"] + 2)
                    break

        # ── psychosocial drives: decay, company, and the pull on morale ─────────
        # The engine of "why build a society". Each drive decays every tick; only
        # ACTS refill esteem/purpose (see runtime.step), while belonging also
        # feeds off simple company. When the drives run hollow they drag morale
        # down — so once survival is met, restlessness pushes survivors to bond,
        # to be useful, and to leave a mark. None of it names a structure.
        psy_cfg = self.scenario.get("psyche", {})
        if psy_cfg:
            living = self.living_agents()
            for a in living:
                if not a.psyche:
                    continue
                if "belonging" in a.psyche:
                    nearest = min((chebyshev(a.x, a.y, o.x, o.y) for o in living if o is not a),
                                  default=99)
                    if nearest <= 2:
                        # mere company only HOLDS belonging steady (== its decay);
                        # to actually fill it you must reach out — bond, hug, give.
                        # So a huddle that only sits together slowly goes hollow.
                        a.psyche["belonging"] = min(100.0, a.psyche["belonging"] + 1.0)
                    elif nearest >= 6:
                        a.psyche["belonging"] = max(0.0, a.psyche["belonging"] - 1.0)
                for stat in list(a.psyche):
                    dec = float(psy_cfg.get(stat, {}).get("decay", 1.0))
                    a.psyche[stat] = max(0.0, a.psyche[stat] - dec)
                if "morale" in a.physiology and a.psyche:
                    vals = list(a.psyche.values())
                    avg = sum(vals) / len(vals)
                    weak = min(vals)              # the hollowest drive
                    # morale binds on the WEAKEST drive, not the average — a maxed
                    # belonging can no longer mask starving esteem/purpose. A group
                    # that only talks and never builds or makes meaning feels empty,
                    # and that emptiness (not any instruction) drives them to act.
                    score = 0.5 * avg + 0.5 * weak
                    a.physiology["morale"] = max(0.0, min(100.0,
                        a.physiology["morale"] + (score - 50.0) / 50.0 * 1.5))

        # ── food spoilage: raw food rots in the pack over days, preserved keeps ──
        # Makes stockpiling raw food fail, so a smokehouse (dried food) and a
        # shared store become worth building rather than hand-to-mouth foraging.
        from engine.models import PERISHABLE_FOOD
        for a in self.living_agents():
            for item in list(a.inventory):
                if item in PERISHABLE_FOOD and a.inventory[item] > 0:
                    a.inventory[item] = max(0.0, a.inventory[item] - 0.3)
                    if a.inventory[item] <= 0:
                        del a.inventory[item]

        # Fear signs: the island's dark folklore engine (see scenarios/*.yaml `fear`).
        self._fear_signs()

        # Mystery objects: dread, manifestations, the hatch ritual.
        anomaly_tick(self)

    def _lethal_stats(self) -> set[str]:
        cfg = self.scenario["physiology"]
        return {s for s, c in cfg.items() if c.get("lethal", True)}

    def end_tick(self) -> list[str]:
        """Resolve incapacitation/death. Returns death notices for logging.
        Non-lethal stats (e.g. morale) can hit 0 without killing the agent."""
        lethal = self._lethal_stats()
        notices: list[str] = []
        reasons: dict[str, list[str]] = {}
        for a in self.living_agents():
            vital_zero = [s for s, v in a.physiology.items() if v <= 0 and s in lethal]
            if vital_zero:
                a.incap_ticks += 1
                a.status = "incapacitated"
                if a.incap_ticks >= 3:
                    a.status = "dead"
                    notices.append(f"{a.name} died ({', '.join(vital_zero)} depleted)")
                    reasons[a.name] = vital_zero
                    # Memorial: a death takes the agent's craft with it, but the
                    # places they named and lessons they shared live on in others.
                    legacy = f", унеся с собой умения {a.role}" if getattr(a, "role", None) else ""
                    self.log_event("death",
                                   f"{a.name} погиб ({', '.join(vital_zero)}){legacy}", 3.0, [a.name])
            else:
                a.incap_ticks = 0
                a.status = "active"
        self.last_death_notices = notices
        self.last_death_reasons = reasons
        self._resolve_emergent()
        return notices

    def _resolve_emergent(self) -> None:
        """Per-tick resolution of the social/cultural layer: broken promises,
        fireside rituals, and place-names becoming common knowledge."""
        # ── broken promises: an unmet commitment past its hour costs trust ──────
        for c in self.commitments:
            if c["status"] != "open" or self.tick < c["due_tick"]:
                continue
            c["status"] = "broken"
            breaker = self.agent_by_id(c["from_id"])
            promisee = self.agent_by_id(c["to_id"])
            if promisee is not None:
                promisee.relationships.record(c["from_id"], -0.22)
                promisee.memory.add(self.tick, self.day, "social",
                                    f"{c['from']} не сдержал слово: {c['text']}", 2.2)
            if breaker is not None:
                breaker.memory.add(self.tick, self.day, "social",
                                   f"я подвёл {c['to']} — не сдержал обещание: {c['text']}", 2.0)
            self.log_event("promise",
                           f"{c['from']} не сдержал слово перед {c['to']}: {c['text']}",
                           2.4, [c["from"], c["to"]])

        # ── fireside ritual: ≥3 together at a lit fire at night lifts spirits;
        #    enough nights of it and the gathering becomes a tradition ───────────
        if self.is_night:
            for s in self.structures:
                if s.role != "campfire" or not s.state.get("complete"):
                    continue
                if s.state.get("fuel", 0) <= 0:
                    continue
                present = [a for a in self.living_agents()
                           if chebyshev(a.x, a.y, s.x, s.y) <= 2]
                if len(present) < 3:
                    continue
                bonus = 9.0 if self.fireside_tradition else 6.0
                for a in present:
                    if "morale" in a.physiology:
                        a.physiology["morale"] = min(100.0, a.physiology["morale"] + bonus)
                    if a.psyche.get("belonging") is not None:   # gathering IS connection
                        a.psyche["belonging"] = min(100.0, a.psyche["belonging"] + 4.0)
                self.gatherings += 1
                if not self.fireside_tradition and self.gatherings >= 4:
                    self.fireside_tradition = True
                    self.log_event("culture",
                                   "У костра сложилась традиция — ночами собираться вместе у огня",
                                   2.6, [a.name for a in present])
                    self.culture.register_meme(self, "ritual",
                                               "ночной сбор у костра",
                                               present[0].name, present[0].id)
                break   # one gathering counts per tick

        # ── place-names: a name spreads as more survivors pass through it ───────
        living = self.living_agents()
        need = max(2, (len(living) + 1) // 2)
        for pn in self.placenames:
            for a in living:
                if chebyshev(a.x, a.y, pn["x"], pn["y"]) <= 4 and a.id not in pn["endorsers"]:
                    pn["endorsers"].append(a.id)
                    if a.id != pn["by_id"]:
                        a.memory.add(self.tick, self.day, "observation",
                                     f"это место {pn['by']} зовёт «{pn['name']}»", 1.3)
            if not pn.get("famous") and len(pn["endorsers"]) >= need:
                pn["famous"] = True
                self.log_event("culture", f"Место теперь все зовут «{pn['name']}»",
                               2.2, [pn["by"]])
                self.culture.register_meme(self, "name", pn["name"], pn["by"], pn["by_id"])

    def emit(self, kind: str, *, actor: str | None = None, target: str | None = None,
             payload: dict | None = None) -> dict:
        """Append one typed event to the stream and forward it to the run recorder.
        This is the single structured record of what happened — metrics, logs and
        (later) causal analysis all read from here instead of parsing free text."""
        ev = {
            "tick": self.tick,
            "day": self.day,
            "kind": kind,
            "actor": actor,
            "target": target,
            "payload": payload or {},
        }
        self.events.append(ev)
        if len(self.events) > 400:
            self.events = self.events[-400:]
        if self.recorder is not None:
            self.recorder.event(ev)
        return ev

    def log_event(self, kind: str, text: str, importance: float = 2.0,
                  agents: list[str] | None = None) -> None:
        """Record a significant emergent event in the chronicle (the saga the
        observer reads). Distinct from `feed`, which is the raw per-tick stream."""
        self.chronicle.append({
            "tick": self.tick,
            "day": self.day,
            "kind": kind,                 # role | build | death | gossip | promise | rule | culture | escape
            "text": text,
            "importance": float(importance),
            "agents": list(agents or []),
        })
        if len(self.chronicle) > 300:
            self.chronicle = self.chronicle[-300:]
        # Mirror into the typed stream so the chronicle is reconstructable offline.
        self.emit("chronicle", payload={"kind": kind, "text": text,
                                        "importance": float(importance),
                                        "agents": list(agents or [])})

    def mark_escaped(self, agent) -> None:
        self.escaped = True
        self.escape_winner = agent
        self.log_event("escape", f"{agent.name} вырвался с острова — спасение!", 3.0, [agent.name])

    def log_feed(self, agent, kind: str, thought: str, tool: str, result: str) -> None:
        """Append one cognition event for the observer feed (kept bounded)."""
        self.feed.append({
            "tick": self.tick,
            "day": self.day,
            "agent_id": agent.id,
            "agent": agent.name,
            "kind": kind,                 # action | speech | social
            "thought": thought,
            "tool": tool,
            "result": result,
        })
        if len(self.feed) > 200:
            self.feed = self.feed[-200:]
