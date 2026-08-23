"""Pure-python label masking for SFT — importable WITHOUT torch.

Training must supervise ONLY the assistant response tokens. Feeding prompt
tokens into the loss teaches the model to write rules and game states instead
of choosing actions.
"""

PAD_MASK = -100


def build_labels(
    input_ids: list[int],
    prefix_len: int,
    pad_token_id: int | None = None,
) -> list[int]:
    """Mask everything before (and including) the generation prompt, plus pads.

    input_ids     : full tokenization of the rendered chat
    prefix_len    : token count of system+user rendered with
                    add_generation_prompt=True (must be a strict prefix)
    pad_token_id  : tokenizer pad id, masked too

    Returns labels aligned with input_ids (-100 where not supervised).
    """
    if prefix_len > len(input_ids):
        # Defensive: truncated conversations may lose the boundary.
        return [PAD_MASK] * len(input_ids)
    out: list[int] = []
    for i, tok in enumerate(input_ids):
        if i < prefix_len:
            out.append(PAD_MASK)
        elif pad_token_id is not None and tok == pad_token_id:
            out.append(PAD_MASK)
        else:
            out.append(tok)
    return out


def supervised_token_count(labels: list[int]) -> int:
    """Sanity metric: how many positions actually receive gradient."""
    return sum(1 for l in labels if l != PAD_MASK)
