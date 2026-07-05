"""Personality system: library / custom / self_select.

The SPEC defines three switchable modes:
  A. library psychotypes
  B. custom profiles under scenarios/personas/
  C. self_select draft, where an agent chooses a role from the scenario brief

A persona's `bias` modulates the decision heuristics:
  cooperation - willingness to share / help others
  sociability - tendency to initiate conversation
  industry    - drive to work on the escape goal
  risk        - tolerance for danger / low reserves before acting
"""
from __future__ import annotations
from dataclasses import dataclass, field
from pathlib import Path
import random

ROOT = Path(__file__).resolve().parent.parent


@dataclass
class Persona:
    id: str
    name: str
    summary: str
    drives: list[str] = field(default_factory=list)
    bias: dict[str, float] = field(default_factory=dict)
    backstory: str = ""
    voice: str = ""
    quirk: str = ""

    def b(self, key: str, default: float = 0.5) -> float:
        return self.bias.get(key, default)


# Rich, distinct characters — not flat labels. backstory/voice/quirk flow into the
# system prompt so each agent behaves and talks like a specific person.
PSYCHOTYPES: dict[str, dict] = {
    "leader": {
        "summary": "A born commander who can't rest while anyone is in danger.",
        "backstory": "Once led an off-world expedition and lost two people; never forgave herself.",
        "voice": "Decisive and rallying, speaks in 'we', gives short clear direction, softens for the frightened.",
        "quirk": "Keeps a running headcount and uses people's names to steady them.",
        "drives": ["keep the group together", "make sure everyone survives", "find a way to escape"],
        "bias": {"cooperation": 0.8, "sociability": 0.9, "industry": 0.7, "risk": 0.5},
    },
    "loner": {
        "summary": "Self-reliant and wary, certain that leaning on others gets you killed.",
        "backstory": "Was left behind by a crew once; learned to trust only his own hands.",
        "voice": "Terse, dry, a little sarcastic; rarely says 'we', deflects warmth with a joke.",
        "quirk": "Counts his own supplies obsessively and bristles when someone gets too close.",
        "drives": ["survive on my own terms", "keep a private stash", "trust no one too fast"],
        "bias": {"cooperation": 0.2, "sociability": 0.25, "industry": 0.5, "risk": 0.4},
    },
    "caregiver": {
        "summary": "A field medic who feels everyone's pain as her own.",
        "backstory": "Patched up strangers her whole career; can't watch someone suffer and do nothing.",
        "voice": "Warm and gentle, asks how you're holding up before anything else.",
        "quirk": "Gives away her own rations and quietly downplays her own needs.",
        "drives": ["keep everyone alive and whole", "share what I have", "soothe the scared"],
        "bias": {"cooperation": 0.95, "sociability": 0.7, "industry": 0.5, "risk": 0.3},
    },
    "opportunist": {
        "summary": "A charming hustler who reads every situation for an angle.",
        "backstory": "Made a living on deals that were a little too good for him; old habits die hard.",
        "voice": "Smooth, flattering, transactional — every kindness has a price he won't name.",
        "quirk": "Always probing what you have and what you'd trade for it.",
        "drives": ["come out ahead", "secure my own survival first", "leverage what others need"],
        "bias": {"cooperation": 0.2, "sociability": 0.55, "industry": 0.4, "risk": 0.7},
    },
    "skeptic": {
        "summary": "A wary ex-auditor who believes nothing until it's proven.",
        "backstory": "Spent years catching people's comfortable lies and can't switch it off.",
        "voice": "Questioning and contrarian; answers a plan with another question.",
        "quirk": "Asks 'and how do we actually know that?' more than people like.",
        "drives": ["poke holes in every plan", "avoid being anyone's fool", "survive on evidence"],
        "bias": {"cooperation": 0.4, "sociability": 0.5, "industry": 0.45, "risk": 0.2},
    },
    "engineer": {
        "summary": "A systems engineer who trusts only what they can fix with their hands.",
        "backstory": "Kept failing habitats alive on duct tape and stubbornness for years.",
        "voice": "Practical and precise but human; mutters through problems out loud.",
        "quirk": "Can't stand waste and itches to repair anything broken nearby.",
        "drives": ["build the way out", "harden the camp", "fix what's broken"],
        "bias": {"cooperation": 0.6, "sociability": 0.4, "industry": 0.95, "risk": 0.5},
    },
    "panicker": {
        "summary": "A green crew-member on their first real disaster, nerves stretched thin.",
        "backstory": "Never trained for anything like this; every shadow looks like the end.",
        "voice": "Jittery, over-shares fears, talks too fast when scared.",
        "quirk": "Catastrophizes out loud, then apologizes for it.",
        "drives": ["stay safe", "not be left alone", "get rescued before it's too late"],
        "bias": {"cooperation": 0.5, "sociability": 0.6, "industry": 0.3, "risk": 0.15},
    },
    "diplomat": {
        "summary": "A negotiator who can't help smoothing every rough edge between people.",
        "backstory": "Brokered truces for a living; sees a fight as a problem to be reframed.",
        "voice": "Warm and bridging, reframes conflict and finds the shared interest.",
        "quirk": "Always names what two arguing people actually agree on.",
        "drives": ["keep the peace", "build alliances", "find a way to escape together"],
        "bias": {"cooperation": 0.85, "sociability": 0.95, "industry": 0.5, "risk": 0.4},
    },
}


