"""Sprint 3: memes (transmission-proven), oral history chains, currency."""
from __future__ import annotations

from conftest import build_sim


def _pair(world):
    a, b = world.agents[0], world.agents[1]
    b.x, b.y = a.x, min(world.size - 1, a.y + 1)
    return a, b


PHRASE = "Better to freeze together than alone tonight"


def test_meme_born_only_through_hearing():
    world, _, _ = build_sim({"seed": 8})
    a, b, c = world.agents[0], world.agents[1], world.agents[2]
    world.tick = 3

    # A speaks the phrase; C says the same words WITHOUT ever hearing them
    # (stub pool collision) -> must NOT count as transmission.
    world.culture.note_spoken(world, a, PHRASE)
    world.culture.note_spoken(world, c, PHRASE)
    assert not world.culture.memes, "pool collision must not create a meme"

    # B actually hears it from A, then repeats it -> the meme is born.
    world.culture.note_heard(b, f'{a.name} said to me: "{PHRASE}"')
    world.culture.note_spoken(world, b, PHRASE)
    memes = list(world.culture.memes.values())
    assert len(memes) == 1
    assert memes[0]["author_id"] == a.id
    assert memes[0]["carriers"] == [b.id]
    assert [e for e in world.events if e["kind"] == "meme_born"]


def test_meme_spreads_and_becomes_famous():
    world, _, _ = build_sim({"seed": 8, "agents": 4})
    a, b, c, d = world.agents
    world.culture.note_spoken(world, a, PHRASE)
    for carrier in (b, c, d):
        world.culture.note_heard(carrier, PHRASE)
        world.culture.note_spoken(world, carrier, PHRASE)
    meme = next(iter(world.culture.memes.values()))
    assert len(meme["carriers"]) == 3
    assert meme["famous"], "author + 3 carriers of 4 living should be famous"
    assert any(e["kind"] == "chronicle" and "крылатой" in e["payload"]["text"]
               for e in world.events)


def test_story_chain_links_retellings_and_measures_drift():
    world, _, _ = build_sim({"seed": 4})
    a, b = _pair(world)
    world.tick = 5
    original = "мы нашли родник у скал и Борис чуть не сорвался вниз когда пил"
    retold = "Борис пил у родника возле скал и чуть не сорвался — я сам видел"
    unrelated = "ночью был шторм и палатку едва не унесло в море"

    ch1 = world.culture.tell_story(world, a, b, original)
    ch2 = world.culture.tell_story(world, b, a, retold)      # overlaps -> same chain
    ch3 = world.culture.tell_story(world, a, b, unrelated)   # new chain

    assert ch1 is ch2 and ch3 is not ch1
    assert len(ch1["versions"]) == 2 and len(ch1["tellers"]) == 2
    drift = world.culture.drift(ch1)
    assert 0.0 < drift < 1.0, f"paraphrase must show partial drift, got {drift}"
    assert world.culture.drift(ch3) == 0.0


def test_tell_story_tool_delivers_and_listener_can_retell():
    world, llm, _ = build_sim({"seed": 4})
    a, b = _pair(world)
    world.tick = 6
    result = world.tools.execute("tell_story", world, a,
                                 {"target": b.name, "story": "как мы выбрались из обломков самолёта"})
    assert "рассказал" in result
    stories = [e for e in b.memory.entries if e.kind == "story"]
    assert len(stories) == 1 and a.name in stories[0].text
    # the listener retells -> the chain extends with a second teller
    world.tools.execute("tell_story", world, b,
                        {"target": a.name, "story": "как выбрались из обломков самолёта — жуть"})
    chain = world.culture.chains[0]
    assert len(chain["tellers"]) == 2
    assert [e for e in world.events if e["kind"] == "story_told"]


def test_currency_transfers_tracked():
    world, _, _ = build_sim({"seed": 4})
    a, b = _pair(world)
    assert world.culture.currency_item == "beads"     # island scenario declares it
    a.inventory["beads"] = 5
    result = world.tools.execute("give", world, a, {"target": b.name, "item": "beads", "qty": 2})
    assert "gave" in result
    assert world.culture.currency_transfers == 1
    assert [e for e in world.events if e["kind"] == "currency_transfer"]
    assert [e for e in world.events if e["kind"] == "gift"]
    summary = world.culture.summary(world)
    assert summary["currency"]["transfers"] == 1
    assert summary["currency"]["holders"] >= 2        # both hold beads now


def test_shell_bed_exists_on_island():
    world, _, _ = build_sim({"seed": 4})
    beds = [n for n in world.nodes if n.kind == "shell_bed"]
    assert beds and all(n.yield_item == "beads" for n in beds)
