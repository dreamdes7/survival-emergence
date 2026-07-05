"""Culture as a first-class, measurable object (Sprint 3, FRONTIER_IDEAS 2.1-2.3).

Three trackers in one:

**Memes** — any phrase becomes a meme the moment it demonstrably TRAVELS: agent B
says something B previously HEARD from its author. Hearing is tracked through
real channels only (say_to/announce delivery, dialogue-scene replies), so two
stub agents drawing the same canned phrase from the same pool do NOT count —
transmission must pass through a listener. Place names, adopted rules and
rituals register as memes too, so "culture" is one ledger.

**Stories (oral history)** — `tell_story` retellings are linked into chains by
token overlap. Each chain keeps every version verbatim, so drift (1 - Jaccard
between first and latest version) is measurable — the telephone-game / myth
formation experiment. A chain retold by enough different tellers becomes a myth.

**Currency** — the scenario may declare a `currency_item` (useless, scarce,
divisible — island: beads). This tracker just counts transfers and holders;
whether the item becomes a medium of exchange is the experiment, not a script.

Everything is deterministic (no RNG) and world-agnostic: methods take `world`
as an argument, the tracker holds only data.
"""
from __future__ import annotations
import re

_QUOTE_RE = re.compile(r'[«"]([^«»"]{6,})[»"]')
_WORD_RE = re.compile(r"[\w']+", re.UNICODE)

MIN_PHRASE_LEN = 12          # chars after normalisation — ignore "да", "ок" etc.
HEARD_CAP = 200              # phrases remembered as "heard" per agent
# Token overlap linking a retelling to its chain. Russian inflection means
# honest paraphrases share fewer exact tokens (родник/родника don't match), so
# the bar sits lower than English intuition suggests; unrelated stories still
# score ~0.1 and never merge.
STORY_MATCH_JACCARD = 0.35
MYTH_MIN_VERSIONS = 4
MYTH_MIN_TELLERS = 3


def _norm(text: str) -> str:
    """Normalise a phrase for identity: lowercase words joined by single spaces."""
    return " ".join(_WORD_RE.findall(str(text).lower()))


def _tokens(text: str) -> set[str]:
    return set(_WORD_RE.findall(str(text).lower()))


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


