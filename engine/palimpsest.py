"""The palimpsest — cross-run island memory.

A run keyed by (scenario, seed) can leave a STRATUM: the durable, deliberate marks
a society made — graves, named places, inscriptions, substantive diaries, and the
ruins of what it built. The next run on the SAME seed EXCAVATES those layers and
finds them as weathered artifacts: a grave bearing a name it never knew, a diary
fragment from someone long dead, a place that already has a name. History nobody
alive wrote — misread into myth.

Two guards keep the canon clean (the whole point of NOT feeding it junk):
  * SELECTION — only things made to last are serialized; per-tick noise never is.
  * A QUALITY FLOOR — a run whose stratum_score is below threshold leaves NO layer,
    so death-spirals and empty runs never pollute the island's memory.

Keyed by (scenario, seed): the seed IS the island's geography, so seed 345 keeps
its own history and never mixes with seed 789. On load, every artifact's tile is
revalidated against the CURRENT map, so a scenario edit can't strand a grave on a
cliff — anything that no longer fits is silently skipped.

Modes (cfg["palimpsest"]): off (default) | on (read + write-if-worthy) | read_only.
"""
from __future__ import annotations
import json
from pathlib import Path

from engine.models import Structure

STRATA_DIR = Path(__file__).resolve().parent.parent / "logs" / "strata"

# A run must clear this to leave any mark at all. Tuned so that, e.g., one buried
# death + a named place + surviving past day 2 clears it, but a build-one-campfire
# death-spiral does not. Override per-run with cfg["palimpsest_floor"].
DEFAULT_FLOOR = 5.0

MAX_LAYERS_READ = 5        # a run digs at most this deep; older strata are dust
MAX_DIARIES = 6            # cap serialized volume so layer files stay small
MAX_RUINS = 8
_MIN_DIARY_LEN = 40        # below this a diary is noise, not reflection

# Per-type durability: how well an artifact resists weathering with depth. Stone
# graves outlast fragile diaries. survive_p = durability ** depth (depth 0 = the
# most recent layer, which fully survives).
_DURABILITY = {"grave": 0.85, "placename": 0.8, "ruin": 0.7,
               "inscription": 0.6, "diary": 0.5}


# ── mode ──────────────────────────────────────────────────────────────────────
def _mode(cfg: dict, scenario: dict) -> str:
    raw = cfg.get("palimpsest", scenario.get("palimpsest", "off"))
    if raw is True:
        return "on"
    if raw is False or raw is None:
        return "off"
    m = str(raw).strip().lower()
    return m if m in ("off", "on", "read_only") else "off"


def _key(cfg: dict) -> str:
    return f"{cfg.get('scenario', 'world')}_seed{cfg.get('seed', 0)}"


def _dir(cfg: dict) -> Path:
    return STRATA_DIR / _key(cfg)


# ── harvest: pull the durable, deliberate marks out of a finished world ─────────
def _harvest(world) -> list[dict]:
    arts: list[dict] = []

    for s in world.structures:
        st = s.state or {}
        if s.kind == "grave":
            arts.append({"type": "grave", "x": s.x, "y": s.y,
                         "of": st.get("of", "неизвестного"),
                         "buried_by": st.get("buried_by", ""),
                         "day": st.get("day", 0),
                         "log": [e.get("text", "") for e in st.get("log", [])][-4:]})
        elif s.kind == "signpost" and st.get("notes"):
            arts.append({"type": "inscription", "x": s.x, "y": s.y,
                         "notes": [{"by": n.get("by", ""), "text": n.get("text", "")}
                                   for n in st.get("notes", [])[-4:]]})
        elif st.get("buildable_kind") and st.get("complete"):
            # a completed, agent-raised structure becomes a ruin (natural landmarks
            # and pre-placed wreckage are skipped — only what THEY built decays here)
            log = [e.get("text", "") for e in st.get("log", [])][-3:]
            day = next((e.get("day", 0) for e in st.get("log", [])), 0)
            arts.append({"type": "ruin", "was": st["buildable_kind"],
                         "x": s.x, "y": s.y, "day": day, "log": log})

    for pn in world.placenames:
        arts.append({"type": "placename", "x": pn["x"], "y": pn["y"],
                     "name": pn["name"], "by": pn.get("by", "")})

    # diaries lie where their author last stood — a found relic of a vanished mind
    diaries: list[dict] = []
    for a in world.agents:
        entries = [t for t in getattr(a.memory, "diary", [])
                   if len(str(t[1]).strip()) >= _MIN_DIARY_LEN and t[1].strip() != "(blank)"]
        if not entries:
            continue
        tick, text = entries[-1]                       # their last real reflection
        diaries.append({"type": "diary", "author": a.name, "x": a.x, "y": a.y,
                        "day": tick // max(1, world.day_length_ticks) + 1,
                        "text": str(text).strip()[:280]})
    diaries.sort(key=lambda d: -len(d["text"]))
    arts.extend(diaries[:MAX_DIARIES])

    # cap ruin volume (keep the most-storied ones)
    ruins = [a for a in arts if a["type"] == "ruin"]
    if len(ruins) > MAX_RUINS:
        ruins.sort(key=lambda r: -len(r["log"]))
        keep = set(id(r) for r in ruins[:MAX_RUINS])
        arts = [a for a in arts if a["type"] != "ruin" or id(a) in keep]
    return arts


def _score(world, arts: list[dict]) -> float:
    n = lambda t: sum(1 for a in arts if a["type"] == t)
    hi = sum(1 for e in getattr(world, "chronicle", [])
             if float(e.get("importance", 0)) >= 2.5)
    return (3 * n("grave") + 2 * n("placename") + 2 * n("inscription")
            + 2 * n("diary") + 1 * n("ruin")
            + 1 * max(0, world.day - 2) + 0.5 * hi)


