/**
 * QLoRA training — TS wrapper that validates config and shells out to
 * python/train_sft.py (transformers + peft + bitsandbytes).
 *
 * Sized for a single RTX 5090 (32 GB): 7–8B base model, 4-bit NF4, LoRA r=16,
 * seq 2048–4096. Run on YOUR GPU box; artifacts are small LoRA adapters.
 *
 *   pnpm --filter @game-night/trainer train --config train.config.json
 *
 * train.config.json:
 * {
 *   "baseModel": "Qwen/Qwen3-8B",
 *   "dataDir": "sft-data",
 *   "outputDir": "adapters/gen1",
 *   "epochs": 3,
 *   "learningRate": 2e-4,
 *   "maxSeqLen": 3072,
 *   "batchSize": 2,
 *   "gradAccum": 8
 * }
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

interface TrainConfig {
  baseModel: string;
  dataDir: string;
  outputDir: string;
  epochs?: number;
  learningRate?: number;
  maxSeqLen?: number;
  batchSize?: number;
  gradAccum?: number;
  loraR?: number;
  loraAlpha?: number;
}

function main(): void {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--config');
  const cfgPath = i >= 0 ? argv[i + 1]! : 'train.config.json';
  if (!existsSync(cfgPath)) {
    console.error(`config not found: ${cfgPath}`);
    console.error('create one like:');
    console.log(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'python', 'train.config.example.json'), 'utf8'));
    process.exit(1);
  }
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as TrainConfig;
  for (const key of ['baseModel', 'dataDir', 'outputDir'] as const) {
    if (!cfg[key]) throw new Error(`missing required config key: ${key}`);
  }
  for (const dir of [join(cfg.dataDir, 'train.jsonl'), join(cfg.dataDir, 'val.jsonl')]) {
    if (!existsSync(dir)) throw new Error(`missing dataset file: ${dir} (run the dataset step first)`);
  }

  const py = join(dirname(fileURLToPath(import.meta.url)), '..', 'python', 'train_sft.py');
  if (!existsSync(py)) throw new Error(`training script missing: ${py}`);
  console.log(`[trainer] base=${cfg.baseModel} data=${cfg.dataDir} → ${cfg.outputDir}`);
  const res = spawnSync('python3', [py, JSON.stringify(cfg)], { stdio: 'inherit' });
  process.exitCode = res.status ?? 1;
}

main();
