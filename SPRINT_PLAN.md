# Sprint Plan — Social Mechanics + UI Redesign

Two sprints. **Sprint 1** = the social foundation (Steps 1–3, backend). **Sprint 2** = advanced social tools (Step 4) + the full glass/skeuo UI redesign. Split is ~8 vs ~10 half-days — back-loaded but logically clean: all must-precede plumbing lands in S1, and every new backend field in S2 is rendered in the same sprint it ships.

This plan was designed against the real code and adversarially reviewed. Two **blockers** and one **major** were found that must be handled or the mechanics silently don't fire — they're called out inline and listed in [§0](#0-prerequisites-fix-first).

---

## 0. Prerequisites (fix first)

These are not optional cleanup — without them the headline mechanics are dead code or the app won't boot.

### 🛑 BLOCKER B1 — Stub cooperation gate kills info-sharing in blank mode
**Verified in code.** Blank personas (`persona.py:111`) have *all* biases = `0.5`. The cooperative branch in `stub.py:77` is gated `if phys.b("cooperation") > 0.6` — strictly greater, so `0.5` never passes. The default config (`world.yaml`: `persona_mode: blank`, all-stub roster) is exactly this mode. **Result: `share_location` and relationship-steered sharing would never fire in the primary experimental mode.**

**Fix:** Decouple info-sharing from the `> 0.6` gate. Trigger `_maybe_inform` whenever an adjacent active agent is *missing a vital (water/food) node this agent knows* — teaching a starving neighbour is survival-rational, not a cooperation luxury. Gate it on the need condition + a modest `rng.random() < 0.5`, outside the `> 0.6` block. Same treatment for Step-4 `announce` (don't gate on "sociability is high" — never true at 0.5).

> **Acceptance gate for the whole effort:** a default blank+stub headless run must show `tool_usage['share_location'] > 0`, `tool_usage['announce'] > 0`, and `max(followers) >= 2`. If these are zero, the gating fix is incomplete — assert before claiming any emergence signal.

### 🛑 BLOCKER B2 — Deleting the inspector sections throws at boot
`agentEl` (`#agent-inspector`) and `memoryEl` (`#memory-inspector`) are grabbed with non-null `document.querySelector!` (`main.ts:107-108`) and written by **both** `renderAgent` and `renderStructure`. The redesign removes those `<section>`s. Remove them before repointing the refs and `querySelector!` returns `null` at module load → whole app throws.

**Fix (sequenced, not cleanup):** repoint `agentEl`/`memoryEl` to the new modal body nodes (or add new refs) **and** rehome `renderStructure` into the modal/compact card **first**, *then* delete the sections.

### ⚠️ MAJOR M1 — `say_to` will double-log recipient memory
`tools/core.py` `_exec_say_to` writes the recipient memory inline (`core.py:67`). Step 2 routes speech through `deliver()` → `_process_inbox` writes recipient memory again. **Delete `core.py:67`** when adding `deliver()`; keep only the sender memory. Add a test: one sender + one recipient memory per `say_to`.

---

## Cross-cutting foundation — the shared inbox (build once, in Sprint 1)

Everything social rides on one piece of plumbing. Build it first in Sprint 1, Steps 1 & 4 reuse it.

**On `Agent` (`agents/runtime.py __init__`):**
```python
self.inbox: list[dict] = []
self.following: str | None = None          # active in Step 4
self.known_hazards: dict[tuple[int,int], str] = {}   # active in Step 4
```

**`Agent.deliver(msg)`** — append to inbox, drop if dead, cap to last 20.

**`Agent._process_inbox(world)`** — called in `step()` **after `perceive()`, before `llm.decide()`** (so a message can change *this* tick's decision). Per message, exactly once, for all senders:
1. Write **one** memory event (`kind 'social'`, importance 1.6–2.0) from `msg['text']`.
2. Apply structured learning by `msg['type']` (location/speech → learn a live node; threat → `known_hazards`; announce → memory + optional rule keyword; follow_request → leader notification).
Clear inbox at the end.

**One canonical message schema for every sender:**
```python
{ "type": "speech"|"location"|"threat"|"announce"|"follow_request",
  "from": name, "from_id": id, "text": str, "payload": dict }
```

**`World` helpers (`engine/world.py`):** `node_by_id(id)` and `node_at(x,y)` → live node objects (quantity stays in sync, matching `perceive()` reference semantics).

**Inbox vs inline rule:** `say_to`, `share_location`, `warn`, `announce`, `follow` deliver through the inbox (the recipient perceives them). Physical co-located acts (`give`, `hug`, `comfort`, `insult`) keep writing recipient memory inline and do **not** use the inbox. *(Explicit so nobody over-converts `give`.)*

---

## SPRINT 1 — Social foundation (Steps 1–3, backend) · ~8 half-days

**Build order inside the sprint: inbox plumbing → Step 2 → Step 1 → Step 3.** Step 2's inbox is what Step 1's `share_location` delivery and Step 3's affinity reads depend on.

Ship the serialize additions for all three steps in Sprint 1 even though no UI consumes them yet (Sprint 2's overlays read them).

### Step 2 — Speech feedback loop (3 half-days) · *build first*
Make `say_to` actually reach the recipient via the inbox; the recipient learns from it.
- `tools/core.py _exec_say_to`: replace inline recipient `memory.add` with `other.deliver({type:'speech', ...})`. **Delete the old inline write (M1).**
- `_process_inbox`: `type=='location'` → resolve `payload['node_id']` via `node_by_id`, add live node to `known_nodes` (*"learned {kind} location from {from}"*, imp 1.8). `type=='speech'` → regex-scan `r'(\w+)\s+at\s+\((\d+),\s*(\d+)\)'`, confirm via `node_at(x,y)` before learning (guards hallucinated coords).
- **Emergence:** knowledge propagates agent→agent→agent (teaching, rumor, even misinformation). Talking stops being a dead-end monologue.
- **Signal:** memory entries matching `/learned .* location from/` > 0; recipient `known_nodes` grows within 1 tick of a coordinate message; exactly one sender + one recipient memory per `say_to`.

### Step 1 — Fog of war + `share_location` (3 half-days)
Each agent spawns knowing only its home sector + the vital safety net; exploration becomes tradeable.
- `orchestrator.py spawn_agents`: replace broad seeding. `known_nodes` = nodes within `home_radius` (default 8) of spawn. `known_structures` = camp structures + `reveal_roles` (default `{escape, refill_oxygen}` so runs stay completable). **Keep the existing 2-nearest-water + 2-nearest-food guarantee verbatim** (the safety net we already added).
- New config block `sim.fog: { home_radius: 8, reveal_roles: [escape, refill_oxygen], vital_guarantee: 2 }`, all defaulted in code so existing configs keep running.
- **New tool `share_location(target, node_id)`** (`tools/social.py`): adjacency-guarded; delivers a `location` message; nudges affinity (+0.08 / +0.10 reciprocal). Available when `known_nodes` non-empty AND an adjacent active agent exists.
- Stub: `_maybe_inform` — if an adjacent agent is missing a vital node this agent knows, share it. **Per B1, gate on the need condition, NOT `cooperation > 0.6`.**
- Serialize: per-agent `known_nodes` / `known_structures` id arrays (fog overlay reads them in S2).
- **Emergence:** exploration = private capital → first real reason to interact; a scout/cartographer role can emerge; info-gifts seed the trust graph Step 3 uses.
- **Signal:** at tick 0, `stdev(len(known_nodes)) > 0` and `mean < 0.5 * len(nodes)` (real asymmetry); over a run `tool_usage['share_location'] > 0` and exploration coverage rises.
- ⚠️ *minor:* clustered spawns (`camp_radius+3`) with `home_radius=8` weaken tick-0 asymmetry — validate the stdev/mean signal on the real default map; consider `home_radius ~4–5` or sector-spread spawns behind a flag.

### Step 3 — Relationships steer the stub (2 half-days)
Heuristic acts on the emergent relationship graph; stays blank-slate (allies form only from interaction).
- `stub.py _maybe_share`: prefer starving **allies**; skip **rivals**; sort by `(label=='ally', affinity, -need)`. Give your last unit to a starving ally.
- `stub.py _preferred_social_target` (new): score others by `affinity*2 - 0.1*dist`; tone messages by label (warm/neutral/terse).
- `stub.py decide`: add `_maybe_regroup` (prob `coop*0.4`) — move toward a best-affinity ally who's not adjacent.
- `agents/social.py`: `best_ally(min_aff=0.4)` / `is_rival(id)` helpers.
- Serialize: per-agent `best_ally: name|null`; add per-pair `relationships: [{id,name,label,score}]` (needed by the S2 modal + affinity links). Bump `diary` from `[-3:]` to `[-12:]` for the modal.
- **Emergence:** gifting → affinity → preferential sharing/regrouping → in-groups/factions cluster and pool; rivals get frozen out → visible inequality, substrate for leadership & norms.
- **Signal:** fraction of gifts to allies rises above random baseline; rivals get ~0 gifts; mean pairwise distance between allies falls (clustering).
- ⚠️ Keep rival exclusion **soft** (deprioritise, don't hard-ban) to avoid ostracism wipes.

### Sprint 1 exit criteria
Default blank+stub headless run asserts: `share_location > 0`; `/learned .* location from/ > 0`; one-sender-one-recipient per `say_to`; ally-gift fraction above baseline. Serialize carries `known_nodes`, `known_structures`, `best_ally`, relationship names, diary[-12:] (even though UI is S2).

---

## SPRINT 2 — Step 4 tools + UI redesign · ~10 half-days

**Build order: Step-4 backend first** (so `claims`/`following`/`followers` serialize fields exist), then the UI overlays that render them, then the glass/skeuo restyle and the character modal.

### Step 4 — follow / warn / claim / announce (5 half-days)
Four tools unlocking leadership, altruism, property/conflict/norms, group address. All route through the inbox.
| Tool | File | Effect | Emergence |
|---|---|---|---|
| `follow(target)` | social.py | sets `agent.following`; delivers `follow_request` | **leadership** — follower counts → de-facto leader (formalisable via `assign_role`) |
| `warn(target, threat)` | social.py | delivers `threat` → recipient `known_hazards` | **altruism** — pay a turn to protect another |
| `claim(node_id)` | social.py | writes `world.claims[node_id]` | **property/conflict** — trespass on gather dings affinity → rivalries, norms |
| `announce(message)` | governance.py | broadcasts to all within R=12 | **group coordination** — makes votes/norms reachable without adjacency |

- `world.py __init__`: `self.claims: dict[str,dict] = {}`.
- `survival.py _exec_gather`: if gathering a node claimed by another, record a trespass (affinity −0.12 / owner −0.15, owner memory). **Gather still succeeds** (advisory property — survival never blocked; conflict emerges from friction).
- `_process_inbox`: handle `threat` / `announce` / `follow_request`.
- Stub `decide` hooks: follow the most competent/connected neighbour (`allies + len(known_nodes)`); warn when you know a hazard a neighbour doesn't; claim a valuable unclaimed adjacent node (prob `(1-coop)*0.3`); **announce per B1 fix** (when you just learned an escape/vital node not yet shared, `rng < max(0.3, sociability)`). Movement avoids `known_hazards` (the warn payoff — must be wired or warn is inert).
- 🛡️ **follow-cycle guard (required, not an open question):** reject following an agent who already follows you (`other.following == agent.id`) to kill A↔B oscillation.
- Serialize: top-level `claims: [{node_id,owner_id,owner}]`; per-agent `following` + `followers` count.
- ⚠️ **Feed-kind mapping (major M2):** `runtime.step` only tags `say_to`→speech, `give`→social; the 5 new tools fall through to `kind='action'` and render as generic rows. Extend the kind map: `share_location/follow/warn/claim/hug/comfort/compliment/insult`→`social`, `announce`→`speech` (or new `gov`). Add the matching `FeedEntry` union member + CSS edge.
- **Signal:** `max(followers) >= 2`; `claims` non-empty + trespass → new rival edges; an `announce` precedes a vote/propose_rule spike; warned agents log fewer hazard-adjacency memories.

### UI redesign — glassmorphism + skeuomorphism (5 half-days)

**Design tokens (`styles.css :root`):** one source of truth — glass surfaces (`--glass-light/dark`, `--glass-blur`), skeuo bevels (`--bevel`, `--border-hi/lo`), shadow stacks (`--shadow-raise/well/modal/press`), control faces, bar fills. Accent `#2bd1c4` == the Pixi selection ring (keep canvas & DOM in sync). Add a `@supports not (backdrop-filter)` fallback bumping surface alpha to ~0.9 so non-supporting engines stay legible. Reusable `.glass` / `.glass-dark` utility recipe.

**A) Character card → modal (double-click an agent):**
- **Click disambiguation (the careful bit):** keep single-click select *immediate and intact*; add dblclick in the **same** `pointertap` handler (`main.ts ~564`) via a timestamp guard — `lastTap = {t, id}`; if `now - lastTap.t < 280 && same id` → `openAgentModal`. No 250ms penalty on selection.
- Modal lives over the whole shell (new `#char-modal` scrim, sibling of `#app`), **not** in the right column. Scrim (`--scrim` + blur, flex-center) holding a `.cc-card` (`--glass-light-strong`, `--backdrop-strong`, `--shadow-modal`, max 480px / 82vh).
- Sections: header (identity swatch + name + skeuo chips) · cognition (💭 thought / ▶ action / 💬 said) · physiology (reuse `statBar`) · inventory chips · goals · **relationships** (named allies/rivals from new serialize, count fallback) · scrollable diary.
- **Namespaced `.cc-*` classes** (`.agent-name`/`.line-item` already exist twice — will clash otherwise).
- **Live refresh:** track `modalAgentId`; each tick re-render via `textContent`/`width` on existing nodes (not `innerHTML`) and preserve diary `scrollTop` (no flicker/jump). Close via ×/scrim/Escape. Respect `prefers-reduced-motion`.
- ⚡ Perf: scrim blur runs over the live 60fps Pixi canvas — cap blur radius, `will-change`, consider dropping scrim blur (keep dark scrim) on low-end/while unpaused.

**B) Left log console (newest at bottom):**
- **Ordering fix is localized to `renderEvents()` (`main.ts ~1507`):** `world.feed` is already oldest→newest; **delete the `.reverse()`** on the feed line. `events` is newest-first (`unshift`) → use `events.slice(0,4).reverse()`. Concatenate `sys + feed` (both newest-at-bottom). Keep `.event-log` as flex column (**not** column-reverse — HTML order now matches visual).
- **Auto-scroll:** capture `atBottom` *before* writing innerHTML; only `scrollTop = scrollHeight` if the user was already near the bottom (don't yank scroll-back readers).
- Style: `.logpanel` → frosted dark glass console; each `.event` a tiny inset card with a per-kind accent left edge (speech→`--accent-2`, social→`--ok`, action→neutral, sys→`--accent-warm`); newest row gets a one-shot accent glow; top/bottom fade mask so the bottom reads as "live".

**C) Right panel (info/settings):**
- Character info is gone (→ modal). `.inspector` grid `auto auto auto 1fr` → `auto 1fr`: **World Forge** (settings) on top, **Metrics** below, transparent gutters (drop the 1px hairline). Each section wrapped in `.glass` tiles with ~12px gaps.
- Forge inputs/selects → inset skeuo wells (`--control-face` + `--shadow-well`); `.forge-submit` → raised tactile accent button (`--btn-face`, press `translateY(1px)`). Metrics tracks → inset wells with gradient-gloss fills; group indicators under an etched subhead + an "Economy" chip strip (gini/barter/tools).
- **StructureCard rehome:** `renderStructure` currently borrows `agentEl`/`memoryEl` — rehome into the modal shell (structure layout) or a compact floating card **before** the sections are deleted (B2).

---

## Serialize change ledger (load-bearing — overlays are blocked without these)

| Field | Added in | Consumed by |
|---|---|---|
| per-agent `known_nodes`, `known_structures` (id arrays) | S1/Step1 | S2 fog-dim overlay |
| per-agent `best_ally: name\|null` | S1/Step3 | affinity links, modal best-ally chip |
| per-pair `relationships: [{id,name,label,score}]` | S1/Step3 | modal relationships section |
| `diary[-12:]` (was `[-3:]`) | S1/Step3 | modal scrollable diary |
| top-level `claims: [{node_id,owner_id,owner}]` | S2/Step4 | claim outlines |
| per-agent `following` + `followers` | S2/Step4 | follow-link layer |
| new feed `kind` for the 5 social tools | S2/Step4 | log console color edges |

**Also:** update the TS `AgentState` / `FeedEntry` / `WorldState` types (`main.ts:4-32`) to carry every new field, or the typed reader silently drops them.

---

## Decisions needed from you (open questions)

1. **Escape/oxygen revealed at spawn** (guarantees completable runs) **vs fully fogged** (discovering + announcing the escape route becomes the central emergent payoff, with wipe risk)? *Default: revealed.*
2. **Spread spawns into distinct sectors** to force information asymmetry — but does that break the "shared crash camp" narrative? *Default: keep clustered, lower `home_radius`.*
3. **Claim enforcement:** stays advisory (trespass dings affinity) **vs** escalates to a votable hard rule that blocks gather (starvation risk)? *Default: advisory first.*
4. **Announce radius:** whole-map (clean for norms/votes) **vs** finite shout radius (realistic, can fragment shared knowledge)? *Default: R=12.*
5. **Knowledge staleness:** when an agent arrives at a shared node that's now depleted, emit an "it's empty now" correction (enables distrust/misinformation dynamics)? *Default: yes, cheap and on-theme.*

---

## Why this ordering produces benchmark results

The payoff isn't the tools — it's that each one makes a previously-invisible cognitive difference **measurable**: who shares information vs hoards it (Step 1), whether knowledge actually propagates (Step 2), whether reciprocity forms in-groups (Step 3), and whether leadership/property/norms emerge without being authored (Step 4). Run the same world on stub vs a real LLM and the gap on these signals **is** the benchmark.
