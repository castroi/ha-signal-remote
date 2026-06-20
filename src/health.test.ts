import { describe, it, expect } from 'vitest';

// Trivial test proving the harness runs (Task 0 acceptance).
function sum(a: number, b: number): number {
  return a + b;
}

describe('test harness', () => {
  it('runs and evaluates a trivial assertion', () => {
    expect(sum(2, 3)).toBe(5);
  });
});
