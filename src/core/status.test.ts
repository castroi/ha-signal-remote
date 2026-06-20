import { describe, it, expect } from 'vitest';
import { buildStatus, formatStatus, type StatusInputs } from './status.js';

const healthy: StatusInputs = {
  wsHealthy: true,
  clockHealthy: true,
  killEngaged: false,
  coversEnabled: true,
  coversDisabledReason: undefined,
};

describe('status command (design §4)', () => {
  it('reports all-healthy state', () => {
    const s = buildStatus(healthy);
    expect(s.ws).toBe('healthy');
    expect(s.clock).toBe('healthy');
    expect(s.killSwitch).toBe('off');
    expect(s.covers).toBe('enabled');
  });

  it('explains why covers are disabled (WS down)', () => {
    const s = buildStatus({
      ...healthy,
      wsHealthy: false,
      coversEnabled: false,
      coversDisabledReason: 'ws-down',
    });
    expect(s.covers).toBe('disabled');
    expect(s.coversReason).toBe('ws-down');
  });

  it('explains why covers are disabled (clock skew)', () => {
    const s = buildStatus({
      ...healthy,
      clockHealthy: false,
      coversEnabled: false,
      coversDisabledReason: 'clock-skew',
    });
    expect(s.coversReason).toBe('clock-skew');
  });

  it('reflects an engaged kill switch', () => {
    const s = buildStatus({ ...healthy, killEngaged: true });
    expect(s.killSwitch).toBe('on');
  });

  it('formats one short Hebrew message including the reason when disabled', () => {
    const msg = formatStatus(
      buildStatus({
        ...healthy,
        wsHealthy: false,
        coversEnabled: false,
        coversDisabledReason: 'ws-down',
      }),
    );
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
    // single line
    expect(msg.includes('\n')).toBe(false);
    expect(msg).toContain('ws-down');
  });
});
