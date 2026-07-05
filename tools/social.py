"""Social tools — sharing, trust, reputation, and promises."""
from __future__ import annotations
from .base import Tool
from engine.models import chebyshev


# ── commitments: a kept promise builds trust; helping the promisee fulfils it ──
def _maybe_keep_promise(world, agent, other) -> None:
    """Any genuine help toward someone you owe a promise marks it kept."""
    for c in reversed(getattr(world, "commitments", [])):
        if c["status"] == "open" and c["from_id"] == agent.id and c["to_id"] == other.id:
            c["status"] = "kept"
            agent.relationships.record(other.id, +0.12)
            other.relationships.record(agent.id, +0.18)   # reliability earns strong trust
            agent.memory.add(world.tick, world.day, "social",
                             f"я сдержал слово перед {other.name}: {c['text']}", 2.0)
            other.memory.add(world.tick, world.day, "social",
                             f"{agent.name} сдержал слово: {c['text']}", 2.2)
            world.log_event("promise",
                            f"{agent.name} сдержал слово перед {other.name}: {c['text']}",
                            2.2, [agent.name, other.name])
            return


def _avail_give(world, agent) -> bool:
    if not agent.inventory:
        return False
    return any(o is not agent and o.status != "dead"
               and chebyshev(agent.x, agent.y, o.x, o.y) <= 1
               for o in world.agents)


def _exec_give(world, agent, args) -> str:
    target_name = args.get("target", "")
    item = args.get("item", "")
    qty = float(args.get("qty", 1))
    other = world.agent_by_name(target_name)
    if other is None or other.status == "dead":
        return f"no one named '{target_name}' nearby"
    if chebyshev(agent.x, agent.y, other.x, other.y) > 1:
        return f"{target_name} is too far to give to"
    have = agent.inventory.get(item, 0)
    if have <= 0:
        return f"have no {item} to give"
    qty = min(qty, have)
    agent.inventory[item] = have - qty
    if agent.inventory[item] <= 0:
        del agent.inventory[item]
    other.inventory[item] = other.inventory.get(item, 0) + qty
    world.barter_count += 1
    agent.relationships.record(other.id, +0.12)
    other.relationships.record(agent.id, +0.15)
    agent.memory.add(world.tick, world.day, "social", f"I gave {qty:.0f} {item} to {target_name}", 1.8)
    other.memory.add(world.tick, world.day, "social", f"{agent.name} gave me {qty:.0f} {item}", 2.0)
    _maybe_keep_promise(world, agent, other)
    # Typed record of every hand-to-hand transfer (economy is data, not prose);
    # the culture tracker watches the scenario's currency item specifically.
    world.emit("gift", actor=agent.id, target=other.id,
               payload={"item": item, "qty": qty, "from": agent.name, "to": other.name})
    world.culture.note_transfer(world, item, agent, other, qty)
    return f"gave {qty:.0f} {item} to {target_name}"


# ── expressive gestures (warm & hostile) ──────────────────────────────────────
def _near_agent(world, agent) -> bool:
    return any(o is not agent and o.status != "dead"
               and chebyshev(agent.x, agent.y, o.x, o.y) <= 1
               for o in world.agents)


def _gesture(world, agent, args, verb_self: str, verb_other: str, delta: float) -> str:
    target_name = args.get("target", "")
    other = world.agent_by_name(target_name)
    if other is None or other.status == "dead":
        return f"no one named '{target_name}' nearby"
    if chebyshev(agent.x, agent.y, other.x, other.y) > 1:
        return f"{target_name} is too far"
    agent.relationships.record(other.id, delta)
    other.relationships.record(agent.id, delta)
    # Warm contact lifts morale for both; hostility drags it down for the target.
    if "morale" in other.physiology:
        other.physiology["morale"] = max(0.0, min(100.0, other.physiology["morale"] + delta * 40))
    if delta > 0 and "morale" in agent.physiology:
        agent.physiology["morale"] = min(100.0, agent.physiology["morale"] + delta * 20)
    agent.memory.add(world.tick, world.day, "social", f"I {verb_self} {target_name}", 1.7)
    other.memory.add(world.tick, world.day, "social", f"{agent.name} {verb_other} me", 1.9)
    if delta > 0:
        _maybe_keep_promise(world, agent, other)
    return f"{verb_self} {target_name}"


