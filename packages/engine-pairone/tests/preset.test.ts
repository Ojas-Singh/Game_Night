import { describe, expect, it } from 'vitest';
import { preset } from '@game-night/core';
import { DEFAULT_PAIRONE_RULES } from '../src/types.js';

describe('default rules', () => {
  it('are the core\'s default rule set', () => {
    expect(preset('pairone')).toEqual(DEFAULT_PAIRONE_RULES);
  });
});
