#!/usr/bin/env python3
"""
QLoRA SFT for card-game agents (single consumer GPU, ~32 GB).

Usage (from apps/trainer):  pnpm train --config train.config.json
Requires: pip install transformers peft bitsandbytes datasets accelerate torch

Chat-formatted JSONL in, LoRA adapter out. The adapter is served with:
    vllm serve <base_model> --enable-lora --lora-modules gen1=<adapter_dir>
"""

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from masking import build_labels  # noqa: E402

try:
    import torch
    from datasets import load_dataset
    from peft import LoraConfig, get_peft_model
    from transformers import (
        AutoModelForCausalLM,
        AutoTokenizer,
        DataCollatorForSeq2Seq,
        Trainer,
        TrainingArguments,
    )
except ImportError as e:  # pragma: no cover - exercised only on GPU boxes
    print(f"missing dependency: {e}\npip install transformers peft bitsandbytes datasets accelerate torch")
    sys.exit(1)


def main() -> None:
    cfg = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    base = cfg["baseModel"]
    data_dir = cfg["dataDir"]
    out = cfg["outputDir"]
    epochs = int(cfg.get("epochs", 3))
    lr = float(cfg.get("learningRate", 2e-4))
    max_len = int(cfg.get("maxSeqLen", 3072))
    batch = int(cfg.get("batchSize", 2))
    accum = int(cfg.get("gradAccum", 8))
    lora_r = int(cfg.get("loraR", 16))
    lora_alpha = int(cfg.get("loraAlpha", 32))

    tok = AutoTokenizer.from_pretrained(base)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    def to_features(ex):
        msgs = ex["messages"]
        assert msgs[-1]["role"] == "assistant", "SFT sample must end with assistant turn"
        full = tok(
            tok.apply_chat_template(msgs, tokenize=False),
            truncation=True,
            max_length=max_len,
        )
        # Assistant-only loss: tokenize system+user with the generation prompt
        # and mask everything up to (and including) it. The model is graded on
        # its move, not on reciting the rules back.
        prefix = tok(
            tok.apply_chat_template(msgs[:-1], tokenize=False, add_generation_prompt=True),
            truncation=True,
            max_length=max_len,
        )
        full["labels"] = build_labels(full["input_ids"], len(prefix["input_ids"]), tok.pad_token_id)
        n_sup = sum(1 for x in full["labels"] if x != -100)
        if n_sup == 0:
            raise ValueError("conversation truncated before any supervised token")
        return full

    ds = load_dataset("json", data_files={
        "train": f"{data_dir}/train.jsonl",
        "validation": f"{data_dir}/val.jsonl",
    })
    cols = [c for c in ds["train"].column_names if c not in ("messages",)]
    ds = ds.remove_columns(cols) if cols else ds
    features = ds.map(to_features, remove_columns=["messages"])

    model = AutoModelForCausalLM.from_pretrained(
        base,
        torch_dtype=torch.bfloat16,
        device_map="auto",
        quantization_config=None,  # bitsandbytes 4-bit:
        load_in_4bit=True,
        attn_implementation="sdpa",
    )
    peft_cfg = LoraConfig(
        r=lora_r,
        lora_alpha=lora_alpha,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    )
    model = get_peft_model(model, peft_cfg)
    model.print_trainable_parameters()

    args = TrainingArguments(
        output_dir=out,
        per_device_train_batch_size=batch,
        gradient_accumulation_steps=accum,
        num_train_epochs=epochs,
        learning_rate=lr,
        bf16=True,
        logging_steps=10,
        eval_strategy="steps",
        eval_steps=50,
        save_strategy="epoch",
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        report_to=[],
        gradient_checkpointing=True,
    )
    trainer = Trainer(
        model=model,
        args=args,
        train_dataset=features["train"],
        eval_dataset=features["validation"],
        data_collator=DataCollatorForSeq2Seq(tok, padding=True),
    )
    trainer.train()
    trainer.save_model(out)
    tok.save_pretrained(out)

    # Report final val loss explicitly — the arena decides skill, but loss
    # catches broken tokenization before we waste an evaluation run.
    metrics = trainer.evaluate()
    loss = metrics.get("eval_loss")
    ppl = math.exp(loss) if isinstance(loss, float) and math.isfinite(loss) else float("inf")
    print(f"eval_loss={loss} perplexity={ppl:.2f}")
    print(f"adapter saved → {out}")


if __name__ == "__main__":
    main()