def _avail_share_location(world, agent) -> bool:
    if not agent.known_nodes:
        return False
    return any(o is not agent and o.status != "dead"
               and chebyshev(agent.x, agent.y, o.x, o.y) <= 1
               for o in world.agents)


def _node_matches(node, want: str) -> bool:
    hay = f"{node.kind} {node.yield_item}".lower()
    return want in hay


def _exec_share_location(world, agent, args) -> str:
    target_name = args.get("target", "")
    other = world.agent_by_name(target_name)
    if other is None or other.status == "dead":
        return f"no one named '{target_name}' nearby"
    if chebyshev(agent.x, agent.y, other.x, other.y) > 1:
        return f"{target_name} is too far"
    # Natural language: pick the nearest known live node matching `kind`
    # ("water"/"food"/"wood"…), or just the nearest known node. No raw ids.
    want = str(args.get("kind") or args.get("what") or args.get("node_id") or "").lower()
    live = [n for n in agent.known_nodes.values() if n.quantity > 0]
    if want:
        matched = [n for n in live if _node_matches(n, want)]
        live = matched or live
    if not live:
        return "ты ещё не знаешь полезных мест, чтобы рассказать"
    node = min(live, key=lambda n: chebyshev(agent.x, agent.y, n.x, n.y))
    other.deliver({
        "type": "location",
        "from": agent.name,
        "from_id": agent.id,
        "text": f"{node.kind} at ({node.x},{node.y})",
        "payload": {"node_id": node.id},
    })
    agent.relationships.record(other.id, +0.08)
    other.relationships.record(agent.id, +0.10)
    agent.memory.add(world.tick, world.day, "social",
                     f"I told {target_name} where the {node.kind} is", 1.6)
    _maybe_keep_promise(world, agent, other)
    return f"shared location of {node.kind} with {target_name}"


def _avail_follow(world, agent) -> bool:
    if agent.following:
        return False
    for o in world.agents:
        if o is agent or o.status != "active":
            continue
        if chebyshev(agent.x, agent.y, o.x, o.y) <= 1 and o.following != agent.id:
            return True
    return False


def _exec_follow(world, agent, args) -> str:
    target_name = args.get("target", "")
    other = world.agent_by_name(target_name)
    if other is None or other.status == "dead":
        return f"no one named '{target_name}'"
    if chebyshev(agent.x, agent.y, other.x, other.y) > 1:
        return f"{target_name} is too far"
    if other.following == agent.id:
        return "can't follow someone who already follows you"
    agent.following = other.id
    agent.relationships.record(other.id, +0.05)
    other.relationships.record(agent.id, +0.05)
    agent.memory.add(world.tick, world.day, "social", f"I chose to follow {target_name}", 1.5)
    other.deliver({
        "type": "follow_request",
        "from": agent.name,
        "from_id": agent.id,
        "text": f"{agent.name} is now following you",
        "payload": {"follower_id": agent.id},
    })
    return f"now following {target_name}"


def _avail_warn(world, agent) -> bool:
    if not agent.known_hazards:
        return False
    return any(o is not agent and o.status != "dead"
               and chebyshev(agent.x, agent.y, o.x, o.y) <= 1
               for o in world.agents)


def _exec_warn(world, agent, args) -> str:
    target_name = args.get("target", "")
    other = world.agent_by_name(target_name)
    if other is None or other.status == "dead":
        return f"no one named '{target_name}'"
    if chebyshev(agent.x, agent.y, other.x, other.y) > 1:
        return f"{target_name} is too far"
    # Auto-pick the nearest hazard this agent knows — no manual coordinates.
    if not agent.known_hazards:
        return "ты не знаешь ни одной опасности, чтобы предупредить"
    (hx, hy), kind = min(agent.known_hazards.items(),
                         key=lambda kv: chebyshev(agent.x, agent.y, kv[0][0], kv[0][1]))
    other.deliver({
        "type": "threat",
        "from": agent.name,
        "from_id": agent.id,
        "text": f"{agent.name} warned me about {kind} at ({hx},{hy})",
        "payload": {"x": hx, "y": hy, "kind": kind},
    })
    agent.relationships.record(other.id, +0.06)
    other.relationships.record(agent.id, +0.04)
    agent.memory.add(world.tick, world.day, "social",
                     f"I warned {target_name} about {kind} at ({hx},{hy})", 1.5)
    return f"warned {target_name} about {kind} at ({hx},{hy})"


