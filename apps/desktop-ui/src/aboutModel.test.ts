import { describe, expect, it } from 'vitest';
import { compareSemver, isNewerVersion, normalizeVersion } from './aboutModel';

describe('aboutModel', () => {
  it('normalizes tag prefixes', () => {
    expect(normalizeVersion('v0.1.0')).toBe('0.1.0');
    expect(normalizeVersion('V1.2.3')).toBe('1.2.3');
    expect(normalizeVersion(' 0.2.0 ')).toBe('0.2.0');
  });

  it('compares semver', () => {
    expect(compareSemver('0.2.0', '0.1.0')).toBe(1);
    expect(compareSemver('0.1.0', '0.2.0')).toBe(-1);
    expect(compareSemver('v0.1.0', '0.1.0')).toBe(0);
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true);
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
  });
});