"""Routes each agent's decision to its configured brain.

agent.model == "stub"  -> heuristic stub (no API)
anything else          -> OpenRouter client, calling that model id
"""
from __future__ import annotations


class LLMRouter:
    def __init__(self, stub, openrouter=None) -> None:
        self.stub = stub
        self.openrouter = openrouter

    def brain_for(self, agent):
        """The brain that speaks for this agent (used by dialogue scenes/dreams,
        which call purpose-specific methods rather than .decide)."""
        if agent.model == "stub" or self.openrouter is None:
            return self.stub
        return self.openrouter

    def decide(self, agent, world) -> dict:
        return self.brain_for(agent).decide(agent, world)
