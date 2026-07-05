"""Conversation scenes (Sprint 1, FRONTIER_IDEAS 1.1).

A lone `say_to` per tick makes conversations stutter: one line per tick, thread
lost. When a say_to lands on an adjacent agent, the world "pauses" for the pair
and they trade a few replies in one go — a scene. Replies come from each
participant's own brain (real LLM via a compact dialogue prompt, stub via a
deterministic phrase pool), so mixed-model pairs work.

Effects per reply: memory for both sides, a small affinity bump each way, a feed
entry (so the observer sees the exchange), and the speaker's speech bubble.
The whole scene is emitted as ONE typed `dialogue` event with the full
transcript — the research record of who said what to whom in one sitting.
"""
from __future__ import annotations


def _brain_for(llm, agent):
    """Resolve the participant's brain. Falls back to a fresh stub when the
    passed llm doesn't expose routing (e.g. bare stubs/fakes in tests)."""
    getter = getattr(llm, "brain_for", None)
    if callable(getter):
        return getter(agent)
    from llm.stub import HeuristicLLM
    return llm if hasattr(llm, "dialogue_reply") else HeuristicLLM()


def run_scene(world, llm, initiator, partner, opening: str, max_lines: int) -> int:
    """Play out a conversation scene after `initiator` already said `opening` to
    `partner` (the say_to tool has delivered it). Returns the number of extra
    replies spoken. `max_lines` caps replies; either side can end the scene by
    returning None/[конец]."""
    if max_lines <= 0 or partner is None or partner.status != "active":
        return 0
    lines: list[dict] = [{"speaker": initiator.name, "speaker_id": initiator.id,
                          "text": opening}]
    order = (partner, initiator)               # the addressee answers first
    spoken = 0
    for i in range(max_lines):
        speaker = order[i % 2]
        listener = order[(i + 1) % 2]
        brain = _brain_for(llm, speaker)
        reply = None
        try:
            reply = brain.dialogue_reply(speaker, world, listener, lines)
        except Exception:
            reply = None                       # a failed reply just ends the scene
        if not reply:
            break
        lines.append({"speaker": speaker.name, "speaker_id": speaker.id, "text": reply})
        spoken += 1

        # Both sides remember the exchange; talking builds (a little) closeness.
        speaker.memory.add(world.tick, world.day, "social",
                           f'я ответил {listener.name}: "{reply}"', 1.4)
        listener.memory.add(world.tick, world.day, "social",
                            f'{speaker.name} сказал мне: "{reply}"', 1.5)
        speaker.relationships.record(listener.id, +0.03)
        listener.relationships.record(speaker.id, +0.03)
        speaker.last_said = reply
        world.log_feed(speaker, "speech", "", "say_to",
                       f'said to {listener.name}: "{reply}"')

    if spoken:
        world.emit("dialogue", actor=initiator.id, target=partner.id,
                   payload={"participants": [initiator.name, partner.name],
                            "lines": lines})
    return spoken
