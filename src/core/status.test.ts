import { describe, it, expect } from 'vitest';
import {
  buildStatus,
  formatDevices,
  formatStatus,
  type DeviceEntry,
  type EntitySnapshot,
  type StatusInputs,
} from './status.js';

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

  it('carries the distinct clock-offline and clock-future reasons through to the message', () => {
    for (const reason of ['clock-offline', 'clock-future'] as const) {
      const s = buildStatus({
        ...healthy,
        clockHealthy: false,
        coversEnabled: false,
        coversDisabledReason: reason,
      });
      expect(s.coversReason).toBe(reason);
      expect(formatStatus(s)).toContain(reason);
    }
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

describe('formatDevices (per-device states in סטטוס)', () => {
  const entities: DeviceEntry[] = [
    { name: 'גינה', type: 'cover', entityId: 'cover.g' },
    { name: 'מטבח', type: 'cover', entityId: 'cover.k' },
    { name: 'חוץ', type: 'light', entityId: 'light.w' },
    { name: 'מאוורר', type: 'switch', entityId: 'switch.fan' },
    { name: 'שקע', type: 'switch', entityId: 'switch.socket' },
  ];
  const snaps = (o: Record<string, EntitySnapshot>) => new Map(Object.entries(o));

  it('renders grouped lines in config order', () => {
    const out = formatDevices(
      entities,
      snaps({
        'cover.g': { state: 'open', position: 20 },
        'cover.k': { state: 'closed', position: 0 },
        'light.w': { state: 'on' },
        'switch.fan': { state: 'off' },
        'switch.socket': { state: 'on' },
      }),
    );
    expect(out).toBe(
      [
        '🪟 תריסים',
        'גינה 20%',
        'מטבח 0%',
        '',
        '💡 אורות',
        'חוץ דלוק',
        '',
        '🔌 מתגים',
        'מאוורר כבוי',
        'שקע דלוק',
      ].join('\n'),
    );
  });

  it('marks a moving cover', () => {
    const out = formatDevices(
      entities.slice(0, 2),
      snaps({
        'cover.g': { state: 'opening', position: 45 },
        'cover.k': { state: 'closing', position: 60 },
      }),
    );
    expect(out).toContain('גינה 45% (נפתח…)');
    expect(out).toContain('מטבח 60% (נסגר…)');
  });

  it.each(['unavailable', 'unknown', 'constructor', '__proto__'])(
    'ignores a stale position on a cover in state %j',
    (state) => {
      const out = formatDevices([entities[0]!], snaps({ 'cover.g': { state, position: 40 } }));
      expect(out).toBe('🪟 תריסים\nגינה לא זמין');
    },
  );

  it('describes a moving cover that reports no position', () => {
    const out = formatDevices(
      entities.slice(0, 2),
      snaps({ 'cover.g': { state: 'opening' }, 'cover.k': { state: 'closing' } }),
    );
    expect(out).toContain('גינה נפתח…');
    expect(out).toContain('מטבח נסגר…');
  });

  it('falls back to פתוח/סגור for a cover with no position', () => {
    const out = formatDevices(
      entities.slice(0, 2),
      snaps({ 'cover.g': { state: 'open' }, 'cover.k': { state: 'closed' } }),
    );
    expect(out).toContain('גינה פתוח');
    expect(out).toContain('מטבח סגור');
  });

  it.each(['unavailable', 'unknown', '<script>', 'on\nfoo', 'opening', 'constructor', 'toString'])(
    'renders לא זמין for a toggle in state %j and never echoes it',
    (state) => {
      const out = formatDevices([entities[2]!], snaps({ 'light.w': { state } }));
      expect(out).toBe('💡 אורות\nחוץ לא זמין');
    },
  );

  it.each(['unavailable', 'unknown', '<script>', 'on', 'constructor', '__proto__'])(
    'renders לא זמין for a cover in state %j with no position',
    (state) => {
      const out = formatDevices([entities[0]!], snaps({ 'cover.g': { state } }));
      expect(out).toBe('🪟 תריסים\nגינה לא זמין');
    },
  );

  it('renders לא זמין for an entity missing from the snapshot', () => {
    const out = formatDevices(entities, snaps({}));
    expect(out).toContain('גינה לא זמין');
    expect(out).toContain('שקע לא זמין');
  });

  it('omits empty groups', () => {
    const out = formatDevices([entities[3]!], snaps({ 'switch.fan': { state: 'on' } }));
    expect(out).toBe('🔌 מתגים\nמאוורר דלוק');
  });

  it('reports a single line when HA is unreachable', () => {
    expect(formatDevices(entities, undefined)).toBe('מצב מכשירים לא זמין');
  });
});
