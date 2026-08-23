"""GameSpec v0 tests: parse validation, hash stability, compiled-game fuzz."""
import json, random, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))


from rulezero.gamespec_compile import register_gamespec
from rulezero.gamespec_schema import parse_spec

SPEC = {
    "name": "specduel",
    "ante": 1,
    "deck": {"ranks": [2, 3, 4, 5, 6, 7, 8, 9, 10], "copiesPerRank": 1},
    "firstDecision": {"actor": "first", "raiseAmount": 1},
    "secondDecision": {"actor": "second", "raiseAmount": 0},
}

def test_hash_stable_and_canonical():
    a = parse_spec(SPEC).spec_hash()
    reordered = {k: SPEC[k] for k in reversed(list(SPEC))}
    b = parse_spec(reordered).spec_hash()
    assert a == b and len(a) == 40

def test_rejects_unknown_and_missing_fields():
    def must_fail(doc):
        try:
            parse_spec(doc)
        except ValueError:
            return
        raise AssertionError(f"expected ValueError for {doc!r}")
    must_fail({"name": "x"})  # missing fields
    d = dict(SPEC); d["firstDecision"] = {"actor": "first", "raiseAmount": 1, "hax": 1}
    must_fail(d)

def test_compiled_game_fuzz_zero_sum_terminal_deterministic():
    game, h, rules = register_gamespec(SPEC)
    rng = random.Random(7)
    for eps in range(150):
        st = game.new_initial_state(eps * 13 + 1)
        while not st.is_terminal():
            if st.is_chance_node():
                aids, probs = zip(*st.chance_outcomes())
                st.apply_action(rng.choices(aids, weights=probs)[0])
            else:
                legal = st.legal_actions(st.current_player())
                if not legal:
                    break
                st.apply_action(rng.choice(legal))
        r = st.returns()
        assert abs(sum(r)) < 1e-9
        assert st.is_terminal()
    a, b = game.new_initial_state(5), game.new_initial_state(5)
    ra, rb = random.Random(1), random.Random(1)
    for _ in range(50):
        for st, r in ((a, ra), (b, rb)):
            if st.is_terminal():
                continue
            if st.is_chance_node():
                aids, _ = zip(*st.chance_outcomes()); st.apply_action(r.choice(aids))
            else:
                st.apply_action(r.choice(st.legal_actions(st.current_player())))
    assert str(a) == str(b)

def test_rules_text_generated_from_spec():
    _, _, rules = register_gamespec(SPEC)
    assert "Ante 1.0" in rules and "FOLD" in rules

if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn(); print(f"PASS {name}")
            except Exception as e:
                print(f"FAIL {name}: {e}"); sys.exit(1)
    print("all gamespec tests passed")
