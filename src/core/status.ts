/**
 * Status command (design §4). Builds the compact health report returned to an
 * authorized sender for `סטטוס`. The allowlist check and the "always answered for
 * authorized" routing live in the wiring layer; this module is the pure report.
 *
 * Returns, in one short message: WS, clock, kill switch, and covers
 * enabled/disabled with the reason when disabled.
 */

import type { EntityType } from '../app/config.js';

export type CoversDisabledReason =
  | 'ws-down'
  | 'clock-skew'
  | 'clock-offline'
  | 'clock-future'
  | 'kill-switch';

/** One entity's live state as read from HA for the device section of `סטטוס`. */
export interface EntitySnapshot {
  readonly state: string;
  /** Covers only: attributes.current_position, when an integer 0–100. */
  readonly position?: number;
}

export interface StatusInputs {
  readonly wsHealthy: boolean;
  readonly clockHealthy: boolean;
  readonly killEngaged: boolean;
  readonly coversEnabled: boolean;
  readonly coversDisabledReason: CoversDisabledReason | undefined;
}

export interface StatusReport {
  readonly ws: 'healthy' | 'unhealthy';
  readonly clock: 'healthy' | 'unhealthy';
  readonly killSwitch: 'on' | 'off';
  readonly covers: 'enabled' | 'disabled';
  readonly coversReason: CoversDisabledReason | undefined;
}

export function buildStatus(input: StatusInputs): StatusReport {
  return {
    ws: input.wsHealthy ? 'healthy' : 'unhealthy',
    clock: input.clockHealthy ? 'healthy' : 'unhealthy',
    killSwitch: input.killEngaged ? 'on' : 'off',
    covers: input.coversEnabled ? 'enabled' : 'disabled',
    coversReason: input.coversEnabled ? undefined : input.coversDisabledReason,
  };
}

/** One-line Hebrew status message; includes the reason when covers are off. */
export function formatStatus(report: StatusReport): string {
  const wsHe = report.ws === 'healthy' ? 'תקין' : 'תקלה';
  const clockHe = report.clock === 'healthy' ? 'תקין' : 'תקלה';
  const killHe = report.killSwitch === 'on' ? 'פעיל' : 'כבוי';
  const coversHe =
    report.covers === 'enabled'
      ? 'תריסים פעילים'
      : `תריסים מושבתים (${report.coversReason ?? 'לא ידוע'})`;
  return `מצב: WS ${wsHe} | שעון ${clockHe} | כיבוי חירום ${killHe} | ${coversHe}`;
}

/** A configured entity as listed in the device section (name = its first alias). */
export interface DeviceEntry {
  readonly name: string;
  readonly type: EntityType;
  readonly entityId: string;
}

const UNAVAILABLE = 'לא זמין';

const GROUP_HEADER: Record<EntityType, string> = {
  cover: '🪟 תריסים',
  light: '💡 אורות',
  switch: '🔌 מתגים',
};

// Maps (not object literals) so an HA state like "constructor" can't hit a prototype key.
const MOVING_MARKER = new Map([
  ['opening', ' (נפתח…)'],
  ['closing', ' (נסגר…)'],
]);

// Fixed words only — a raw HA state string is never echoed into the reply.
const COVER_WORD = new Map([
  ['open', 'פתוח'],
  ['closed', 'סגור'],
]);
const TOGGLE_WORD = new Map([
  ['on', 'דלוק'],
  ['off', 'כבוי'],
]);

function deviceState(type: EntityType, snap: EntitySnapshot | undefined): string {
  if (!snap) return UNAVAILABLE;
  if (type !== 'cover') return TOGGLE_WORD.get(snap.state) ?? UNAVAILABLE;
  if (snap.position !== undefined) return `${snap.position}%${MOVING_MARKER.get(snap.state) ?? ''}`;
  return COVER_WORD.get(snap.state) ?? UNAVAILABLE;
}

/**
 * Device section of `סטטוס`: one line per configured entity, grouped by type in
 * config order (empty groups omitted). `snapshots === undefined` means HA was
 * unreachable and collapses the section to a single line.
 */
export function formatDevices(
  entities: readonly DeviceEntry[],
  snapshots: ReadonlyMap<string, EntitySnapshot> | undefined,
): string {
  if (!snapshots) return `מצב מכשירים ${UNAVAILABLE}`;
  const groups: string[] = [];
  for (const type of Object.keys(GROUP_HEADER) as EntityType[]) {
    const lines = entities
      .filter((e) => e.type === type)
      .map((e) => `${e.name} ${deviceState(type, snapshots.get(e.entityId))}`);
    if (lines.length > 0) groups.push([GROUP_HEADER[type], ...lines].join('\n'));
  }
  return groups.join('\n\n');
}