def _avail_claim(world, agent) -> bool:
    claims = getattr(world, "claims", {})
    for nid, node in agent.known_nodes.items():
        if nid in claims:
            continue
        if node.quantity <= 0:
            continue
        if chebyshev(agent.x, agent.y, node.x, node.y) <= 1:
            return True
    return False


def _exec_claim(world, agent, args) -> str:
    # Auto-target an adjacent, unclaimed, live node (optionally matching `kind`).
    want = str(args.get("kind") or args.get("node_id") or "").lower()
    adj = [n for n in world.adjacent_nodes(agent) if n.id not in world.claims]
    if want:
        adj = [n for n in adj if _node_matches(n, want)] or adj
    if not adj:
        # was there one but already claimed?
        taken = [n for n in world.adjacent_nodes(agent) if n.id in world.claims]
        if taken:
            return f"already claimed by {world.claims[taken[0].id]['owner']}"
        return "тут нечего застолбить — встань рядом с ресурсом"
    node = adj[0]
    world.claims[node.id] = {"owner_id": agent.id, "owner": agent.name, "tick": world.tick}
    agent.memory.add(world.tick, world.day, "social",
                     f"I claimed the {node.kind} as mine", 1.6)
    return f"claimed {node.kind}"


# ── gossip: reputation that spreads beyond direct experience ──────────────────
def _avail_gossip(world, agent) -> bool:
    if len(world.living_agents()) < 3:
        return False   # need a third party to talk about
    near_listener = any(o is not agent and o.status != "dead"
                        and chebyshev(agent.x, agent.y, o.x, o.y) <= 1 for o in world.agents)
    if not near_listener:
        return False
    # must hold a formed opinion about at least one other
    return any(r.interactions > 0 and r.label != "stranger"
               for r in agent.relationships.rel.values())


def _exec_gossip(world, agent, args) -> str:
    about = world.agent_by_name(args.get("about", ""))
    if about is None or about is agent or about.status == "dead":
        return "о ком сплетничать? назови человека"
    # listener: named & adjacent, else the nearest adjacent third party
    listener = world.agent_by_name(args.get("to", "")) if args.get("to") else None
    if (listener is None or listener is agent or listener is about
            or chebyshev(agent.x, agent.y, listener.x, listener.y) > 1):
        cands = [o for o in world.agents
                 if o is not agent and o is not about and o.status != "dead"
                 and chebyshev(agent.x, agent.y, o.x, o.y) <= 1]
        listener = min(cands, key=lambda o: chebyshev(agent.x, agent.y, o.x, o.y)) if cands else None
    if listener is None:
        return "рядом некому шепнуть"
    # sentiment: explicit, else inferred from the gossiper's own feeling
    sent = str(args.get("sentiment", "")).lower()
    if sent in ("good", "хорош", "trust", "друг", "+", "ally", "pos", "positive", "тепло"):
        good = True
    elif sent in ("bad", "плох", "против", "-", "враг", "rival", "neg", "negative"):
        good = False
    else:
        good = agent.relationships.get(about.id).affinity >= 0
    delta = 0.08 if good else -0.08
    rel = listener.relationships.get(about.id)
    before = rel.label
    listener.relationships.record(about.id, delta)
    after = rel.label
    # sharing a confidence draws teller and listener a little closer
    listener.relationships.record(agent.id, +0.02)
    agent.relationships.record(listener.id, +0.02)
    verb = "тепло отозвался о" if good else "плохо отозвался о"
    listener.memory.add(world.tick, world.day, "social", f"{agent.name} {verb} {about.name}", 1.8)
    agent.memory.add(world.tick, world.day, "social", f"я {verb} {about.name} при {listener.name}", 1.4)
    # a reputation only makes the chronicle when it actually tips into ally/rival
    if after != before and after in ("ally", "rival"):
        world.log_event(
            "gossip",
            f"со слов {agent.name}, {listener.name} теперь считает {about.name} "
            f"{'своим' if after == 'ally' else 'чужим'}",
            2.0, [agent.name, listener.name, about.name])
    return f"шепнул {listener.name} про {about.name}"


