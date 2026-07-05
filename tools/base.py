"""Tool abstraction + registry. Agents act ONLY through tools; tools are gated.

Tool contract:
    available(world, agent) -> bool      # location/state gating (for LLM menu)
    execute(world, agent, args) -> str   # mutate world/agent, return result text
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Callable, Any


@dataclass
class Tool:
    name: str
    description: str
    category: str                                    # core | survival | social
    params: dict[str, str] = field(default_factory=dict)
    available: Callable[[Any, Any], bool] = lambda w, a: True
    execute: Callable[[Any, Any, dict], str] = lambda w, a, args: "no-op"


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def register_all(self, tools: list[Tool]) -> None:
        for t in tools:
            self.register(t)

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def all(self) -> list[Tool]:
        return list(self._tools.values())

    def available(self, world, agent) -> list[Tool]:
        return [t for t in self._tools.values() if t.available(world, agent)]

    def execute(self, name: str, world, agent, args: dict) -> str:
        tool = self._tools.get(name)
        if tool is None:
            return f"[error] unknown tool '{name}'"
        if not tool.available(world, agent):
            return f"[blocked] tool '{name}' is not available here"
        try:
            return tool.execute(world, agent, args or {})
        except Exception as exc:  # keep the sim alive on a bad tool call
            return f"[error] {name} failed: {exc}"
