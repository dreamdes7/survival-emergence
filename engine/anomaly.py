"""Anomaly subsystem — mystery objects that drive dread, percepts and ritual.

The TRUTH of each anomaly lives only here. Agents receive ambiguous PERCEPTS
(sensations, not facts), form their own beliefs, and act through the anomaly
tools. The meaning — religion, ritual, taboo, schism — is the emergent output
we measure, never authored.
"""
from __future__ import annotations
from engine.models import Structure, chebyshev

ANOMALY_KINDS = ["hatch", "monolith", "idol", "whisperzone", "relic"]

# First-impression percept when an anomaly MANIFESTS across the whole island.
_MANIFEST = {
    "hatch":      "глухой механический гул прокатился по острову",
    "monolith":   "низкий гул прошёл сквозь землю, аж свело зубы",
    "idol":       "по острову пронёсся протяжный, нечеловеческий стон",
    "whisperzone": "ветер донёс обрывки шёпота, которых никто не произносил",
    "relic":      "что-то тихо позвало — будто издалека, прямо в голове",
}

_CLOSE_LOOK = {
    "hatch":      "тяжёлый железный люк, изнутри гул и слабый свет в щели",
    "monolith":   "чёрный монолит в чужих знаках; вблизи кружится голова",
    "idol":       "древний идол со слишком многими глазами; воздух густеет",
    "whisperzone": "круг камней, между ними стелется шёпот и холодный туман",
    "relic":      "тёмная статуэтка с тусклым свечением — так и тянет взять",
}


def _bearing(agent, s) -> str:
    dx, dy = s.x - agent.x, s.y - agent.y
    ns = "на севере" if dy < -3 else "на юге" if dy > 3 else ""
    ew = "на западе" if dx < -3 else "на востоке" if dx > 3 else ""
    if ns and ew:
        return f"{ns.split()[1]}-{ew}"
    return ns or ew or "где-то совсем рядом"


def place_anomaly(world, kind: str | None) -> Structure | None:
    """Seed ONE anomaly far from camp. kind: a name, 'random', or 'none'."""
    world.anomaly = None
    if not kind or kind in ("none", ""):
        return None
    if kind == "random":
        kind = world.rng.choice(ANOMALY_KINDS)
    if kind not in ANOMALY_KINDS:
        return None
    cx, cy = world.camp_center
    far = [p for p in world._land if chebyshev(cx, cy, p[0], p[1]) >= world.size // 3]
    x, y = world.rng.choice(far or world._land)
    state = {"kind": kind,
             "manifest_every": world.day_length_ticks * 2,
             "next_manifest": world.day_length_ticks // 2,
             "engaged_tick": world.tick}      # last time anyone engaged it
    if kind == "hatch":
        state.update({"period": 8, "countdown": 8, "missed": 0, "pressed": 0})
    s = Structure(id=f"anomaly_{kind}", kind=kind, x=x, y=y, role="anomaly", state=state)
    world.structures.append(s)
    world.anomaly = s
    return s


def close_look(kind: str) -> str:
    return _CLOSE_LOOK.get(kind, "нечто непостижимое")


def anomaly_tick(world) -> None:
    """Per-tick: sticky dread, escalating manifestations, hatch ritual.

    Dread is a FELT need, not flavour: it lingers, climbs the longer the anomaly
    is ignored, and costs morale/energy — so passively waiting it out stops working.
    Relief comes only from acting on it (investigate / offer / press) or huddling
    together. Where to go and what to do stays the agent's choice — no scripting.
    """
    s = getattr(world, "anomaly", None)
    if s is None:
        return
    st = s.state
    dl = world.day_length_ticks
    ignored = max(0, world.tick - st.get("engaged_tick", 0))
    intensity = 1.0 + min(2.0, ignored / (dl * 2))     # 1x..3x as neglect grows
    living = world.living_agents()

    # 1) DREAD — rises near it, fades slowly elsewhere, eased by company.
    for a in living:
        d = chebyshev(a.x, a.y, s.x, s.y)
        allies = sum(1 for o in living if o is not a and chebyshev(a.x, a.y, o.x, o.y) <= 2)
        cur = getattr(a, "dread", 0.0)
        if d <= 1:
            cur += 5.0
        elif d <= 4:
            cur += 2.5
        else:
            cur -= 0.6                                   # sticky: barely fades on its own
        if allies >= 2:
            cur -= 2.0                                   # safety in numbers — huddling soothes
        a.dread = max(0.0, min(100.0, cur))
        # unresolved fear has teeth — but only via morale (non-lethal) + a frayed
        # mind. Dread compels action through misery, it doesn't kill on its own.
        if a.dread > 60 and world.rng.random() < 0.18:
            a.memory.add(world.tick, world.day, "observation", world.rng.choice([
                "краем глаза я заметил движение — но там никого",
                "мне послышался голос, звавший меня по имени",
                "тени легли не так, как должны",
            ]), 1.8)
        if "morale" in a.physiology:
            if a.dread > 70:
                a.physiology["morale"] = max(0.0, a.physiology["morale"] - 1.2)
            elif a.dread > 40:
                a.physiology["morale"] = max(0.0, a.physiology["morale"] - 0.6)

    # 2) MANIFESTATION — louder and more frequent the longer it is ignored.
    st["next_manifest"] = st.get("next_manifest", 6) - 1
    if st["next_manifest"] <= 0:
        st["next_manifest"] = max(6, int(st.get("manifest_every", dl * 2) / intensity))
        text = _MANIFEST.get(st["kind"], "что-то странное огласило остров")
        spike = 12.0 + 8.0 * intensity
        for a in living:
            a.memory.add(world.tick, world.day, "observation",
                         f"{text} — {_bearing(a, s)}", 2.6)
            a.dread = min(100.0, getattr(a, "dread", 0.0) + spike)
        world.log_event("anomaly", text[0].upper() + text[1:], 2.7, [])

    # 3) HATCH RITUAL — a countdown someone must reset; neglect turns omens real.
    if st["kind"] == "hatch":
        st["countdown"] = st.get("countdown", st.get("period", 8)) - 1
        if st["countdown"] in (2, 1):
            for a in living:
                if chebyshev(a.x, a.y, s.x, s.y) <= 6:
                    a.memory.add(world.tick, world.day, "observation",
                                 "из люка нарастает тревожный сигнал, всё быстрее", 2.2)
        if st["countdown"] <= 0:
            st["missed"] = st.get("missed", 0) + 1
            st["countdown"] = st.get("period", 8)
            # Ambiguous early (faith vs doubt), near-certain once long neglected.
            prob = min(0.85, 0.35 + ignored / (dl * 3))
            if world.rng.random() < prob:
                world.log_event("anomaly", "Остров содрогнулся — будто что-то сорвалось", 2.8, [])
                for a in living:
                    if "morale" in a.physiology:
                        a.physiology["morale"] = max(0.0, a.physiology["morale"] - 6)
                    if "energy" in a.physiology:
                        a.physiology["energy"] = max(0.0, a.physiology["energy"] - 5)
                    a.dread = min(100.0, getattr(a, "dread", 0.0) + 12)
                # a felt, perceivable loss the group can pin on the hatch
                if world.rng.random() < 0.4:
                    victim = world.rng.choice(living)
                    if victim.inventory:
                        item = world.rng.choice(list(victim.inventory))
                        del victim.inventory[item]
                        victim.memory.add(world.tick, world.day, "observation",
                                          f"к утру мои припасы ({item}) исчезли", 2.5)