# ── promise: stake your word; keeping it earns trust, breaking it costs it ─────
def _exec_promise(world, agent, args) -> str:
    other = world.agent_by_name(args.get("to", ""))
    if other is None or other is agent or other.status == "dead":
        return "кому ты даёшь слово? назови человека рядом"
    if chebyshev(agent.x, agent.y, other.x, other.y) > 1:
        return f"{other.name} слишком далеко, чтобы дать слово"
    what = str(args.get("what") or args.get("text") or "").strip()
    if not what:
        return "что именно ты обещаешь?"
    # one open promise to the same person at a time — renew rather than stack
    for c in world.commitments:
        if c["status"] == "open" and c["from_id"] == agent.id and c["to_id"] == other.id:
            c["text"] = what
            c["due_tick"] = world.tick + world.day_length_ticks
            return f"ты подтвердил слово перед {other.name}: {what}"
    world.commitments.append({
        "id": len(world.commitments),
        "from_id": agent.id, "from": agent.name,
        "to_id": other.id, "to": other.name,
        "text": what,
        "made_tick": world.tick, "due_tick": world.tick + world.day_length_ticks,
        "status": "open",
    })
    agent.relationships.record(other.id, +0.04)
    agent.memory.add(world.tick, world.day, "social", f"я дал слово {other.name}: {what}", 1.8)
    other.memory.add(world.tick, world.day, "social", f"{agent.name} дал мне слово: {what}", 1.9)
    world.log_event("promise", f"{agent.name} дал слово {other.name}: {what}", 1.6,
                    [agent.name, other.name])
    return f"ты дал слово {other.name}: {what} (сдержи до конца дня)"


def build_social_tools() -> list[Tool]:
    gestures = [
        ("hug", "Hug an adjacent agent — a warm gesture.", "hugged", "hugged", +0.25),
        ("comfort", "Comfort an adjacent agent in distress.", "comforted", "comforted", +0.18),
        ("compliment", "Compliment an adjacent agent.", "complimented", "complimented", +0.12),
        ("insult", "Insult an adjacent agent — hostile.", "insulted", "insulted", -0.25),
    ]
    tools = [
        Tool("give", "Give an item to an adjacent agent.", "social",
             {"target": "agent name", "item": "item name", "qty": "amount"},
             available=_avail_give, execute=_exec_give),
        Tool("share_location", "Tell an adjacent agent where to find a resource (water/food/wood…).", "social",
             {"target": "agent name", "kind": "what resource (e.g. water, food, wood)"},
             available=_avail_share_location, execute=_exec_share_location),
        Tool("follow", "Declare you are following an adjacent agent.", "social",
             {"target": "agent name"},
             available=_avail_follow, execute=_exec_follow),
        Tool("warn", "Warn an adjacent agent about a danger you know of.", "social",
             {"target": "agent name"},
             available=_avail_warn, execute=_exec_warn),
        Tool("claim", "Claim the resource node you're standing next to as yours.", "social",
             {"kind": "optional: which adjacent resource"},
             available=_avail_claim, execute=_exec_claim),
        Tool("gossip", "Quietly share your opinion of a third person with someone nearby — "
                       "it shapes how they see them.", "social",
             {"about": "person you're talking about", "to": "who you tell (optional)",
              "sentiment": "good or bad"},
             available=_avail_gossip, execute=_exec_gossip),
        Tool("promise", "Give your word to an adjacent agent to do something — keep it "
                        "(by helping them) to earn deep trust; break it and lose it.", "social",
             {"to": "agent name", "what": "what you promise to do"},
             available=_near_agent, execute=_exec_promise),
    ]
    for name, desc, vs, vo, delta in gestures:
        tools.append(Tool(
            name, desc, "social", {"target": "agent name"},
            available=_near_agent,
            execute=(lambda w, a, args, vs=vs, vo=vo, d=delta: _gesture(w, a, args, vs, vo, d)),
        ))
    return tools
