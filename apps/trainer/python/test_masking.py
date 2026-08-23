"""CPU-only tests for assistant-only masking (no torch/transformers needed).

Run:  python3 python/test_masking.py   (or pytest python/)
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from masking import PAD_MASK, build_labels, supervised_token_count  # noqa: E402


def test_masks_prompt_prefix():
    # [system+user tokens][assistant tokens]
    ids = [10, 11, 12, 13, 14]
    labels = build_labels(ids, prefix_len=3)
    assert labels == [PAD_MASK, PAD_MASK, PAD_MASK, 13, 14]


def test_masks_pad_tokens():
    ids = [10, 11, 12, 99, 98, 99]  # 99 = pad
    labels = build_labels(ids, prefix_len=2, pad_token_id=99)
    assert labels == [PAD_MASK, PAD_MASK, 12, PAD_MASK, 98, PAD_MASK]


def test_prefix_longer_than_input_is_fully_masked():
    ids = [10, 11]
    assert build_labels(ids, prefix_len=5) == [PAD_MASK, PAD_MASK]


def test_counts_supervised_positions():
    ids = [10, 11, 12, 13]
    labels = build_labels(ids, prefix_len=2, pad_token_id=13)
    assert supervised_token_count(labels) == 1


def test_action_only_target_is_small():
    """The whole point of action-only mode: a few tokens of supervision."""
    import json

    target = json.dumps({"action_id": "A7"})
    # ~6-10 tokens for a tiny JSON object; assert the SHAPE stays tiny.
    assert len(target) < 40


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"PASS {name}")
    print("all masking tests passed")
