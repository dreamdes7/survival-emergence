"""Emergent specialisation.

Agents accrue skill XP from what they repeatedly DO (not from any assignment),
gain a diminishing yield/rate bonus in that craft, and — once one craft clearly
dominates — earn a visible ROLE. Roles are never handed out; they crystallise
from behaviour and give the rest of the group a reason to rely on that agent.

Used by:
  - runtime.Agent.step()  -> grant() after each action, then re-evaluate role
  - tools/survival.gather  -> skill_bonus(forager) scales the harvest
  - tools/build.build_*    -> skill_bonus(builder) scales build progress
  - llm prompt             -> surfaces own role + others' roles
"""
from __future__ import annotations

# Which skill a tool trains. Only meaningful, repeatable crafts count; movement,
# speech, eating etc. train nothing.
TOOL_SKILL: dict[str, str] = {
    "gather": "forager",
    "build_structure": "builder",
    "build": "builder",
    "maintain": "builder",
    "comfort": "healer",
    "hug": "healer",
    "give": "healer",
    "share_location": "healer",
}

# Human-facing role names (RU) keyed by skill.
ROLE_NAME: dict[str, str] = {
    "forager": "добытчик",
    "builder": "строитель",
    "healer": "опора группы",
}

XP_PER_ACTION = 1.0
ROLE_MIN_XP = 18.0      # real practice before a role sticks
ROLE_DOMINANCE = 1.5    # top craft must lead the runner-up by this factor

# ── ASSIGNED roles (governance) → a canonical DOMAIN that grants a real edge ──
# assign_role takes free text, so an emergent title ("хранитель огня") can be
# purely honorific — but when the title clearly names a known craft/office, it
# confers actual power in that domain. This is what makes handing out roles a
# political act worth doing, not just a label. Matched by substring on the title.
ROLE_DOMAIN_KEYWORDS: dict[str, tuple[str, ...]] = {
    "forager": ("добыт", "собир", "провиз", "forag", "gather", "охот", "снаб"),
    "fisher":  ("рыб", "fish", "рыбак"),
    "builder": ("строит", "плотник", "зодч", "build", "мастер по", "инженер"),
    "cook":    ("повар", "кух", "кашевар", "cook", "коптиль"),
    "leader":  ("вожд", "лидер", "лидэр", "старейшин", "глав", "предводит",
                "капитан", "вождь", "leader", "chief", "старост", "командир"),
    "healer":  ("лекар", "целит", "врач", "знахар", "heal", "медик"),
}

# The mechanical edge each assigned domain grants (on top of earned skill XP).
ROLE_DOMAIN_BONUS: dict[str, float] = {
    "forager": 0.25, "fisher": 0.25, "builder": 0.25, "cook": 0.30, "healer": 0.0,
    # leader's power is social (vote weight, reach), handled in governance — not a yield %.
    "leader": 0.0,
}


def role_domain(role_text: str | None) -> str | None:
    """Canonical domain for an assigned title, or None if it's purely honorific."""
    if not role_text:
        return None
    low = role_text.lower()
    for domain, keys in ROLE_DOMAIN_KEYWORDS.items():
        if any(k in low for k in keys):
            return domain
    return None


def skill_bonus(xp: float) -> float:
    """Diminishing yield/rate add-on: ~+6% per sqrt(xp), capped at +50%."""
    if xp <= 0:
        return 0.0
    return min(0.5, 0.06 * (xp ** 0.5))


def grant(agent, tool: str) -> None:
    """Award XP for performing `tool` (no-op for tools that train nothing)."""
    skill = TOOL_SKILL.get(tool)
    if not skill:
        return
    skills = agent.skills
    skills[skill] = skills.get(skill, 0.0) + XP_PER_ACTION


def dominant_role(agent) -> str | None:
    """The agent's emergent role, or None if no craft clearly dominates yet."""
    skills = getattr(agent, "skills", {})
    if not skills:
        return None
    top_skill = max(skills, key=skills.get)
    ranked = sorted(skills.values(), reverse=True)
    top = ranked[0]
    second = ranked[1] if len(ranked) > 1 else 0.0
    if top >= ROLE_MIN_XP and top >= ROLE_DOMINANCE * max(second, 1.0):
        return ROLE_NAME.get(top_skill)
    return None
