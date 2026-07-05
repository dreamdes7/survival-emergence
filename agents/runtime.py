"""Agent = state + memory + relationships + persona, plus the per-tick cognitive
loop (PIANO-inspired): perceive -> retrieve -> [reflect] -> decide -> act -> memorize.
"""
from __future__ import annotations
import re

from engine.models import chebyshev, STAT_RESTORE
from engine import skills as skillmod
from .memory import MemoryStream
from .social import RelationshipBook
from .persona import Persona


def _emergency_gate(agent, world) -> dict | None:
    """If any lethal stat is below crit*multiplier, bypass the LLM and force a
    survival action via the heuristic stub. Prevents agents from chatting while
    dying. The multiplier (world.emergency_multiplier, default 2.0) sets how wide
    this override band is; set it to 0 to disable the gate entirely — research
    runs lower it so the heuristic rarely speaks for the model.

    The returned decision is tagged source="emergency" so provenance can measure
    exactly how much of an agent's behaviour the gate — not the brain — authored.
    """
    mult = float(getattr(world, "emergency_multiplier", 2.0))
    if mult <= 0:
        return None
    phys_cfg = world.scenario.get("physiology", {})
    urgent: list[tuple[float, str, float]] = []
    for stat, val in agent.physiology.items():
        cfg = phys_cfg.get(stat, {})
        if not cfg.get("lethal", True):
            continue
        if stat not in STAT_RESTORE:
            continue
        crit = cfg.get("critical", 20)
        if val < crit * mult:
            urgent.append((val / max(crit, 1), stat, val))
    if not urgent:
        return None
    urgent.sort()
    _, stat, val = urgent[0]
    from llm.stub import HeuristicLLM
    action = HeuristicLLM()._satisfy(agent, world, stat)
    if action:
        action = dict(action)
        action["thought"] = f"[{stat}={val:.0f} — срочно] {action.get('thought', '')}"
        action["_source"] = "emergency"
    return action


def _wait_decision(reason: str) -> dict:
    """A neutral no-op used when fallback_policy='wait': the agent does nothing
    productive rather than letting the heuristic inject a survival-rational choice
    into a research run's data."""
    return {"tool": "wait", "args": {}, "thought": f"[wait:{reason}]", "_source": "wait"}


def _execute_decision(agent, world, decision: dict) -> str:
    result = world.tools.execute(decision["tool"], world, agent, decision.get("args", {}))
    world.tool_usage[decision["tool"]] = world.tool_usage.get(decision["tool"], 0) + 1
    return result

PERCEPTION_RADIUS = 8

_COORD_RE = re.compile(r'(\w+)\s+at\s+\((\d+),\s*(\d+)\)')


def _compass(dx: int, dy: int) -> str:
    """Human direction word for a smoke column (y grows downward = south)."""
    ns = "юге" if dy > 0 else ("севере" if dy < 0 else "")
    ew = "востоке" if dx > 0 else ("западе" if dx < 0 else "")
    if ns and ew:
        return f"{ns[:-1]}о-{ew}"      # севере+востоке -> северо-востоке
    return ns or ew or "горизонте"


