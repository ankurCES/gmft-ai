import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerConfigField,
  getConfigFields,
  _clearConfigFields,
  type ConfigField,
} from '../src/config/registry.js';

const noopField = (id: string, order: number): ConfigField => ({
  id,
  label: id,
  order,
  isConfigured: () => false,
  prompt: async () => null,
});

describe('config registry', () => {
  beforeEach(() => _clearConfigFields());

  it('returns fields sorted by order, rejects duplicate ids', () => {
    registerConfigField(noopField('c', 30));
    registerConfigField(noopField('a', 10));
    registerConfigField(noopField('b', 20));
    expect(getConfigFields().map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(() => registerConfigField(noopField('a', 5))).toThrow(/already registered/);
  });
});
