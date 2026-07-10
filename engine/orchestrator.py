"""Top-level simulation loop. Run headless:

    python -m engine.orchestrator
    python -m engine.orchestrator --scenario island --days 3 --agents 6
"""
from __future__ import annotations
import argparse
import re
import sys
import time
from pathlib import Path

import yaml

from engine.world import World
from engine.models import chebyshev
from engine.events import EventScheduler
from agents.runtime import Agent
from agents.persona import PSYCHOTYPES, load_persona
from llm.stub import HeuristicLLM
from llm.router import LLMRouter
from llm.openrouter import OpenRouterLLM, BudgetTracker

ROOT = Path(__file__).resolve().parent.parent

STAT_LETTER = {"hunger": "H", "thirst": "T", "energy": "E", "oxygen": "O", "warmth": "W"}


# ── config loading ────────────────────────────────────────────────────────────
def load_config(overrides: dict) -> tuple[dict, dict]:
    cfg = yaml.safe_load((ROOT / "config" / "world.yaml").read_text(encoding="utf-8"))
    if overrides.get("scenario"):
        cfg["scenario"] = overrides["scenario"]
    if overrides.get("days"):
        cfg["sim"]["max_days"] = overrides["days"]
    if overrides.get("ticks"):
        cfg["sim"]["max_ticks_override"] = overrides["ticks"]
    # Per-agent roster (pre-game model per agent). When provided it defines the
    # agents and their individual models; the global model is cleared so each
    # agent's own model applies.
    if overrides.get("roster"):
        roster = []
        for i, r in enumerate(overrides["roster"]):
            roster.append({"name": (r.get("name") or f"Агент{i + 1}").strip(),
                           "model": (r.get("model") or "stub").strip(),
                           "gender": r.get("gender")})
        cfg["agents"]["roster"] = roster
        cfg["agents"]["count"] = len(roster)
        cfg["agents"]["model_override"] = None
    if overrides.get("agents"):
        cfg["agents"]["count"] = overrides["agents"]
    if overrides.get("seed") is not None:
        cfg["seed"] = overrides["seed"]
    # Global model: non-empty -> every agent uses it; explicit empty -> per-agent.
    gm = overrides.get("model")
    if gm:
        cfg["agents"]["model_override"] = gm
    elif gm == "":
        cfg["agents"]["model_override"] = None
    if overrides.get("api_tick_seconds") is not None:
        cfg["sim"]["api_tick_seconds"] = overrides["api_tick_seconds"]
    if overrides.get("usd_cap") is not None:
        cfg["budget"]["usd_cap"] = overrides["usd_cap"]
    if overrides.get("tokens_per_agent_tick") is not None:
        cfg["budget"]["context_tokens_per_agent_tick"] = overrides["tokens_per_agent_tick"]
    if overrides.get("context_tokens_per_agent_tick") is not None:
        cfg["budget"]["context_tokens_per_agent_tick"] = overrides["context_tokens_per_agent_tick"]
    if overrides.get("max_output_tokens") is not None:
        cfg["budget"]["max_output_tokens"] = overrides["max_output_tokens"]
    if overrides.get("provider"):
        cfg["provider"] = overrides["provider"]
    # Research knobs — the levers that decide who authors behaviour.
    if overrides.get("persona_mode"):
        cfg["agents"]["persona_mode"] = overrides["persona_mode"]
    if overrides.get("emergency_multiplier") is not None:
        cfg["sim"]["emergency_multiplier"] = overrides["emergency_multiplier"]
    if overrides.get("fallback_policy"):
        cfg.setdefault("llm", {})["fallback_policy"] = overrides["fallback_policy"]
    if overrides.get("thinking"):
        cfg.setdefault("llm", {})["thinking"] = overrides["thinking"]
    if overrides.get("tom_probe_every") is not None:
        cfg.setdefault("research", {})["tom_probe_every"] = overrides["tom_probe_every"]
    scenario = yaml.safe_load(
        (ROOT / "scenarios" / f"{cfg['scenario']}.yaml").read_text(encoding="utf-8"))
    return cfg, scenario


