"""Personal bond tools — friendship, romance, enmity.

Bonds are bilateral named relationships that go beyond the affinity number.
Friendship and romance must be proposed AND accepted by the other agent.
Sworn enemy is declared unilaterally — no consent needed.

Bond lifecycle:
  propose_friendship / confess_feelings  →  inbox bond_proposal
  accept_bond / reject_bond              →  bond formed or proposal dropped
  declare_enemy                          →  immediate, unilateral
"""
from __future__ import annotations
from .base import Tool
from engine.models import chebyshev


def _near_live(world, agent) -> bool:
    return any(o is not agent and o.status != "dead"
               and chebyshev(agent.x, agent.y, o.x, o.y) <= 1
               for o in world.agents)


def _can_propose_friendship(world, agent) -> bool:
    for o in world.agents:
        if o is agent or o.status == "dead":
            continue
        if chebyshev(agent.x, agent.y, o.x, o.y) > 1:
            continue
        rel = agent.relationships.get(o.id)
        if rel.bond not in ("friend", "best_friend", "romantic"):
            return True
    return False


def _can_confess(world, agent) -> bool:
    for o in world.agents:
        if o is agent or o.status == "dead":
            continue
        if chebyshev(agent.x, agent.y, o.x, o.y) > 1:
            continue
        rel = agent.relationships.get(o.id)
        if rel.affinity >= 0.45 and rel.bond != "romantic":
            return True
    return False


def _has_pending_bond(world, agent) -> bool:
    return getattr(agent, "pending_bond", None) is not None


def _exec_propose_friendship(world, agent, args) -> str:
    target_name = args.get("target", "")
    other = world.agent_by_name(target_name)
    if other is None or other.status == "dead":
        return f"рядом нет никого по имени '{target_name}'"
    if chebyshev(agent.x, agent.y, other.x, other.y) > 1:
        return f"{target_name} слишком далеко"
    rel = agent.relationships.get(other.id)
    if rel.bond in ("friend", "best_friend", "romantic"):
        return f"у тебя с {target_name} уже есть связь"
    other.pending_bond = {
        "kind": "friend",
        "from_id": agent.id,
        "from": agent.name,
        "tick": world.tick,
    }
    other.deliver({
        "type": "bond_proposal",
        "from": agent.name,
        "from_id": agent.id,
        "text": f"{agent.name} предложил тебе дружбу — ответь: accept_bond или reject_bond",
        "payload": {"kind": "friend"},
    })
    agent.relationships.record(other.id, +0.05)
    agent.memory.add(world.tick, world.day, "social",
                     f"я предложил {target_name} дружбу", 1.9)
    world.log_event("bond", f"{agent.name} предложил {other.name} дружбу", 1.8,
                    [agent.name, other.name])
    return f"предложил {target_name} дружбу — ждёшь ответа"


def _exec_confess_feelings(world, agent, args) -> str:
    target_name = args.get("target", "")
    other = world.agent_by_name(target_name)
    if other is None or other.status == "dead":
        return f"рядом нет никого по имени '{target_name}'"
    if chebyshev(agent.x, agent.y, other.x, other.y) > 1:
        return f"{target_name} слишком далеко"
    rel = agent.relationships.get(other.id)
    if rel.bond == "romantic":
        return f"вы и так уже вместе с {target_name}"
    other.pending_bond = {
        "kind": "romantic",
        "from_id": agent.id,
        "from": agent.name,
        "tick": world.tick,
    }
    other.deliver({
        "type": "bond_proposal",
        "from": agent.name,
        "from_id": agent.id,
        "text": f"{agent.name} признался тебе в чувствах — ответь: accept_bond или reject_bond",
        "payload": {"kind": "romantic"},
    })
    agent.relationships.record(other.id, +0.08)
    agent.memory.add(world.tick, world.day, "social",
                     f"я признался в чувствах {target_name}", 2.2)
    world.log_event("bond", f"{agent.name} признался в чувствах {other.name}", 2.2,
                    [agent.name, other.name])
    return f"признался {target_name} в чувствах — ждёшь ответа"


