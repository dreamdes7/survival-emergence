"""Core tools — always available: movement, communication, memory, goals."""
from __future__ import annotations
from collections import deque
from .base import Tool


def _dist(ax: int, ay: int, bx: int, by: int) -> int:
    return max(abs(ax - bx), abs(ay - by))


def _free(world, agent, x: int, y: int) -> bool:
    if not (0 <= x < agent.world_size and 0 <= y < agent.world_size):
        return False
    blocked = getattr(world, "blocked", None)
    return not (blocked(x, y)) if blocked else True


def _step_toward(world, agent, tx: int, ty: int) -> bool:
    """Move one king-step toward (tx, ty), sliding around blocked tiles.
    Avoids known hazard tiles unless they are the only option.
    Returns True if the agent moved."""
    path_step = _path_step(world, agent, tx, ty, avoid_hazards=True)
    if path_step is None:
        path_step = _path_step(world, agent, tx, ty, avoid_hazards=False)
    if path_step is not None:
        agent.x, agent.y = path_step
        return True

    dx = (tx > agent.x) - (tx < agent.x)
    dy = (ty > agent.y) - (ty < agent.y)
    candidates = [
        (agent.x + dx, agent.y + dy),  # primary (diagonal or straight)
        (agent.x + dx, agent.y),       # horizontal component only
        (agent.x, agent.y + dy),       # vertical component only
    ]
    # When moving in a pure cardinal direction, add sideways detours so agents
    # don't get trapped against a wall of terrain.
    if dx == 0:
        candidates += [(agent.x + 1, agent.y), (agent.x - 1, agent.y)]
    if dy == 0:
        candidates += [(agent.x, agent.y + 1), (agent.x, agent.y - 1)]
    hazards = getattr(agent, "known_hazards", {})
    safe, unsafe = [], []
    for nx, ny in candidates:
        if (nx, ny) != (agent.x, agent.y) and _free(world, agent, nx, ny):
            (unsafe if (nx, ny) in hazards else safe).append((nx, ny))
    # Prefer safe tiles; fall back to hazardous ones only if fully blocked.
    for nx, ny in (safe or unsafe):
        agent.x, agent.y = nx, ny
        return True
    return False


def _path_step(world, agent, tx: int, ty: int, avoid_hazards: bool) -> tuple[int, int] | None:
    start = (agent.x, agent.y)
    target = (tx, ty)
    hazards = getattr(agent, "known_hazards", {})

    if _free(world, agent, tx, ty):
        goals = {target}
    else:
        goals = {
            (tx + dx, ty + dy)
            for dx in (-1, 0, 1)
            for dy in (-1, 0, 1)
            if (dx or dy) and _free(world, agent, tx + dx, ty + dy)
        }
    if not goals:
        return None

    def ordered_neighbors(x: int, y: int) -> list[tuple[int, int]]:
        neighbors = [
            (x - 1, y - 1), (x, y - 1), (x + 1, y - 1),
            (x - 1, y),                 (x + 1, y),
            (x - 1, y + 1), (x, y + 1), (x + 1, y + 1),
        ]
        neighbors.sort(key=lambda p: (
            max(abs(p[0] - tx), abs(p[1] - ty)),
            abs(p[0] - tx) + abs(p[1] - ty),
        ))
        return neighbors

    queue = deque([start])
    came_from: dict[tuple[int, int], tuple[int, int] | None] = {start: None}
    max_seen = max(64, agent.world_size * agent.world_size)

    while queue and len(came_from) <= max_seen:
        current = queue.popleft()
        if current in goals:
            while came_from[current] != start:
                prev = came_from[current]
                if prev is None:
                    return None
                current = prev
            return current

        for nxt in ordered_neighbors(*current):
            if nxt in came_from:
                continue
            nx, ny = nxt
            if not _free(world, agent, nx, ny):
                continue
            if avoid_hazards and nxt in hazards:
                continue
            came_from[nxt] = current
            queue.append(nxt)

    return None


def _semantic_target(world, agent, text: str) -> tuple[int, int, str] | None:
    q = (text or "").strip().lower()
    if not q:
        return None

    def score(x: int, y: int) -> int:
        return _dist(agent.x, agent.y, x, y)

    def best(items):
        items = list(items)
        if not items:
            return None
        return min(items, key=lambda item: score(item[0], item[1]))

    agents = []
    for other in world.agents:
        if other is agent or other.status != "active":
            continue
        name = other.name.lower()
        if q == name or name in q:
            agents.append((other.x, other.y, other.name))
    if not agents and any(w in q for w in ("group", "others", "груп", "остальн", "люд")):
        agents = [(o.x, o.y, o.name) for o in world.agents if o is not agent and o.status == "active"]
    hit = best(agents)
    if hit:
        return hit

    structure_wants = {
        "campfire": ("campfire", "fire", "кост", "огон", "лагер"),
        "shelter": ("shelter", "tent", "палат", "укрыт"),
        "water": ("water_still", "водосбор"),
        "escape": ("escape", "signal", "raft", "shuttle", "эвак", "спас"),
        "store": ("store", "склад"),
    }
    structures = []
    for s in agent.known_structures.values():
        hay = f"{s.kind} {s.role}".lower()
        for label, needles in structure_wants.items():
            if any(n in q for n in needles) and (label in hay or any(n in hay for n in needles)):
                structures.append((s.x, s.y, s.kind))
                break
        if q in hay:
            structures.append((s.x, s.y, s.kind))
    hit = best(structures)
    if hit:
        return hit

    node_wants = {
        "water": ("water", "spring", "родник", "источник", "вода"),
        "food": ("food", "fruit", "berries", "fish", "еда", "фрукт", "рыб"),
        "wood": ("wood", "tree", "дерев", "дров", "бревн"),
        "stone": ("stone", "rocks", "кам"),
        "fiber": ("fiber", "thicket", "волок", "зарос"),
        "ore": ("ore", "руда"),
    }
    nodes = []
    for n in agent.known_nodes.values():
        if n.quantity <= 0:
            continue
        hay = f"{n.kind} {n.yield_item}".lower()
        for label, needles in node_wants.items():
            if any(w in q for w in needles) and (label in hay or any(w in hay for w in needles)):
                nodes.append((n.x, n.y, n.kind))
                break
        if q in hay:
            nodes.append((n.x, n.y, n.kind))
    return best(nodes)


