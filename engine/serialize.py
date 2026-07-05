"""JSON-safe world snapshots for API/WebSocket observers."""
from __future__ import annotations

from engine.metrics import awi_metrics
from engine.models import STRUCTURE_SIZE, structure_size


def world_manifest(world) -> dict:
    """Single source of truth for the frontend's per-structure knowledge tables.

    The observer used to hardcode footprint size, buildable required_progress and
    build cost in several places (and required_progress was triplicated with the
    scenario yaml). Serving them from the backend means adding a structure or
    changing a cost is a one-place edit; the UI just reads this.
    """
    scenario = world.scenario
    buildables = scenario.get("buildables", {})
    structures = {}
    kinds = set(STRUCTURE_SIZE) | set(buildables) | {s.kind for s in world.structures}
    for kind in sorted(kinds):
        w, h = structure_size(kind)
        entry = {"w": w, "h": h}
        spec = buildables.get(kind)
        if spec:
            entry["buildable"] = True
            entry["required_progress"] = float(spec.get("required_progress", 100))
            entry["cost"] = dict(spec.get("cost", {}))
        structures[kind] = entry
    return {
        "scenario": scenario.get("name"),
        "map_size": world.size,
        "terrains": list(scenario.get("map", {}).get("terrains", {}).keys()),
        "structures": structures,
        "roles": sorted({s.role for s in world.structures if s.role}),
    }


def world_snapshot(world) -> dict:
    id_to_name = {a.id: a.name for a in world.agents}

    return {
        "tick": world.tick,
        "day": world.day,
        "is_night": world.is_night,
        "weather": world.weather,
        "escaped": world.escaped,
        "escape_winner": world.escape_winner.name if world.escape_winner else None,
        "escape_progress": world.escape_progress,
        "scenario": world.scenario.get("name"),
        "map": {
            "size": world.size,
            "grid": world.grid,
        },
        "agents": [
            {
                "id": a.id,
                "name": a.name,
                "gender": getattr(a, "gender", "unspecified"),
                "persona": a.persona.id,
                "model": a.model,
                "x": a.x,
                "y": a.y,
                "status": a.status,
                "physiology": dict(a.physiology),
                "inventory": dict(a.inventory),
                "goals": list(a.goals),
                "allies": sum(1 for r in a.relationships.rel.values() if r.label == "ally"),
                "rivals": sum(1 for r in a.relationships.rel.values() if r.label == "rival"),
                "diary": a.memory.diary[-12:],
                "thought": getattr(a, "last_thought", ""),
                "action": (f"{a.last_tool}: {a.last_result}".strip(": ")
                           if getattr(a, "last_tool", "") else ""),
                "said": getattr(a, "last_said", ""),
                # Provenance: who authored this agent's last action (llm / emergency /
                # llm_fallback_stub / repair_stub / stub / wait). Lets the observer
                # see when the heuristic — not the model — is driving.
                "decision_source": getattr(a, "last_source", ""),
                "dread": round(getattr(a, "dread", 0.0), 1),
                # Day plan from split thinking (null in full mode / for stubs).
                "plan": ({"goal": a.plan.get("goal", ""), "steps": a.plan.get("steps", [])}
                         if getattr(a, "plan", None) else None),
                # Fog of war visibility
                "known_nodes": list(a.known_nodes.keys()),
                "known_structures": list(a.known_structures.keys()),
                # Relationship detail for modal card + metrics
                "relationships": [
                    {
                        "id": oid,
                        "name": id_to_name.get(oid, oid),
                        "label": r.label,
                        "score": round(r.affinity, 3),
                        "bond": r.bond,
                    }
                    for oid, r in sorted(
                        a.relationships.rel.items(), key=lambda kv: -kv[1].affinity
                    )
                ],
                "best_ally": id_to_name.get(a.relationships.best_ally()[0] or "", None),
                "following": id_to_name.get(a.following or "", None),
                "followers": sum(1 for o in world.agents if o.following == a.id),
                # Emergent specialisation
                "skills": {k: round(v, 1) for k, v in getattr(a, "skills", {}).items()},
                "role": getattr(a, "role", None),
                # Theory of mind
                "beliefs": [
                    {"name": id_to_name.get(oid, oid), "trust": b.get("trust", 0),
                     "note": b.get("note", ""), "tags": b.get("tags", [])}
                    for oid, b in getattr(a, "beliefs", {}).items()
                    if id_to_name.get(oid)
                ],
            }
            for a in world.agents
        ],
        "feed": world.feed[-50:],
        "chronicle": world.chronicle[-60:],
        "saga": list(getattr(world, "saga", []))[-12:],
        "placenames": [
            {"name": pn["name"], "x": pn["x"], "y": pn["y"],
             "by": pn["by"], "famous": pn.get("famous", False)}
            for pn in getattr(world, "placenames", [])
        ],
        "commitments": [
            {"from": c["from"], "to": c["to"], "text": c["text"], "status": c["status"]}
            for c in getattr(world, "commitments", []) if c["status"] == "open"
        ],
        "resources": [
            {
                "id": n.id,
                "kind": n.kind,
                "yield_item": n.yield_item,
                "x": n.x,
                "y": n.y,
                "quantity": n.quantity,
                "max_quantity": n.max_quantity,
            }
            for n in world.nodes
        ],
        "structures": [
            {
                "id": s.id,
                "kind": s.kind,
                "role": s.role,
                "x": s.x,
                "y": s.y,
                "w": structure_size(s.kind)[0],
                "h": structure_size(s.kind)[1],
                "state": dict(s.state),
            }
            for s in world.structures
        ],
        "claims": [
            {"node_id": nid, "owner_id": d["owner_id"], "owner": d["owner"]}
            for nid, d in world.claims.items()
        ],
        "metrics": awi_metrics(world),
        # Live decision-provenance tally (share of actions by author this run).
        "provenance": (world.recorder.contamination()
                       if getattr(world, "recorder", None) is not None else None),
    }