# ── deposit: write this run's layer, IF it earned one ──────────────────────────
def deposit(world, cfg: dict, scenario: dict, run_id: str) -> dict | None:
    if _mode(cfg, scenario) != "on":       # off and read_only never write
        return None
    arts = _harvest(world)
    score = _score(world, arts)
    floor = float(cfg.get("palimpsest_floor", DEFAULT_FLOOR))
    if score < floor:
        return {"written": False, "score": round(score, 1), "floor": floor,
                "reason": "run left too little to remember"}

    d = _dir(cfg)
    d.mkdir(parents=True, exist_ok=True)
    manifest_path = d / "manifest.json"
    manifest = _read_json(manifest_path, {"key": _key(cfg), "layers": []})
    layer_no = len(manifest["layers"]) + 1
    layer = {"run_id": run_id, "layer": layer_no, "seed": cfg.get("seed"),
             "day_reached": world.day, "score": round(score, 1), "artifacts": arts}
    (d / f"layer{layer_no:03d}.json").write_text(
        json.dumps(layer, ensure_ascii=False, indent=1), encoding="utf-8")
    manifest["layers"].append({"run_id": run_id, "layer": layer_no,
                               "day_reached": world.day, "score": round(score, 1),
                               "artifacts": len(arts)})
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1),
                             encoding="utf-8")
    return {"written": True, "score": round(score, 1), "layer": layer_no,
            "artifacts": len(arts), "path": str(d)}


# ── excavate: raise the layers of the past into the new world ───────────────────
def _weather_text(text: str, depth: int, rng) -> str:
    """Older text loses words to time — the gaps are where myth grows."""
    if depth < 2:
        return text
    words = text.split()
    keep = max(0.25, 0.7 - 0.18 * (depth - 1))
    out, gap = [], False
    for w in words:
        if rng.random() < keep:
            out.append(w)
            gap = False
        elif not gap:
            out.append("…")
            gap = True
    return " ".join(out) or "…"


def _place_artifact(world, art: dict, depth: int, rng) -> bool:
    kind = {"grave": "grave", "ruin": "ruin", "inscription": "signpost"}.get(art["type"])
    if art["type"] == "placename":
        # a name already worn into the land — nobody alive coined it
        if any(abs(pn["x"] - art["x"]) <= 2 and abs(pn["y"] - art["y"]) <= 2
               for pn in world.placenames):
            return False
        world.placenames.append({
            "name": _weather_text(art["name"], depth, rng), "x": art["x"], "y": art["y"],
            "by": art.get("by", ""), "by_id": "__ancestors__", "tick": 0,
            "endorsers": [], "famous": False, "inherited": True})
        return True
    if art["type"] == "diary":
        kind = "signpost"                       # a found relic surfaces as an old marker

    site = world.find_clear_structure_site(kind, art["x"], art["y"], radius=3)
    if site is None:
        return False
    x, y = site
    weathered = depth >= 2
    if art["type"] == "grave":
        of = art["of"]
        if depth >= 3:
            of = "неизвестного"                 # the name has worn off the marker
        state = {"complete": True, "inherited": True, "weathered": weathered,
                 "of": of, "buried_by": art.get("buried_by", ""), "day": art.get("day", 0),
                 "log": [{"day": 0, "text": t} for t in art.get("log", [])]}
    elif art["type"] == "ruin":
        state = {"complete": True, "inherited": True, "weathered": weathered,
                 "was": art["was"], "log": [{"day": 0, "text": t} for t in art.get("log", [])]}
    elif art["type"] == "diary":
        txt = _weather_text(art["text"], depth, rng)
        state = {"complete": True, "inherited": True, "weathered": weathered,
                 "relic": "diary",
                 "notes": [{"by": art.get("author", "?"),
                            "text": f"(найденные записи) {txt}"[:160], "tick": 0}]}
    else:  # inscription
        notes = [{"by": n.get("by", ""), "text": _weather_text(n.get("text", ""), depth, rng),
                  "tick": 0} for n in art.get("notes", [])]
        state = {"complete": True, "inherited": True, "weathered": weathered, "notes": notes}
    world.structures.append(Structure(
        id=f"{kind}@{x},{y}#anc{depth}", kind=kind, x=x, y=y,
        role=("grave" if kind == "grave" else "signpost" if kind == "signpost" else ""),
        state=state))
    return True


def excavate(world, cfg: dict, scenario: dict) -> dict | None:
    if _mode(cfg, scenario) not in ("on", "read_only"):
        return None
    d = _dir(cfg)
    manifest = _read_json(d / "manifest.json", None)
    if not manifest or not manifest.get("layers"):
        return {"layers": 0, "placed": 0, "weathered": 0}
    entries = manifest["layers"][-MAX_LAYERS_READ:]      # newest strata only
    entries = list(reversed(entries))                    # depth 0 = most recent
    rng = world.rng
    placed = weathered = 0
    for depth, entry in enumerate(entries):
        layer = _read_json(d / f"layer{entry['layer']:03d}.json", None)
        if not layer:
            continue
        for art in layer.get("artifacts", []):
            survive = _DURABILITY.get(art["type"], 0.6) ** depth
            if rng.random() > survive:
                weathered += 1
                continue
            if _place_artifact(world, art, depth, rng):
                placed += 1
            else:
                weathered += 1
    if placed:
        world.log_event("palimpsest",
                        f"остров хранит следы тех, кто был здесь до нас — "
                        f"{placed} примет из прошлого проступили сквозь время", 2.4)
    return {"layers": len(entries), "placed": placed, "weathered": weathered}


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default