class Agent:
    def __init__(self, agent_id: str, name: str, persona: Persona,
                 model: str, x: int, y: int, physiology: dict, world_size: int,
                 gender: str = "unspecified"):
        self.id = agent_id
        self.name = name
        self.gender = gender
        self.persona = persona
        self.model = model
        self.x = x
        self.y = y
        self.world_size = world_size
        self.physiology: dict[str, float] = dict(physiology)
        self.inventory: dict[str, float] = {}
        self.status = "active"                 # active | incapacitated | dead
        self.incap_ticks = 0
        self.goals: list[str] = list(persona.drives)

        self.memory = MemoryStream()
        self.relationships = RelationshipBook()
        self.known_nodes: dict[str, object] = {}
        self.known_structures: dict[str, object] = {}
        self.visited: set[tuple[int, int]] = {(x, y)}

        # Emergent specialisation: XP per craft, and the role it crystallises into.
        self.skills: dict[str, float] = {}
        self.role: str | None = None
        # Theory of mind: a synthesised model of each other agent (trust + traits).
        self.beliefs: dict[str, dict] = {}

        # Inbox: messages delivered by other agents this tick.
        self.inbox: list[dict] = []
        self.following: str | None = None
        self.known_hazards: dict[tuple[int, int], str] = {}
        self.pending_bond: dict | None = None   # incoming friendship/romantic proposal

        # Latest cognition, exposed to the observer UI.
        self.last_thought: str = ""
        self.last_tool: str = ""
        self.last_result: str = ""
        self.last_said: str = ""        # most recent thing this agent said aloud
        self.last_source: str = ""      # provenance of the last decision (llm/emergency/…)
        self.dread: float = 0.0         # anomaly-driven fear; 0 unless an anomaly is placed

    # ── inbox ─────────────────────────────────────────────────────────────────
    def deliver(self, msg: dict) -> None:
        """Receive an inbox message. Capped at 20 so long-idle queues can't grow."""
        if self.status != "dead":
            self.inbox.append(msg)
            self.inbox = self.inbox[-20:]

    def _process_inbox(self, world) -> None:
        """Process all pending inbox messages: write memory + apply structured
        learning. Called after perceive() and before llm.decide() each tick."""
        def learn_locations_from_text(text: str, sender: str) -> None:
            for m in _COORD_RE.finditer(text):
                x_c, y_c = int(m.group(2)), int(m.group(3))
                node = world.node_at(x_c, y_c)
                if node and node.id not in self.known_nodes:
                    self.known_nodes[node.id] = node
                    self.memory.add(world.tick, world.day, "social",
                                    f"learned {node.kind} location from {sender}", 1.8)
                struct = world.structure_at(x_c, y_c)
                if struct and struct.id not in self.known_structures:
                    self.known_structures[struct.id] = struct
                    self.memory.add(world.tick, world.day, "social",
                                    f"learned {struct.kind} location from {sender}", 1.8)

        for msg in self.inbox:
            mtype = msg.get("type", "speech")
            sender = msg.get("from", "someone")
            text = msg.get("text", "")
            payload = msg.get("payload", {})

            # (a) Always write exactly one social memory from the message text.
            importance = 2.0 if mtype in ("threat", "follow_request") else 1.6
            self.memory.add(world.tick, world.day, "social", text, importance)

            # (b) Structured learning by message type.
            if mtype == "location":
                # share_location delivery: learn the LIVE node object.
                nid = payload.get("node_id", "")
                node = world.node_by_id(nid)
                if node and nid not in self.known_nodes:
                    self.known_nodes[nid] = node
                    self.memory.add(world.tick, world.day, "social",
                                    f"learned {node.kind} location from {sender}", 1.8)

            elif mtype == "speech":
                # Keyword extraction: "kind at (x,y)" from free-text say_to.
                learn_locations_from_text(text, sender)

            elif mtype == "threat":
                # warn() delivery: register known hazard. (Sprint 2 Step 4)
                x_c = payload.get("x")
                y_c = payload.get("y")
                kind = payload.get("kind", "hazard")
                if x_c is not None and y_c is not None:
                    self.known_hazards[(int(x_c), int(y_c))] = kind

            elif mtype == "follow_request":
                # follow() delivery: leader becomes aware they have a follower.
                pass  # memory already written above; Sprint 2 adds stub logic

            elif mtype == "announce":
                learn_locations_from_text(text, sender)

            elif mtype == "bond_proposal":
                kind = payload.get("kind", "friend")
                self.pending_bond = {
                    "kind": kind,
                    "from_id": msg.get("from_id", ""),
                    "from": sender,
                    "tick": world.tick,
                }

            elif mtype == "bond_accepted":
                kind = payload.get("kind", "friend")
                verb = "стали вместе" if kind == "romantic" else "стали друзьями"
                self.memory.add(world.tick, world.day, "social",
                                f"{sender} принял моё предложение — мы {verb}", 2.4)

            elif mtype == "bond_rejected":
                self.memory.add(world.tick, world.day, "social",
                                f"{sender} отказал мне", 2.1)

            elif mtype == "declared_enemy":
                self.memory.add(world.tick, world.day, "social",
                                f"{sender} объявил меня своим врагом — запомню это", 2.3)

        self.inbox.clear()

    # ── perception ────────────────────────────────────────────────────────────
    def perceive(self, world) -> None:
        for n in world.nodes:
            if chebyshev(self.x, self.y, n.x, n.y) <= PERCEPTION_RADIUS:
                if n.id not in self.known_nodes:
                    self.memory.add(world.tick, world.day, "observation",
                                    f"spotted {n.kind} at ({n.x},{n.y})", 1.0)
                self.known_nodes[n.id] = n
        for s in world.structures:
            if chebyshev(self.x, self.y, s.x, s.y) <= PERCEPTION_RADIUS:
                if s.id not in self.known_structures:
                    self.memory.add(world.tick, world.day, "observation",
                                    f"found {s.kind} at ({s.x},{s.y})", 1.2)
                self.known_structures[s.id] = s
        self._see_smoke(world)

    def _see_smoke(self, world) -> None:
        """A lit fire's smoke carries across the whole island: an agent far beyond
        normal sight still spots the column (and its direction) — though NOT the
        people around it. This makes any fire a natural beacon: cold or lost
        survivors drift toward it, so camps and gatherings form on their own."""
        for s in world.structures:
            if s.role not in ("campfire", "signal_fire"):
                continue
            if not (s.state.get("complete") and s.state.get("fuel", 0) > 0):
                continue
            d = chebyshev(self.x, self.y, s.x, s.y)
            if d <= PERCEPTION_RADIUS or d > world.size:
                continue   # close fires are seen above; cap at island scale
            if s.id not in self.known_structures:
                where = _compass(s.x - self.x, s.y - self.y)
                col = "высокий столб дыма" if s.role == "signal_fire" else "дым костра"
                self.memory.add(world.tick, world.day, "observation",
                                f"вдалеке {col} — на {where} ({s.x},{s.y}), там огонь и, наверное, люди", 1.6)
            self.known_structures[s.id] = s

    def retrieval_query(self, world) -> str:
        """The situation this agent is actually in, as keywords — used to score
        which memories are relevant right now. Built from pressing needs, whoever
        is nearby, and the current goal, so retrieval fires even for blank agents
        (whose goals[0] is empty). Replaces the old always-empty query."""
        parts: list[str] = []
        phys_cfg = world.scenario.get("physiology", {})
        for stat, val in self.physiology.items():
            crit = phys_cfg.get(stat, {}).get("critical", 20)
            if val < crit * 2.0:
                parts.append(stat)
        for o in world.agents:
            if o is self or o.status == "dead":
                continue
            if chebyshev(self.x, self.y, o.x, o.y) <= NEARBY_RADIUS:
                parts.append(o.name)
        parts.extend(self.goals[:2])
        if world.is_night:
            parts.append("night warmth")
        return " ".join(parts)

    # ── reflection (recursive synthesis into a diary line) ─────────────────────
    def reflect(self, world, llm=None) -> None:
        """Periodic reflection. With a real LLM available, synthesise a short
        first-person conclusion from retrieved memory (Generative-Agents style);
        otherwise fall back to a compact templated summary. Either way it becomes
        a diary line + a high-importance reflection memory, and refreshes theory
        of mind."""
        line = None
        client = getattr(llm, "openrouter", None) if llm is not None else None
        if client is not None and self.model != "stub":
            try:
                line = client.reflect(self, world)
            except Exception:
                line = None
        if not line:
            recent = self.memory.recent(10)
            social = sum(1 for e in recent if e.kind == "social")
            worst_stat = min(self.physiology, key=self.physiology.get)
            worst_val = self.physiology[worst_stat]
            allies = sum(1 for r in self.relationships.rel.values() if r.label == "ally")
            rivals = sum(1 for r in self.relationships.rel.values() if r.label == "rival")
            line = (f"Day {world.day}: my {worst_stat} is at {worst_val:.0f}. "
                    f"{social} exchanges lately; {allies} allies, {rivals} rivals. "
                    f"Focus: {self.goals[0] if self.goals else 'survive'}.")
        self.memory.add_diary(world.tick, line)
        self.memory.add(world.tick, world.day, "reflection", line, 2.4)
        # Recursive summarisation: keep the stream bounded by folding the oldest
        # memories into a single summary once it grows large, fighting context drift.
        self.memory.compact(keep_recent=120, summary_kind="reflection")
        self._synthesize_beliefs(world)

    def _synthesize_beliefs(self, world) -> None:
        """Theory of mind: fold what I've seen of each person — our affinity, the
        promises they kept or broke with me, their generosity, their craft — into
        a compact model I can act on (trust this one, watch that one)."""
        recent_text = " ".join(e.text for e in self.memory.entries[-50:])
        for other in world.agents:
            if other is self or other.status == "dead":
                continue
            rel = self.relationships.rel.get(other.id)
            if rel is None or rel.interactions == 0:
                continue
            trust = rel.affinity
            tags: list[str] = []
            kept = sum(1 for c in world.commitments
                       if c["from_id"] == other.id and c["to_id"] == self.id and c["status"] == "kept")
            broke = sum(1 for c in world.commitments
                        if c["from_id"] == other.id and c["to_id"] == self.id and c["status"] == "broken")
            if broke:
                tags.append("нарушает слово"); trust -= 0.2 * broke
            elif kept:
                tags.append("держит слово"); trust += 0.15 * kept
            if f"{other.name} gave me" in recent_text or f"{other.name} сдержал" in recent_text:
                tags.append("щедрый")
            if getattr(other, "role", None):
                tags.append(f"умелый {other.role}")
            if rel.label == "rival":
                tags.append("соперник")
            trust = max(-1.0, min(1.0, trust))
            note = "доверяю" if trust > 0.3 else ("не доверяю" if trust < -0.3 else "присматриваюсь")
            self.beliefs[other.id] = {
                "trust": round(trust, 2), "tags": tags[:3], "note": note, "tick": world.tick,
            }

    # ── one cognitive step ─────────────────────────────────────────────────────
    def step(self, world, llm) -> tuple[dict, str]:
        self.visited.add((self.x, self.y))
        self.perceive(world)
        self._process_inbox(world)       # inbox before decide so info shapes this tick
        emergency = _emergency_gate(self, world)
        decision = emergency or llm.decide(self, world)
        # Provenance: every decision carries the author that produced it. The stub
        # and OpenRouter clients tag their own returns; the gate tags "emergency".
        decision.setdefault("_source", "stub" if getattr(llm, "openrouter", None) is None else "llm")
        result = _execute_decision(self, world, decision)
        if result.startswith(("[blocked]", "[error]")):
            failed_tool = decision["tool"]
            policy = getattr(world, "fallback_policy", "stub")
            if policy == "wait":
                # Research mode: don't let the heuristic repair the model's mistake —
                # record the failure honestly and do nothing this turn.
                repair = _emergency_gate(self, world) or _wait_decision(f"blocked:{failed_tool}")
            else:
                from llm.stub import HeuristicLLM
                repair = _emergency_gate(self, world) or HeuristicLLM().decide(self, world)
                repair.setdefault("_source", "repair_stub")
            if repair and repair.get("tool") != failed_tool:
                repair_result = _execute_decision(self, world, repair)
                repair["thought"] = f"[repair after {failed_tool} failed] {repair.get('thought', '')}"
                decision = repair
                result = f"{result}; fallback {repair['tool']}: {repair_result}"
        self.visited.add((self.x, self.y))
        thought = decision.get("thought", "")
        tool = decision["tool"]
        source = decision.get("_source", "?")

        # Expose the latest cognition for the observer.
        self.last_thought = thought
        self.last_tool = tool
        self.last_result = result
        self.last_source = source
        kind = "action"
        if tool in ("say_to", "announce"):
            kind = "speech"
            self.last_said = decision.get("args", {}).get("message", "")
        elif tool in ("give", "share_location", "follow", "warn", "claim",
                      "hug", "comfort", "compliment", "insult",
                      "gossip", "promise", "name_place",
                      "propose_friendship", "confess_feelings",
                      "accept_bond", "reject_bond", "declare_enemy"):
            kind = "social"

        # Train a craft only when the action actually landed (not a failed/blocked
        # attempt); a clearly dominant craft crystallises into a visible role.
        succeeded = not result.startswith(
            ("[blocked]", "[error]", "no ", "nothing", "need ", "have no",
             "not ", "too far", "already", "can't", "hemmed"))
        if succeeded:
            skillmod.grant(self, tool)
            new_role = skillmod.dominant_role(self)
            if new_role and new_role != self.role:
                self.role = new_role
                world.log_event("role",
                                f"{self.name} стал тем, на кого полагаются — {new_role} группы",
                                2.4, [self.name])
                self.memory.add(world.tick, world.day, "reflection",
                                f"Кажется, я здесь лучший — {new_role}.", 2.2)

        self.memory.add(world.tick, world.day, "action",
                        f"({thought}) -> {tool}: {result}", 1.0)
        world.log_feed(self, kind, thought, tool, result)

        # The core research record: who acted, how, why-source, and to what effect.
        world.emit("decision", actor=self.id,
                   target=(decision.get("args") or {}).get("target"),
                   payload={
                       "name": self.name, "model": self.model, "source": source,
                       "tool": tool, "kind": kind, "thought": thought, "result": result,
                       "x": self.x, "y": self.y,
                       "phys": {k: round(v) for k, v in self.physiology.items()},
                       "fallback_reason": decision.get("_fallback_reason"),
                   })
        return decision, result
