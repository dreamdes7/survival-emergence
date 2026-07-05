"""Routes each agent's decision to its configured brain.

agent.model == "stub"  -> heuristic stub (no API)
anything else          -> OpenRouter client, calling that model id
"""
from __future__ import annotations


class LLMRouter:
    def __init__(self, stub, openrouter=None) -> None:
        self.stub = stub
        self.openrouter = openrouter

    def decide(self, agent, world) -> dict:
        if agent.model == "stub" or self.openrouter is None:
            return self.stub.decide(agent, world)
        return self.openrouter.decide(agent, world)
