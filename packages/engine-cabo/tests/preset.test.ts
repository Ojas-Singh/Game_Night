import { describe, expect, it } from 'vitest';
import { preset } from '@game-night/core';
import { DEFAULT_CABO_RULES } from '../src/rules.js';

describe('default rules', () => {
  it('are the core\'s default rule set', () => {
    expect(preset('cabo')).toEqual(DEFAULT_CABO_RULES);
  });
});