class CultureTracker:
    def __init__(self, currency_item: str | None = None) -> None:
        # memes
        self.candidates: dict[str, dict] = {}     # norm -> {text, author, author_id, tick}
        self.heard: dict[str, dict[str, bool]] = {}   # agent_id -> ordered set of norms
        self.memes: dict[str, dict] = {}           # norm -> meme record
        # stories
        self.chains: list[dict] = []
        # currency
        self.currency_item = currency_item
        self.currency_transfers = 0
        self.transfer_log: list[dict] = []         # bounded

    # ── memes ──────────────────────────────────────────────────────────────────
    def note_heard(self, agent, text: str) -> None:
        """Register that `agent` heard a phrase (inbox delivery / scene reply).
        Delivered texts are often wrapped ('X said to me: "msg"') — prefer the
        quoted message when present."""
        m = _QUOTE_RE.findall(str(text))
        phrase = m[-1] if m else text
        norm = _norm(phrase)
        if len(norm) < MIN_PHRASE_LEN:
            return
        bag = self.heard.setdefault(agent.id, {})
        bag[norm] = True
        if len(bag) > HEARD_CAP:                    # drop oldest (insertion order)
            for k in list(bag)[: len(bag) - HEARD_CAP]:
                del bag[k]

    def note_spoken(self, world, agent, text: str) -> None:
        """Register that `agent` spoke a phrase. A phrase spoken by a NON-author
        who previously heard it = cultural transmission -> the phrase is a meme."""
        norm = _norm(text)
        if len(norm) < MIN_PHRASE_LEN:
            return

        meme = self.memes.get(norm)
        if meme is not None:
            if (agent.id != meme["author_id"] and agent.id not in meme["carriers"]
                    and norm in self.heard.get(agent.id, {})):
                meme["carriers"].append(agent.id)
                world.emit("meme_spread", actor=agent.id,
                           payload={"text": meme["text"], "author": meme["author"],
                                    "carriers": len(meme["carriers"])})
                self._maybe_famous(world, meme)
            return

        cand = self.candidates.get(norm)
        if cand is None:
            self.candidates[norm] = {"text": str(text).strip(), "author": agent.name,
                                     "author_id": agent.id, "tick": world.tick}
            return
        if cand["author_id"] != agent.id and norm in self.heard.get(agent.id, {}):
            # Born: the phrase demonstrably travelled author -> listener -> speech.
            meme = {"kind": "phrase", "text": cand["text"], "author": cand["author"],
                    "author_id": cand["author_id"], "born_tick": world.tick,
                    "carriers": [agent.id], "famous": False}
            self.memes[norm] = meme
            world.emit("meme_born", actor=cand["author_id"], target=agent.id,
                       payload={"text": meme["text"], "author": meme["author"]})

    def register_meme(self, world, kind: str, text: str, author: str, author_id: str) -> None:
        """Non-phrase culture (place names, adopted rules, rituals) joins the same
        ledger so cultural output is one measurable stream."""
        norm = f"{kind}:{_norm(text)}"
        if norm in self.memes:
            return
        self.memes[norm] = {"kind": kind, "text": str(text).strip(), "author": author,
                            "author_id": author_id, "born_tick": world.tick,
                            "carriers": [], "famous": True}
        world.emit("meme_born", actor=author_id,
                   payload={"kind": kind, "text": str(text).strip(), "author": author})

    def _maybe_famous(self, world, meme: dict) -> None:
        living = max(1, len(world.living_agents()))
        if not meme["famous"] and 1 + len(meme["carriers"]) >= max(2, (living + 1) // 2):
            meme["famous"] = True
            world.log_event("culture",
                            f"Фраза стала крылатой: «{meme['text']}» (автор — {meme['author']})",
                            2.4, [meme["author"]])

    # ── oral history ───────────────────────────────────────────────────────────
    def tell_story(self, world, teller, listener, text: str) -> dict:
        """Link a told story into its chain (by token overlap with each chain's
        latest version) or start a new chain. Returns the chain."""
        toks = _tokens(text)
        best, best_j = None, 0.0
        for ch in self.chains:
            j = _jaccard(toks, _tokens(ch["versions"][-1]["text"]))
            if j > best_j:
                best, best_j = ch, j
        if best is not None and best_j >= STORY_MATCH_JACCARD:
            chain = best
        else:
            chain = {"id": len(self.chains), "origin": teller.name, "origin_id": teller.id,
                     "born_tick": world.tick, "versions": [], "tellers": [], "myth": False}
            self.chains.append(chain)

        chain["versions"].append({"tick": world.tick, "teller": teller.name,
                                  "teller_id": teller.id, "text": str(text).strip()})
        if teller.id not in chain["tellers"]:
            chain["tellers"].append(teller.id)

        world.emit("story_told", actor=teller.id, target=listener.id,
                   payload={"chain": chain["id"], "version": len(chain["versions"]),
                            "drift": round(self.drift(chain), 3), "text": str(text).strip()[:200]})

        if (not chain["myth"] and len(chain["versions"]) >= MYTH_MIN_VERSIONS
                and len(chain["tellers"]) >= MYTH_MIN_TELLERS):
            chain["myth"] = True
            world.log_event("culture",
                            f"История «{chain['versions'][0]['text'][:60]}…» пошла по рукам "
                            f"и обросла легендой — её рассказывают уже {len(chain['tellers'])} человек",
                            2.6, [teller.name])
        return chain

    @staticmethod
    def drift(chain: dict) -> float:
        """How far the latest version wandered from the first (0 = verbatim)."""
        v = chain["versions"]
        if len(v) < 2:
            return 0.0
        return 1.0 - _jaccard(_tokens(v[0]["text"]), _tokens(v[-1]["text"]))

    # ── currency ───────────────────────────────────────────────────────────────
    def note_transfer(self, world, item: str, giver, receiver, qty: float) -> None:
        if self.currency_item is None or item != self.currency_item:
            return
        self.currency_transfers += 1
        self.transfer_log.append({"tick": world.tick, "from": giver.name,
                                  "to": receiver.name, "qty": qty})
        if len(self.transfer_log) > 300:
            self.transfer_log = self.transfer_log[-300:]
        world.emit("currency_transfer", actor=giver.id, target=receiver.id,
                   payload={"item": item, "qty": qty,
                            "total_transfers": self.currency_transfers})

    # ── summary for metrics / snapshot ─────────────────────────────────────────
    def summary(self, world) -> dict:
        transmissions = sum(len(m["carriers"]) for m in self.memes.values())
        top = sorted(self.memes.values(),
                     key=lambda m: (-len(m["carriers"]), m["born_tick"]))[:3]
        max_drift = max((self.drift(c) for c in self.chains), default=0.0)
        out: dict = {
            "memes": {
                "count": len(self.memes),
                "transmissions": transmissions,
                "famous": sum(1 for m in self.memes.values() if m["famous"]),
                "top": [{"text": m["text"][:80], "author": m["author"],
                         "kind": m["kind"], "carriers": len(m["carriers"])} for m in top],
            },
            "stories": {
                "chains": len(self.chains),
                "retellings": sum(len(c["versions"]) for c in self.chains),
                "myths": sum(1 for c in self.chains if c["myth"]),
                "max_drift": round(max_drift, 3),
            },
        }
        if self.currency_item:
            holders = sum(1 for a in world.agents
                          if a.inventory.get(self.currency_item, 0) > 0)
            out["currency"] = {
                "item": self.currency_item,
                "transfers": self.currency_transfers,
                "holders": holders,
                "velocity": round(self.currency_transfers / max(1, world.tick + 1), 4),
            }
        return out