def _exec_go_to(world, agent, args) -> str:
    raw_x = args.get("x")
    raw_y = args.get("y")
    if raw_x is None or raw_y is None:
        target_text = args.get("target") or args.get("label") or args.get("name") or args.get("kind") or ""
        semantic = _semantic_target(world, agent, str(target_text))
        if semantic is None:
            return "go_to needs x/y or a known target"
        tx, ty, label = semantic
    else:
        try:
            tx = int(raw_x)
            ty = int(raw_y)
        except (TypeError, ValueError):
            return "go_to needs numeric x/y"
        label = args.get("label", f"({tx},{ty})")
    if (agent.x, agent.y) == (tx, ty):
        return f"already at {label}"
    steps = max(1, getattr(world, "move_speed", 1))
    for _ in range(steps):
        if (agent.x, agent.y) == (tx, ty):
            break
        if not _step_toward(world, agent, tx, ty):
            break   # blocked in — stop (likely now adjacent to a tree/rock/target)
    if (agent.x, agent.y) == (tx, ty):
        return f"reached {label} at ({agent.x},{agent.y})"
    return f"moved toward {label}, now at ({agent.x},{agent.y})"


def _exec_wander(world, agent, args) -> str:
    dirs = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (1, -1), (-1, 1)]
    world.rng.shuffle(dirs)
    for dx, dy in dirs:
        if _free(world, agent, agent.x + dx, agent.y + dy):
            agent.x += dx
            agent.y += dy
            return f"wandered to ({agent.x},{agent.y})"
    return "hemmed in — nowhere to wander"


def _exec_say_to(world, agent, args) -> str:
    target_name = args.get("target", "")
    message = args.get("message", "...")
    other = world.agent_by_name(target_name)
    if other is None or other.status == "dead":
        return f"no one named '{target_name}' to talk to"
    from engine.models import chebyshev
    if chebyshev(agent.x, agent.y, other.x, other.y) > 1:
        return f"{target_name} is too far to talk to"
    agent.relationships.record(other.id, +0.06)
    other.relationships.record(agent.id, +0.04)
    agent.memory.add(world.tick, world.day, "social", f'I said to {target_name}: "{message}"', 1.5)
    # Recipient memory is created inside _process_inbox (one write, no duplicates).
    other.deliver({
        "type": "speech",
        "from": agent.name,
        "from_id": agent.id,
        "text": f'{agent.name} said to me: "{message}"',
        "payload": {},
    })
    return f'said to {target_name}: "{message}"'


def _exec_write_diary(world, agent, args) -> str:
    text = args.get("text", "").strip() or "(blank)"
    agent.memory.add_diary(world.tick, text)
    return "wrote a diary entry"


def _exec_set_goal(world, agent, args) -> str:
    goal = args.get("goal", "").strip()
    if not goal:
        return "no goal given"
    if goal in agent.goals:
        agent.goals.remove(goal)
    agent.goals.insert(0, goal)
    return f"focused on goal: {goal}"


def _exec_wait(world, agent, args) -> str:
    """Do nothing this turn. Used as the neutral no-op under fallback_policy='wait'
    so a failed model call never gets a survival-rational heuristic action grafted
    onto it. Deliberately changes no world state."""
    return "ждёт, ничего не делая"


def build_core_tools() -> list[Tool]:
    return [
        Tool("go_to", "Move toward a coordinate or a known named target.", "core",
             {"x": "target x", "y": "target y", "label": "what is there", "target": "known target name"},
             execute=_exec_go_to),
        Tool("wander", "Explore in a random direction.", "core",
             execute=_exec_wander),
        Tool("say_to", "Speak to an adjacent agent.", "core",
             {"target": "agent name", "message": "what to say"},
             execute=_exec_say_to),
        Tool("write_diary", "Record a private reflection.", "core",
             {"text": "diary content"}, execute=_exec_write_diary),
        Tool("set_goal", "Make a goal your top priority.", "core",
             {"goal": "goal text"}, execute=_exec_set_goal),
        Tool("wait", "Do nothing this turn.", "core",
             execute=_exec_wait),
    ]