def _default_persona_ref(mode: str, name: str, rng) -> str:
    if mode == "blank":
        return "blank"
    if mode == "library":
        return f"library:{rng.choice(list(PSYCHOTYPES))}"
    if mode == "custom":
        return f"custom:personas/{name.lower().replace(' ', '_')}.md"
    if mode == "self_select":
        return "self_select"
    if mode == "mixed":
        return "self_select"
    raise ValueError("Unknown persona_mode "
                     f"'{mode}'. Options: library, custom, self_select, mixed")


def _persona_ref(entry: dict, mode: str, rng, name: str = "agent") -> str:
    explicit = entry.get("persona")
    if explicit:
        return explicit
    return _default_persona_ref(mode, entry.get("name") or name, rng)


def _normalize_gender(value) -> str | None:
    raw = str(value or "").strip().lower()
    if raw in ("female", "f", "woman", "girl", "ж", "жен", "женщина"):
        return "female"
    if raw in ("male", "m", "man", "boy", "м", "муж", "мужчина"):
        return "male"
    return None


def _balanced_genders(count: int, rng) -> list[str]:
    genders = ["female"] * (count // 2) + ["male"] * (count // 2)
    if count % 2:
        genders.append("female" if rng.random() < 0.5 else "male")
    rng.shuffle(genders)
    return genders


def spawn_agents(world: World, cfg: dict) -> None:
    roster = list(cfg["agents"].get("roster", []))
    count = int(cfg["agents"]["count"])
    persona_mode = cfg["agents"].get("persona_mode", "library")
    phys_start = {s: float(v.get("start", 100)) for s, v in world.scenario["physiology"].items()}
    psyche_start = {s: float(v.get("start", 50)) for s, v in world.scenario.get("psyche", {}).items()}

    while len(roster) < count:
        name = f"Выживший{len(roster)+1}"
        roster.append({"name": name, "persona": _default_persona_ref(persona_mode, name, world.rng),
                       "model": "stub"})
    roster = roster[:count]
    balanced_genders = _balanced_genders(count, world.rng)

    model_override = cfg["agents"].get("model_override")
    for i, entry in enumerate(roster):
        # No explicit name -> a placeholder that resolve_names() will replace.
        name = (entry.get("name") or f"Агент{i + 1}").strip() or f"Агент{i + 1}"
        ref = _persona_ref(entry, persona_mode, world.rng, name)
        persona = load_persona(ref, name, world.rng, world.scenario)
        x, y = world.agent_spawn_tile()
        model = model_override or entry.get("model", "stub")
        gender = _normalize_gender(entry.get("gender")) or balanced_genders[i]
        agent = Agent(agent_id=f"A{i}", name=name, persona=persona,
                      model=model, x=x, y=y,
                      physiology=phys_start, world_size=world.size,
                      gender=gender, psyche=psyche_start)
        # Fog of war: each agent spawns knowing only their home sector.
        # Structures near camp + critical survival/goal structures are always revealed.
        # A vital safety-net guarantees the N nearest water+food nodes are known
        # so nobody dies blind on tick 1.
        fog = cfg.get("sim", {}).get("fog", {})
        home_radius = int(fog.get("home_radius", 8))
        reveal_roles = set(fog.get("reveal_roles", ["escape", "refill_oxygen"]))
        vital_guarantee = int(fog.get("vital_guarantee", 2))

        cx, cy = world.camp_center
        agent.known_structures = {
            s.id: s for s in world.structures
            if chebyshev(cx, cy, s.x, s.y) <= world.camp_radius + 2
            or s.role in reveal_roles
        }
        agent.known_nodes = {
            n.id: n for n in world.nodes
            if chebyshev(x, y, n.x, n.y) <= home_radius
        }
        # Safety net: always know the N nearest water and food nodes.
        for vital_item in ({"water"}, {"food", "coconut", "berries", "fruit", "fish"}):
            vital_sorted = sorted(
                (n for n in world.nodes if n.yield_item in vital_item),
                key=lambda n: chebyshev(x, y, n.x, n.y),
            )
            for n in vital_sorted[:vital_guarantee]:
                agent.known_nodes[n.id] = n
        world.agents.append(agent)


# Fallback name pool (stub agents / no API / exhausted preferences).
NAME_POOL = [
    "Аня", "Борис", "Вера", "Глеб", "Даша", "Егор", "Женя", "Зоя", "Илья", "Кира",
    "Лёня", "Маша", "Ника", "Олег", "Паша", "Рита", "Саша", "Таня", "Ульяна", "Федя",
    "Юля", "Яна", "Мирон", "Лада", "Назар", "Арина", "Семён", "Полина", "Тимур", "Лиза",
    "Вадим", "Надя", "Роман", "Соня", "Костя", "Мила", "Денис", "Оля", "Руслан", "Вика",
]

NAME_POOLS = {
    "female": [
        "Аня", "Вера", "Даша", "Зоя", "Кира", "Маша", "Рита", "Таня", "Ульяна", "Юля",
        "Яна", "Лада", "Арина", "Полина", "Лиза", "Надя", "Соня", "Мила", "Оля", "Вика",
        "Катя", "Ира", "Алёна", "Марина", "Света", "Лера", "Ася", "Тамара", "Лена", "Галя",
    ],
    "male": [
        "Борис", "Глеб", "Егор", "Илья", "Лёня", "Олег", "Паша", "Федя", "Мирон", "Назар",
        "Семён", "Тимур", "Вадим", "Роман", "Костя", "Денис", "Руслан", "Артём", "Кирилл",
        "Максим", "Никита", "Матвей", "Сергей", "Дима", "Андрей", "Иван", "Пётр", "Валера",
        "Стас", "Миша",
    ],
}
NAME_POOL = NAME_POOLS["female"] + NAME_POOLS["male"]


def _placeholder_name(name: str) -> bool:
    """True for auto-generated names like 'Агент6' / 'Выживший3' / blank."""
    return (not name) or re.match(
        r"(?i)^(agent|survivor|агент|выживший)\d+$", name.strip()
    ) is not None


def _looks_russian_name(name: str) -> bool:
    return bool(re.search(r"[А-Яа-яЁё]", name))


def _name_pool_for(gender: str) -> list[str]:
    return NAME_POOLS.get(gender, NAME_POOL)


def _fallback_name(gender: str, index: int) -> str:
    prefix = "Выжившая" if gender == "female" else "Выживший"
    return f"{prefix}{index}"


def resolve_names(world: World, llm, scenario: dict) -> None:
    """Agents with placeholder names choose their own. Each proposes 5 preferred
    names (LLM on a real model, else the pool); a greedy pass assigns the highest
    preference still free so names never collide — no more Agent6 / Agent7."""
    taken = {a.name for a in world.agents if not _placeholder_name(a.name)}
    openrouter = getattr(llm, "openrouter", None)
    for a in world.agents:
        if not _placeholder_name(a.name):
            continue
        prefs: list[str] = []
        gender = getattr(a, "gender", "unspecified")
        if openrouter is not None and a.model != "stub":
            prefs = openrouter.propose_names(a.model, scenario.get("name", ""), gender)
            prefs = [p for p in prefs if _looks_russian_name(p)]
        avail = [p for p in _name_pool_for(gender) if p not in taken]
        if not avail:
            avail = [p for p in NAME_POOL if p not in taken]
        world.rng.shuffle(avail)
        if not prefs:
            prefs = avail[:5]
        chosen = next((p for p in prefs if p and p not in taken), None)
        if chosen is None:
            chosen = avail[0] if avail else _fallback_name(gender, len(taken) + 1)
        taken.add(chosen)
        a.name = chosen


def build_llm(world: World, cfg: dict):
    """Stub-only -> no API. Any real model -> HTTP LLM provider (key required)."""
    stub = HeuristicLLM()
    if all(a.model == "stub" for a in world.agents):
        return LLMRouter(stub)
    budget_cfg = cfg.get("budget", {})
    llm_cfg = cfg.get("llm", {})
    budget = BudgetTracker(usd_cap=float(budget_cfg.get("usd_cap", 0) or 0))
    max_out = int(budget_cfg.get("max_output_tokens", 1024))
    provider = cfg.get("provider", "openrouter")
    seed = int(cfg["seed"]) if llm_cfg.get("seed_requests", True) else None
    try:
        client = OpenRouterLLM(
            fallback=stub,
            budget=budget,
            max_tokens=max_out,
            temperature=float(llm_cfg.get("temperature", 0.85)),
            context_tokens=int(budget_cfg.get("context_tokens_per_agent_tick", 32000)),
            provider=provider,
            seed=seed,
            thinking=str(llm_cfg.get("thinking", "full")),
            deliberate_every=int(llm_cfg.get("deliberate_every", 12)),
        )
    except RuntimeError as exc:
        print(f"[warn] {exc}; using stub fallback until a key is configured.")
        return LLMRouter(stub)
    return LLMRouter(stub, client)


def apply_runtime_policy(world: World, cfg: dict) -> None:
    """Push the decision-authorship knobs from config onto the live world so the
    runtime (emergency gate, fallback policy, scenes, dreams) reads them per tick."""
    sim = cfg.get("sim", {})
    llm_cfg = cfg.get("llm", {})
    world.emergency_multiplier = float(sim.get("emergency_multiplier", 1.3))
    world.fallback_policy = str(llm_cfg.get("fallback_policy", "stub"))
    world.dialogue_scene_lines = int(sim.get("dialogue_scene_lines", 4))
    world.dreams_enabled = bool(llm_cfg.get("dreams", True))


def build_narrator(world: World, cfg: dict, llm):
    """Create the saga narrator when it can actually speak: needs enabled=true and
    a real model (explicit narrator.model, else the first real agent's). Stub-only
    worlds get None — the free world stays free."""
    ncfg = cfg.get("narrator", {})
    if not ncfg.get("enabled", False):
        return None
    model = str(ncfg.get("model") or "").strip()
    if not model:
        model = next((a.model for a in world.agents if a.model != "stub"), "")
    if not model:
        return None
    client = getattr(llm, "openrouter", None)
    if client is None:
        try:
            client = OpenRouterLLM(fallback=HeuristicLLM(),
                                   provider=cfg.get("provider", "openrouter"))
        except RuntimeError:
            return None
    from engine.narrator import Narrator
    return Narrator(client, model, int(ncfg.get("every_ticks", 12)))


def build_recorder(world: World, cfg: dict, scenario: dict, run_id: str | None = None):
    """Create a RunRecorder when research.record is on, else None. Attaches it to
    the world so tools/agents/LLM emit into it automatically. Pass `run_id` to
    share the canonical id with the session log."""
    from engine.event_log import RunRecorder
    research = cfg.get("research", {})
    if not research.get("record", True):
        return None
    rec = RunRecorder(
        world, cfg, scenario, run_id=run_id,
        log_llm=bool(research.get("log_llm", True)),
        taint_threshold=float(research.get("taint_threshold", 0.20)),
    )
    world.recorder = rec
    return rec


# ── logging ───────────────────────────────────────────────────────────────────
def stats_str(agent: Agent) -> str:
    return " ".join(f"{STAT_LETTER.get(s, s[0].upper())}{v:.0f}"
                    for s, v in agent.physiology.items())


def run(overrides: dict) -> None:
    cfg, scenario = load_config(overrides)
    run_config(cfg, scenario)


def advance_tick(world, llm, events, t: int, reflect_every: int,
                 reflect_with_llm: bool):
    """One deterministic simulation tick — the SINGLE source of truth for the
    per-tick body, shared by run_config and the counterfactual fork engine so a
    fork reproduces a run's RNG bit-for-bit. Returns (fired_event, steps,
    notices) where steps is a list of (agent, decision, result) for the caller
    to print/inspect. Anything that consumes world.rng lives here and NOWHERE
    else in a run loop."""
    world.tick = t
    world.begin_tick()
    fired = events.maybe_fire()
    steps = []
    for agent in world.active_agents():
        decision, result = agent.step(world, llm)
        steps.append((agent, decision, result))
        if t % reflect_every == 0 and t > 0:
            agent.reflect(world, llm if reflect_with_llm else None)
    notices = world.end_tick()
    return fired, steps, notices


def run_config(cfg: dict, scenario: dict, *, quiet: bool = False):
    """Run a simulation from an already-resolved (cfg, scenario). Returns the
    RunRecorder (or None) so batch harnesses can read the manifest/provenance.
    `quiet` suppresses the per-tick console dump for batch runs."""
    sim = cfg["sim"]
    day_len = int(sim["day_length_ticks"])
    max_ticks = int(sim.get("max_ticks_override") or int(sim["max_days"]) * day_len)
    reflect_every = int(sim.get("reflect_every", 6))
    tick_seconds = float(sim.get("tick_seconds", 0))

    world = World(scenario, int(cfg["seed"]), day_len)
    world.move_speed = int(sim.get("move_speed", 1))
    spawn_agents(world, cfg)
    apply_runtime_policy(world, cfg)
    events = EventScheduler(world)
    llm = build_llm(world, cfg)
    resolve_names(world, llm, scenario)
    from engine.session_log import new_run_id
    run_id = new_run_id(scenario, cfg)
    recorder = build_recorder(world, cfg, scenario, run_id=run_id)
    narrator = build_narrator(world, cfg, llm)
    reflect_with_llm = bool(cfg.get("llm", {}).get("reflect_with_llm", True))

    def say(*a):
        if not quiet:
            print(*a)

    say("=" * 78)
    say(f"  SURVIVAL EMERGENCE -- scenario: {scenario['name']}  | seed: {cfg['seed']}")
    say(f"  RUN ID: {run_id}   (pass this to review the run: logs/runs/{run_id}/)")
    say(f"  agents: {len(world.agents)}  | map: {world.size}x{world.size}  | "
        f"{sim['max_days']} days x {day_len} ticks")
    say("  roster: " + ", ".join(
        f"{a.name}[{a.persona.id.split(':')[-1]}|{a.model}]" for a in world.agents))
    say("=" * 78)

    for t in range(max_ticks):
        fired, steps, notices = advance_tick(
            world, llm, events, t, reflect_every, reflect_with_llm)

        phase = "night" if world.is_night else "day"
        wx = f" weather={world.weather}" if world.weather else ""
        say(f"\n[D{world.day} T{t % day_len:02d} {phase}{wx}]")
        if fired:
            say(f"   ** a {fired} begins **")
        for agent, decision, result in steps:
            say(f"   {agent.name:<10} ({agent.x:2d},{agent.y:2d}) {stats_str(agent):<28} "
                f"| [{decision.get('_source','?')}] {decision['tool']}: {result}")
            if t % reflect_every == 0 and t > 0:
                say(f"   {'':<10} diary: {agent.memory.diary[-1][1]}")
        for notice in notices:
            say(f"   !! {notice}")

        if narrator is not None and t > 0:
            fragment = narrator.maybe_tick(world)
            if fragment:
                say(f"   📜 {fragment}")

        tom_every = int(cfg.get("research", {}).get("tom_probe_every", 0) or 0)
        if (tom_every and t > 0 and t % tom_every == 0
                and getattr(llm, "openrouter", None) is not None):
            from engine.probes import run_tom_probes
            for r in run_tom_probes(world, llm.openrouter):
                say(f"   🧩 ToM {r['agent']}: {r['accuracy']:.0%}")

        if recorder is not None:
            recorder.tick_metrics(world)

        if world.escaped:
            say(f"\n>>> ESCAPE! {world.escape_winner.name} completed "
                f"{scenario['escape']['action']} on D{world.day} T{t % day_len}")
            break
        if not world.active_agents() and not world.living_agents():
            say("\n>>> Everyone has perished.")
            break
        # LLM outage fail-safe (headless): if every recent decide() died on an API
        # error, ABORT loudly — a run of silent fallbacks is worthless data.
        client = getattr(llm, "openrouter", None)
        if client is not None and getattr(client, "consecutive_failures", 0) >= \
                max(4, 2 * len(world.living_agents())):
            print(f"\n>>> ⛔ LLM API DOWN ({getattr(client, 'last_api_error', '?')}) — "
                  f"aborting the run at tick {t}: agents were degrading into "
                  f"silent fallbacks. Fix the key/balance and rerun.")
            break
        if tick_seconds:
            time.sleep(tick_seconds)

    if recorder is not None:
        recorder.close(world)
        client = getattr(llm, "openrouter", None)
        if client is not None:
            b = client.budget
            recorder.add_meta(llm_usage={
                "calls": b.calls, "prompt_tokens": b.prompt_tokens,
                "completion_tokens": b.completion_tokens, "cost_usd": round(b.cost, 4),
            })
    if not quiet:
        _summary(world, llm, recorder)
    return recorder


def _summary(world: World, llm=None, recorder=None) -> None:
    print("\n" + "=" * 78)
    print("  SIMULATION SUMMARY")
    print("=" * 78)
    alive = world.living_agents()
    dead = [a for a in world.agents if a.status == "dead"]
    print(f"  ticks run        : {world.tick + 1}")
    print(f"  escaped          : {world.escaped} "
          f"({world.escape_winner.name if world.escape_winner else '-'})")
    print(f"  escape progress  : {world.escape_progress:.0f}")
    print(f"  survivors        : {len(alive)}/{len(world.agents)}")
    if dead:
        print(f"  perished         : {', '.join(a.name for a in dead)}")
    print("  final state:")
    for a in world.agents:
        inv = ", ".join(f"{k}:{v:.0f}" for k, v in a.inventory.items()) or "empty"
        allies = sum(1 for r in a.relationships.rel.values() if r.label == "ally")
        rivals = sum(1 for r in a.relationships.rel.values() if r.label == "rival")
        print(f"   {a.name:<10} [{a.status:<13}] {stats_str(a):<28} "
              f"inv: {inv:<22} allies:{allies} rivals:{rivals}")
    print("\n  sample diaries:")
    for a in world.agents:
        if a.memory.diary:
            print(f"   {a.name}: {a.memory.diary[-1][1]}")
    if llm is not None and getattr(llm, "openrouter", None) is not None:
        print(f"\n  llm usage        : {llm.openrouter.budget.summary()}")
    if recorder is not None:
        contam = recorder.contamination()
        print(f"\n  RUN ID           : {recorder.run_id}   ← copy this to review the run")
        print(f"  run dir          : {recorder.dir}")
        print(f"  decisions        : {contam['total']} "
              f"(heuristic share {contam['heuristic_share']*100:.1f}%) "
              f"{'⚠ TAINTED' if recorder.meta.get('tainted') else ''}")
        print(f"  by source        : {contam['by_source']}")
    print("=" * 78)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", choices=["mars", "island"])
    ap.add_argument("--days", type=int)
    ap.add_argument("--ticks", type=int, help="Run exactly N ticks, overriding --days for smoke tests.")
    ap.add_argument("--agents", type=int)
    ap.add_argument("--seed", type=int)
    ap.add_argument("--model", help="OpenRouter model id for ALL agents "
                                    "(e.g. openai/gpt-4o-mini). Needs OPENROUTER_API_KEY.")
    args = ap.parse_args()
    run({"scenario": args.scenario, "days": args.days, "ticks": args.ticks, "agents": args.agents,
         "seed": args.seed, "model": args.model})


if __name__ == "__main__":
    sys.exit(main())
