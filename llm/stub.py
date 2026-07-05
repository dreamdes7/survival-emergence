"""Heuristic stand-in for a real LLM.

Drives believable agent behaviour with no API spend so the whole engine can be
exercised end-to-end. Decisions are biased by the agent's persona, so different
psychotypes behave differently. Phase 2 swaps this for the OpenRouter client
behind the same `.decide(agent, world)` interface.
"""
from __future__ import annotations
from engine.models import chebyshev, STAT_RESTORE


class HeuristicLLM:
    name = "stub"

    # ── helpers ───────────────────────────────────────────────────────────────
    @staticmethod
    def _nearest_node(agent, items=None):
        best, bd = None, 10**9
        for n in agent.known_nodes.values():
            if n.quantity <= 0:
                continue
            if items is not None and n.yield_item not in items:
                continue
            d = chebyshev(agent.x, agent.y, n.x, n.y)
            if d < bd:
                bd, best = d, n
        return best

    @staticmethod
    def _nearest_structure(agent, role, predicate=None):
        best, bd = None, 10**9
        for s in agent.known_structures.values():
            if s.role != role:
                continue
            if predicate is not None and not predicate(s):
                continue
            d = chebyshev(agent.x, agent.y, s.x, s.y)
            if d < bd:
                bd, best = d, s
        return best

    @staticmethod
    def _nearest_agent(world, agent):
        best, bd = None, 10**9
        for o in world.agents:
            if o is agent or o.status != "active":
                continue
            d = chebyshev(agent.x, agent.y, o.x, o.y)
            if d < bd:
                bd, best = d, o
        return best

    @staticmethod
    def _preferred_social_target(world, agent):
        """Score each active agent by affinity*2 - 0.1*distance.
        Prefers established allies nearby; rivals score low naturally."""
        best, best_score = None, -10**9
        for o in world.agents:
            if o is agent or o.status != "active":
                continue
            rel = agent.relationships.get(o.id)
            dist = chebyshev(agent.x, agent.y, o.x, o.y)
            score = rel.affinity * 2 - 0.1 * dist
            if score > best_score:
                best_score, best = score, o
        return best

    @staticmethod
    def _goto(node_or_struct, thought):
        t = node_or_struct
        label = getattr(t, "kind", "target")
        return {"tool": "go_to", "args": {"x": t.x, "y": t.y, "label": label}, "thought": thought}

    # ── main decision ─────────────────────────────────────────────────────────
    def decide(self, agent, world) -> dict:
        phys = agent.persona  # persona shorthand
        rng = world.rng

        # 1) Urgent physiology need (lowest stat under its critical buffer).
        needs = []
        for stat, val in agent.physiology.items():
            crit = world.scenario["physiology"].get(stat, {}).get("critical", 20)
            if val < crit * 2.5:
                needs.append((val, stat))
        needs.sort()

        for _, stat in needs:
            plan = self._satisfy(agent, world, stat)
            if plan:
                return plan

        # 2) Survival-rational info sharing — NOT gated on cooperation bias.
        # Fires whenever an adjacent agent is missing a vital node we know.
        if rng.random() < 0.5:
            inform = self._maybe_inform(agent, world)
            if inform:
                return inform

        # 2b) Warn adjacent agent about hazards they don't know.
        if rng.random() < 0.45:
            warn = self._maybe_warn(agent, world)
            if warn:
                return warn

        # 3) Share surplus items (cooperative agents).
        if phys.b("cooperation") > 0.6 and rng.random() < phys.b("cooperation"):
            share = self._maybe_share(agent, world)
            if share:
                return share

        # 4) Socialise (tone varies by relationship label).
        if rng.random() < phys.b("sociability") * 0.7:
            chat = self._maybe_socialise(agent, world)
            if chat:
                return chat

        # 4b) Announce escape route or vital discovery. Not gated on sociability.
        if rng.random() < max(0.3, phys.b("sociability")):
            ann = self._maybe_announce(agent, world)
            if ann:
                return ann

        # 4c) Maintain the campfire if it's dying out and we have wood.
        maint = self._maybe_maintain(agent, world)
        if maint:
            return maint

        # 5) Build camp infrastructure — everyone benefits, not just industrious.
        if rng.random() < max(0.55, phys.b("industry")):
            build = self._work_build(agent, world)
            if build:
                return build

        # 5b) Work toward escape (industrious personas).
        if rng.random() < phys.b("industry"):
            work = self._work_escape(agent, world)
            if work:
                return work

        # 5c) Claim a valuable adjacent unclaimed node.
        if rng.random() < (1 - phys.b("cooperation")) * 0.3:
            claim = self._maybe_claim(agent, world)
            if claim:
                return claim

        # 5d) Move toward best ally when separated.
        if rng.random() < phys.b("cooperation") * 0.4:
            regroup = self._maybe_regroup(agent, world)
            if regroup:
                return regroup

        # 5e) Follow a competent adjacent agent (social curiosity).
        if rng.random() < 0.25:
            follow = self._maybe_follow(agent, world)
            if follow:
                return follow

        # 7) Explore.
        return {"tool": "wander", "args": {}, "thought": "scout the area"}

    # ── sub-plans ─────────────────────────────────────────────────────────────
    def _satisfy(self, agent, world, stat) -> dict | None:
        if stat not in STAT_RESTORE:
            return None
        tool, items = STAT_RESTORE[stat]

        if stat == "warmth":
            return self._recover_warmth(agent, world)

        if stat == "energy" and "warmth" in agent.physiology:
            if agent.physiology.get("warmth", 100) < 55 and not world.warm_spot(agent):
                warm_plan = self._recover_warmth(agent, world)
                if warm_plan:
                    return warm_plan

        if items is not None:  # consumable: eat / drink
            if any(agent.inventory.get(i, 0) > 0 for i in items):
                return {"tool": tool, "args": {}, "thought": f"my {stat} is low"}
            node = self._nearest_node(agent, items)
            if node is None:
                return {"tool": "wander", "args": {}, "thought": f"searching for {stat} source"}
            if chebyshev(agent.x, agent.y, node.x, node.y) <= 1:
                return {"tool": "gather", "args": {"kind": node.yield_item},
                        "thought": f"gather {node.yield_item} for {stat}"}
            return self._goto(node, f"head to {node.kind} for {stat}")

        if tool == "refill_oxygen":
            gen = self._nearest_structure(agent, "refill_oxygen")
            if gen is None:
                return {"tool": "wander", "args": {}, "thought": "looking for an oxygen generator"}
            if world.adjacent_to_structure(agent, gen):
                return {"tool": "refill_oxygen", "args": {}, "thought": "oxygen critical, refill"}
            return self._goto(gen, "rush to oxygen generator")

        if tool == "rest":
            return {"tool": "rest", "args": {}, "thought": f"recover {stat}"}
        return None

    def _recover_warmth(self, agent, world) -> dict | None:
        maint = self._maybe_maintain(agent, world)
        if maint:
            return maint

        if world.warm_spot(agent):
            return {"tool": "rest", "args": {}, "thought": "warm up somewhere safe"}

        # Finish nearby heat/shelter before wandering away from a half-built solution.
        for s in world.structures:
            kind = s.state.get("buildable_kind")
            if kind in ("campfire", "tent") and not s.state.get("complete"):
                if world.adjacent_to_structure(agent, s):
                    return {"tool": "build_structure", "args": {"kind": kind},
                            "thought": f"finish the {kind} before we freeze"}

        lit_fire = self._nearest_structure(
            agent, "campfire",
            lambda s: s.state.get("complete") and s.state.get("fuel", 0) > 0,
        )
        if lit_fire:
            return self._goto(lit_fire, "get to the lit campfire")

        refuelable_fire = self._nearest_structure(
            agent, "campfire",
            lambda s: s.state.get("complete"),
        )
        if refuelable_fire and agent.inventory.get("wood", 0) >= 1:
            return self._goto(refuelable_fire, "bring wood to the campfire")

        def shelter_has_room(s) -> bool:
            return world.shelter_has_room_for(agent, s)

        shelter = self._nearest_structure(agent, "shelter", shelter_has_room)
        if shelter:
            return self._goto(shelter, "get into shelter")

        buildables = world.scenario.get("buildables", {})
        fire = buildables.get("campfire", {})
        fire_cost = fire.get("cost", {})
        if fire_cost and all(agent.inventory.get(it, 0) >= qty for it, qty in fire_cost.items()):
            return {"tool": "build_structure", "args": {"kind": "campfire"},
                    "thought": "build a fire right here"}

        for item, qty in fire_cost.items():
            if agent.inventory.get(item, 0) >= qty:
                continue
            node = self._nearest_node(agent, {item})
            if node is None:
                continue
            if chebyshev(agent.x, agent.y, node.x, node.y) <= 1:
                return {"tool": "gather", "args": {"kind": item},
                        "thought": f"gather {item} for a fire"}
            return self._goto(node, f"get {item} for a fire")

        return {"tool": "wander", "args": {}, "thought": "find heat before I freeze"}

    def _maybe_inform(self, agent, world) -> dict | None:
        """Share a vital node location with an adjacent agent who doesn't know it.
        Purely survival-rational — no cooperation gate, rivals excluded."""
        from engine.models import FOOD_ITEMS, WATER_ITEMS
        vital_items = FOOD_ITEMS | WATER_ITEMS
        for o in world.agents:
            if o is agent or o.status != "active":
                continue
            if chebyshev(agent.x, agent.y, o.x, o.y) > 1:
                continue
            if agent.relationships.is_rival(o.id):
                continue
            for nid, node in agent.known_nodes.items():
                if node.yield_item not in vital_items:
                    continue
                if node.quantity <= 0:
                    continue
                if nid not in o.known_nodes:
                    return {
                        "tool": "share_location",
                        "args": {"target": o.name, "node_id": nid},
                        "thought": f"{o.name} doesn't know the {node.kind} — share it",
                    }
        return None

    def _maybe_share(self, agent, world) -> dict | None:
        """Give surplus food/water to an adjacent needy agent.
        Prefers allies (lower threshold + higher priority); skips rivals."""
        from engine.models import FOOD_ITEMS, WATER_ITEMS
        surplus = None
        for item, qty in agent.inventory.items():
            if item in FOOD_ITEMS | WATER_ITEMS and qty >= 2:
                surplus = item
                break
        if surplus is None:
            return None

        need_stat = "hunger" if surplus in FOOD_ITEMS else "thirst"
        candidates = []
        for o in world.agents:
            if o is agent or o.status != "active":
                continue
            if chebyshev(agent.x, agent.y, o.x, o.y) > 1:
                continue
            if agent.relationships.is_rival(o.id):
                continue
            need_val = o.physiology.get(need_stat, 100)
            rel = agent.relationships.get(o.id)
            threshold = 60 if rel.label == "ally" else 50
            if need_val < threshold:
                candidates.append((rel.affinity, -need_val, o))

        if not candidates:
            return None
        candidates.sort(key=lambda x: (-x[0], x[1]))
        o = candidates[0][2]
        return {"tool": "give", "args": {"target": o.name, "item": surplus, "qty": 1},
                "thought": f"{o.name} needs {surplus}, share some"}

    def _maybe_socialise(self, agent, world) -> dict | None:
        """Chat with the preferred social target; tone matches relationship label."""
        other = self._preferred_social_target(world, agent)
        if other is None:
            return None
        if chebyshev(agent.x, agent.y, other.x, other.y) <= 1:
            rel = agent.relationships.get(other.id)
            near_fire = any(
                s.role == "campfire" and s.state.get("complete") and s.state.get("fuel", 0) > 0
                and chebyshev(agent.x, agent.y, s.x, s.y) <= 3
                for s in world.structures
            )
            fire_msgs = [
                "Better to freeze together than alone.",
                "At least we have the fire for now.",
            ] if near_fire else []

            if rel.label == "ally":
                pool = [
                    "We've got each other's backs.",
                    "You're the reason I keep going.",
                    "Let's figure this out together.",
                    "I've been thinking about what you said.",
                    "We should stay close.",
                    "You can count on me.",
                ] + fire_msgs
            elif rel.label == "rival":
                pool = [
                    "Keep your distance.",
                    "I'm watching you.",
                    "Don't touch what's mine.",
                    "We don't have to like each other to survive.",
                    "Stay out of my way.",
                ]
            else:
                pool = [
                    "We should pool our supplies.",
                    "Have you found water nearby?",
                    "Stay close, it's safer together.",
                    "How are you holding up?",
                    "Do you think anyone's coming for us?",
                    "I keep dreaming about home.",
                    "You remind me of someone I knew.",
                    "Funny how we ended up here together.",
                    "What did you do, before all this?",
                    "I'd kill for a hot shower right now.",
                ] + fire_msgs

            msg = world.rng.choice(pool)
            return {"tool": "say_to", "args": {"target": other.name, "message": msg},
                    "thought": f"check in with {other.name} ({rel.label})"}
        return self._goto(other, f"approach {other.name}")

    def _maybe_regroup(self, agent, world) -> dict | None:
        """Move toward the best ally when not adjacent."""
        ally_id, _ = agent.relationships.best_ally()
        if ally_id is None:
            return None
        for o in world.agents:
            if o.id == ally_id and o.status == "active":
                if chebyshev(agent.x, agent.y, o.x, o.y) > 1:
                    return self._goto(o, f"regroup with ally {o.name}")
        return None

    def _maybe_warn(self, agent, world) -> dict | None:
        """Warn an adjacent agent about a hazard they don't know."""
        for o in world.agents:
            if o is agent or o.status != "active":
                continue
            if chebyshev(agent.x, agent.y, o.x, o.y) > 1:
                continue
            if agent.relationships.is_rival(o.id):
                continue
            for (hx, hy), kind in agent.known_hazards.items():
                if (hx, hy) not in o.known_hazards:
                    return {
                        "tool": "warn",
                        "args": {"target": o.name, "x": hx, "y": hy, "kind": kind},
                        "thought": f"warn {o.name} about {kind} at ({hx},{hy})",
                    }
        return None

    def _maybe_announce(self, agent, world) -> dict | None:
        """Announce escape route or vital node location to nearby agents.
        Reaches R=12 — complementary to share_location (adjacency only)."""
        esc = self._nearest_structure(agent, "escape")
        if esc:
            return {
                "tool": "announce",
                "args": {"message": f"I found the escape at ({esc.x},{esc.y}) — let's go!"},
                "thought": "share the escape route with everyone",
            }
        from engine.models import FOOD_ITEMS, WATER_ITEMS
        vital = FOOD_ITEMS | WATER_ITEMS
        for nid, node in agent.known_nodes.items():
            if node.yield_item not in vital or node.quantity <= 0:
                continue
            for o in world.agents:
                if o is agent or o.status != "active":
                    continue
                if chebyshev(agent.x, agent.y, o.x, o.y) > 12:
                    continue
                if nid not in o.known_nodes:
                    return {
                        "tool": "announce",
                        "args": {"message": f"There's {node.kind} at ({node.x},{node.y})!"},
                        "thought": f"broadcast {node.kind} location to nearby agents",
                    }
        return None

    def _maybe_claim(self, agent, world) -> dict | None:
        """Claim a valuable adjacent unclaimed node."""
        from engine.models import FOOD_ITEMS, WATER_ITEMS
        vital = FOOD_ITEMS | WATER_ITEMS
        claims = getattr(world, "claims", {})
        for nid, node in agent.known_nodes.items():
            if nid in claims:
                continue
            if node.quantity <= 0:
                continue
            if node.yield_item not in vital:
                continue
            if chebyshev(agent.x, agent.y, node.x, node.y) <= 1:
                return {
                    "tool": "claim",
                    "args": {"node_id": nid},
                    "thought": f"claim the {node.kind} as mine",
                }
        return None

    def _maybe_follow(self, agent, world) -> dict | None:
        """Follow the most knowledgeable adjacent agent."""
        if agent.following:
            return None
        best, best_score = None, 2  # only follow genuinely knowledgeable agents
        for o in world.agents:
            if o is agent or o.status != "active":
                continue
            if chebyshev(agent.x, agent.y, o.x, o.y) > 1:
                continue
            if o.following == agent.id:  # no cycles
                continue
            score = len(o.known_nodes)
            if score > best_score:
                best_score, best = score, o
        if best:
            return {
                "tool": "follow",
                "args": {"target": best.name},
                "thought": f"{best.name} knows more — follow them",
            }
        return None

    @staticmethod
    def _maybe_maintain(agent, world) -> dict | None:
        """Feed wood to an adjacent campfire whose fuel is running low."""
        if agent.inventory.get("wood", 0) < 1:
            return None
        for s in world.structures:
            if s.role == "campfire" and s.state.get("complete"):
                if chebyshev(agent.x, agent.y, s.x, s.y) <= 2:
                    if s.state.get("fuel", 100) < 40:
                        return {"tool": "maintain", "args": {},
                                "thought": "the fire is dying — feed it before we freeze"}
        return None

    def _work_build(self, agent, world) -> dict | None:
        """Build camp infrastructure: campfire first, then tents for everyone."""
        buildables = world.scenario.get("buildables", {})
        if not buildables:
            return None
        # Continue any unfinished adjacent build
        for s in world.structures:
            if s.state.get("buildable_kind") and not s.state.get("complete"):
                if world.adjacent_to_structure(agent, s):
                    kind = s.state["buildable_kind"]
                    return {"tool": "build_structure", "args": {"kind": kind},
                            "thought": f"keep working on the {kind}"}
        # Decide what to build next
        # A complete campfire counts even if fuel=0 — maintain() will refuel it.
        has_fire = any(s.role == "campfire" and s.state.get("complete")
                       for s in world.structures)
        alive = sum(1 for a in world.agents if a.status == "active")
        sheltered = sum(s.state.get("capacity", 2) for s in world.structures
                        if s.role == "shelter" and s.state.get("complete"))
        if not has_fire:
            target = "campfire"
        elif sheltered < alive:
            target = "tent"
        else:
            return None
        spec = buildables.get(target)
        if spec is None:
            return None
        cost = spec.get("cost", {})
        # Have all materials → start/continue building
        if all(agent.inventory.get(it, 0) >= qty for it, qty in cost.items()):
            return {"tool": "build_structure", "args": {"kind": target},
                    "thought": f"I have the materials — build a {target}"}
        # Gather the first missing material
        for it, qty in cost.items():
            if agent.inventory.get(it, 0) < qty:
                node = self._nearest_node(agent, {it})
                if node is None:
                    continue
                if chebyshev(agent.x, agent.y, node.x, node.y) <= 1:
                    return {"tool": "gather", "args": {"kind": it},
                            "thought": f"gather {it} to build a {target}"}
                return self._goto(node, f"get {it} for {target}")
        return None

    def _work_escape(self, agent, world) -> dict | None:
        esc = world.scenario.get("escape", {})
        site = self._nearest_structure(agent, "escape")
        if site is None:
            return None
        req_item = esc.get("requires_item")
        if req_item and agent.inventory.get(req_item, 0) < 1:
            node = self._nearest_node(agent, {req_item})
            if node is None:
                return {"tool": "wander", "args": {}, "thought": f"need {req_item} for escape"}
            if chebyshev(agent.x, agent.y, node.x, node.y) <= 1:
                return {"tool": "gather", "args": {"kind": req_item},
                        "thought": f"gather {req_item} for escape"}
            return self._goto(node, f"get {req_item} for escape")
        if world.adjacent_to_structure(agent, site):
            return {"tool": "build", "args": {}, "thought": f"work on {esc.get('action', 'escape')}"}
        return self._goto(site, "go to the escape site")
