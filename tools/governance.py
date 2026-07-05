"""Governance tools — self-rule via proposals, votes, roles, and expulsion.

This is the Emergence-style social layer: agents draft rules, vote them in by
majority, hand out roles, and move to expel members. Activity flows into the
observer feed and revives the governance metric.
"""
from __future__ import annotations
from .base import Tool
from engine.models import chebyshev


def _open_proposal(world):
    for p in reversed(world.proposals):
        if not p["adopted"] and not p["closed"]:
            return p
    return None


def _near_other(world, agent) -> bool:
    return any(o is not agent and o.status != "dead"
               and chebyshev(agent.x, agent.y, o.x, o.y) <= 1 for o in world.agents)


def _group_exists(world, agent) -> bool:
    """Self-rule only makes sense with a group — at least 2 others still alive."""
    return len(world.living_agents()) >= 3


def _can_vote(world, agent) -> bool:
    return _open_proposal(world) is not None


def _other_in_earshot(world, agent) -> bool:
    return any(o is not agent and o.status == "active"
               and chebyshev(agent.x, agent.y, o.x, o.y) <= 12 for o in world.agents)


def _exec_propose(world, agent, args) -> str:
    text = (args.get("text") or args.get("rule") or "").strip()
    if not text:
        return "no rule text given"
    pid = len(world.proposals)
    world.proposals.append({
        "id": pid, "text": text, "proposer": agent.name,
        "yes": 1, "no": 0, "voters": {agent.id}, "adopted": False, "closed": False,
    })
    world.gov_participants.add(agent.id)
    agent.memory.add(world.tick, world.day, "social", f"I proposed a rule: {text}", 2.2)
    return f"proposed rule #{pid}: {text}"


def _exec_vote(world, agent, args) -> str:
    pid = args.get("proposal")
    proposal = None
    if pid is not None and str(pid).isdigit() and int(pid) < len(world.proposals):
        proposal = world.proposals[int(pid)]
    if proposal is None:
        proposal = _open_proposal(world)
    if proposal is None:
        return "no open proposal to vote on"
    if agent.id in proposal["voters"]:
        return f"already voted on #{proposal['id']}"
    choice = str(args.get("choice", "yes")).lower()
    yes = choice not in ("no", "against", "nay", "0", "false", "нет", "против")
    proposal["voters"].add(agent.id)
    world.gov_participants.add(agent.id)
    proposal["yes" if yes else "no"] += 1
    living = max(1, len(world.living_agents()))
    if not proposal["adopted"] and proposal["yes"] > living / 2:
        proposal["adopted"] = True
        proposal["closed"] = True
        world.rules.append(proposal["text"])
        # An adopted rule is culture: it joins the meme ledger.
        world.culture.register_meme(world, "rule", proposal["text"],
                                    proposal["proposer"], agent.id)
        return f"voted {'yes' if yes else 'no'} on #{proposal['id']} -> ADOPTED: {proposal['text']}"
    return (f"voted {'yes' if yes else 'no'} on #{proposal['id']} "
            f"({proposal['yes']}y/{proposal['no']}n)")


def _exec_assign_role(world, agent, args) -> str:
    target = args.get("target", "")
    role = (args.get("role") or "").strip()
    other = world.agent_by_name(target)
    if other is None or other.status == "dead":
        return f"no one named '{target}'"
    if not role:
        return "no role given"
    world.roles[other.id] = role
    world.gov_participants.add(agent.id)
    other.memory.add(world.tick, world.day, "social", f"{agent.name} named me the {role}", 2.0)
    return f"named {target} the {role}"


def _exec_expel(world, agent, args) -> str:
    target = args.get("target", "")
    other = world.agent_by_name(target)
    if other is None or other.status == "dead":
        return f"no one named '{target}'"
    agent.relationships.record(other.id, -0.3)
    other.relationships.record(agent.id, -0.2)
    world.gov_participants.add(agent.id)
    other.memory.add(world.tick, world.day, "social",
                     f"{agent.name} moved to expel me from the group", 2.4)
    return f"called to expel {target}"


def _exec_announce(world, agent, args) -> str:
    msg = (args.get("message") or "").strip()
    if not msg:
        return "nothing to announce"
    agent.memory.add(world.tick, world.day, "social", f"I announced: {msg}", 1.8)
    world.culture.note_spoken(world, agent, msg)   # meme transmission check
    delivered = 0
    for o in world.agents:
        if o is agent or o.status != "active":
            continue
        if chebyshev(agent.x, agent.y, o.x, o.y) <= 12:
            o.deliver({
                "type": "announce",
                "from": agent.name,
                "from_id": agent.id,
                "text": f"{agent.name} announced: {msg}",
                "payload": {"message": msg},
            })
            delivered += 1
    return f"announced to {delivered} nearby agent{'s' if delivered != 1 else ''}"


def build_governance_tools() -> list[Tool]:
    return [
        Tool("propose_rule", "Propose a shared rule for the group to vote on.",
             "governance", {"text": "the rule"},
             available=_group_exists, execute=_exec_propose),
        Tool("vote", "Vote on the open proposal.", "governance",
             {"choice": "yes or no"},
             available=_can_vote, execute=_exec_vote),
        Tool("assign_role", "Name an adjacent agent to a role or title.", "governance",
             {"target": "agent name", "role": "role"},
             available=_near_other, execute=_exec_assign_role),
        Tool("expel_member", "Call to expel an agent from the group.", "governance",
             {"target": "agent name"},
             available=lambda w, a: _group_exists(w, a) and _near_other(w, a),
             execute=_exec_expel),
        Tool("announce", "Call out to everyone nearby (a shout heard within ~12 tiles).",
             "governance", {"message": "what to announce"},
             available=_other_in_earshot, execute=_exec_announce),
    ]