def _exec_accept_bond(world, agent, args) -> str:
    proposal = getattr(agent, "pending_bond", None)
    if proposal is None:
        return "нет входящего предложения"
    other = world.agent_by_id(proposal["from_id"])
    if other is None or other.status == "dead":
        agent.pending_bond = None
        return "тот, кто предложил — уже не с нами"
    kind = proposal["kind"]
    agent.relationships.get(other.id).bond = kind
    other.relationships.get(agent.id).bond = kind
    delta = 0.25 if kind == "romantic" else 0.18
    agent.relationships.record(other.id, +delta)
    other.relationships.record(agent.id, +delta)
    agent.pending_bond = None
    if "morale" in agent.physiology:
        agent.physiology["morale"] = min(100.0, agent.physiology["morale"] + 20)
    if "morale" in other.physiology:
        other.physiology["morale"] = min(100.0, other.physiology["morale"] + 20)
    # A bond with an outcast welcomes them back into the fold.
    for pair in ((agent, other), (other, agent)):
        if world.is_exiled(pair[0]):
            world.readmit(pair[0])
            pair[0].memory.add(world.tick, world.day, "social",
                               f"{pair[1].name} связал со мной судьбу — изгнание кончилось, "
                               f"меня снова приняли", 2.7)
    verb = "стали вместе" if kind == "romantic" else "стали друзьями"
    agent.memory.add(world.tick, world.day, "social",
                     f"мы с {other.name} {verb}", 2.5)
    other.memory.add(world.tick, world.day, "social",
                     f"{agent.name} и я {verb}", 2.5)
    other.deliver({
        "type": "bond_accepted",
        "from": agent.name,
        "from_id": agent.id,
        "text": f"{agent.name} принял твоё предложение — вы {verb}",
        "payload": {"kind": kind},
    })
    label = "любовь" if kind == "romantic" else "дружба"
    world.log_event("bond",
                    f"✦ {agent.name} и {other.name} {verb}! ({label})",
                    2.8, [agent.name, other.name])
    return f"{verb} с {other.name}"


def _exec_reject_bond(world, agent, args) -> str:
    proposal = getattr(agent, "pending_bond", None)
    if proposal is None:
        return "нет входящего предложения"
    other = world.agent_by_id(proposal["from_id"])
    kind = proposal["kind"]
    agent.pending_bond = None
    if other is None or other.status == "dead":
        return "предложивший уже ушёл"
    other.relationships.record(agent.id, -0.15)
    agent.relationships.record(other.id, -0.05)
    if "morale" in other.physiology:
        other.physiology["morale"] = max(0.0, other.physiology["morale"] - 15)
    agent.memory.add(world.tick, world.day, "social",
                     f"я отказал {other.name}", 1.8)
    other.memory.add(world.tick, world.day, "social",
                     f"{agent.name} отказал мне", 2.1)
    other.deliver({
        "type": "bond_rejected",
        "from": agent.name,
        "from_id": agent.id,
        "text": f"{agent.name} отказал тебе",
        "payload": {"kind": kind},
    })
    verb = "отказала в чувствах" if kind == "romantic" else "отказала в дружбе"
    world.log_event("bond", f"{agent.name} {verb} {other.name}", 2.0,
                    [agent.name, other.name])
    return f"отказал {other.name}"


def _exec_declare_enemy(world, agent, args) -> str:
    target_name = args.get("target", "")
    other = world.agent_by_name(target_name)
    if other is None or other.status == "dead":
        return f"рядом нет никого по имени '{target_name}'"
    agent.relationships.get(other.id).bond = "sworn_enemy"
    agent.relationships.record(other.id, -0.3)
    other.relationships.record(agent.id, -0.2)
    if "morale" in other.physiology:
        other.physiology["morale"] = max(0.0, other.physiology["morale"] - 10)
    agent.memory.add(world.tick, world.day, "social",
                     f"я объявил {target_name} своим врагом", 2.2)
    other.memory.add(world.tick, world.day, "social",
                     f"{agent.name} объявил меня своим врагом", 2.3)
    other.deliver({
        "type": "declared_enemy",
        "from": agent.name,
        "from_id": agent.id,
        "text": f"{agent.name} объявил тебя своим заклятым врагом",
        "payload": {},
    })
    world.log_event("bond", f"⚔ {agent.name} объявил {other.name} своим врагом", 2.4,
                    [agent.name, other.name])
    return f"объявил {target_name} своим врагом"


def build_bond_tools() -> list[Tool]:
    return [
        Tool("propose_friendship",
             "Предложить соседнему агенту стать друзьями. Он должен принять или отклонить.",
             "social", {"target": "имя агента"},
             available=_can_propose_friendship, execute=_exec_propose_friendship),
        Tool("confess_feelings",
             "Признаться соседнему агенту в романтических чувствах. Он должен ответить.",
             "social", {"target": "имя агента"},
             available=_can_confess, execute=_exec_confess_feelings),
        Tool("accept_bond",
             "Принять входящее предложение дружбы или романтических отношений.",
             "social", {},
             available=_has_pending_bond, execute=_exec_accept_bond),
        Tool("reject_bond",
             "Отклонить входящее предложение дружбы или романтических чувств.",
             "social", {},
             available=_has_pending_bond, execute=_exec_reject_bond),
        Tool("declare_enemy",
             "Объявить соседнего агента своим заклятым врагом — односторонне, без согласия.",
             "social", {"target": "имя агента"},
             available=_near_live, execute=_exec_declare_enemy),
    ]