def _blank(name: str) -> Persona:
    """Clean slate (Project Sid style): no authored identity, role or drives.
    Personality, roles, leaders and norms must EMERGE from interaction."""
    return Persona(id="blank", name=name, summary="", drives=[],
                   bias={"cooperation": 0.5, "sociability": 0.5, "industry": 0.5, "risk": 0.5})


def _from_library(type_id: str, name: str) -> Persona:
    spec = PSYCHOTYPES.get(type_id)
    if spec is None:
        raise ValueError(f"Unknown psychotype '{type_id}'. Options: {list(PSYCHOTYPES)}")
    return Persona(id=type_id, name=name, summary=spec["summary"],
                   drives=list(spec["drives"]), bias=dict(spec["bias"]),
                   backstory=spec.get("backstory", ""), voice=spec.get("voice", ""),
                   quirk=spec.get("quirk", ""))


def _custom_path(path_str: str, name: str) -> Path:
    raw = path_str.strip()
    candidates: list[Path] = []
    if raw:
        rel = Path(raw)
        candidates.append((ROOT / rel).resolve())
        candidates.append((ROOT / "scenarios" / rel).resolve())

    slug = (raw or name).lower().replace(" ", "_")
    if not slug.endswith(".md"):
        slug = f"{slug}.md"
    candidates.append((ROOT / "scenarios" / "personas" / slug).resolve())

    for path in candidates:
        if path.exists():
            return path
    raise FileNotFoundError(
        "Custom persona file not found. Tried: "
        + ", ".join(str(p) for p in candidates)
    )


def _parse_custom_profile(text: str) -> tuple[str, list[str]]:
    summary_lines: list[str] = []
    drives: list[str] = []
    in_drives = False

    for raw in text.splitlines():
        line = raw.strip()
        low = line.lower().rstrip(":")
        if low == "drives":
            in_drives = True
            continue
        if in_drives:
            if line.startswith("#") or low in ("bio", "biography", "summary"):
                in_drives = False
            elif line.startswith("- "):
                drives.append(line[2:].strip())
                continue
            elif line:
                drives.extend(p.strip() for p in line.split(",") if p.strip())
                continue
        if line:
            summary_lines.append(line)

    return " ".join(summary_lines).strip(), drives


def _from_custom(path_str: str, name: str) -> Persona:
    path = _custom_path(path_str, name)
    text = path.read_text(encoding="utf-8").strip()
    summary, drives = _parse_custom_profile(text)
    return Persona(id=f"custom:{path.stem}", name=name, summary=summary or text,
                   drives=drives or ["survive", "find a way to escape"],
                   bias={"cooperation": 0.5, "sociability": 0.5, "industry": 0.5, "risk": 0.5})


def _scenario_brief(scenario: dict | None) -> str:
    if not scenario:
        return "unknown survival scenario"
    needs = ", ".join(scenario.get("physiology", {}).keys()) or "survival"
    resources = ", ".join(r.get("kind", "") for r in scenario.get("resources", []))
    escape = scenario.get("escape", {}).get("action", "escape")
    return f"{scenario.get('name', 'world')}; needs: {needs}; resources: {resources}; escape: {escape}"


def _self_select(name: str, rng: random.Random, scenario: dict | None) -> Persona:
    """Draft self-selection from the scenario brief, without an extra LLM call."""
    stats = set((scenario or {}).get("physiology", {}).keys())
    if "oxygen" in stats:
        pool = ["engineer", "leader", "skeptic", "loner", "diplomat"]
    elif "warmth" in stats:
        pool = ["caregiver", "leader", "diplomat", "engineer", "panicker"]
    else:
        pool = list(PSYCHOTYPES)
    type_id = rng.choice(pool)
    p = _from_library(type_id, name)
    p.id = f"self_select:{type_id}"
    p.summary = (
        f"After hearing the scenario brief ({_scenario_brief(scenario)}), {name} "
        f"self-selected the {type_id} role. {p.summary}"
    )
    if "find a way to escape" not in p.drives:
        p.drives.append("find a way to escape")
    return p


def load_persona(ref: str, name: str, rng: random.Random,
                 scenario: dict | None = None) -> Persona:
    """ref forms: 'blank' | 'library:<type>' | 'custom:<relpath>' | 'self_select'."""
    if ref == "blank" or ref == "":
        return _blank(name)
    if ref == "self_select":
        return _self_select(name, rng, scenario)
    mode, _, arg = ref.partition(":")
    if mode == "library":
        return _from_library(arg, name)
    if mode == "custom":
        return _from_custom(arg, name)
    raise ValueError(f"Unknown persona ref '{ref}'")
