/**
 * Status command (design §4). Builds the compact health report returned to an
 * authorized sender for `סטטוס`. The allowlist check and the "always answered for
 * authorized" routing live in the wiring layer; this module is the pure report.
 *
 * Returns, in one short message: WS, clock, kill switch, and covers
 * enabled/disabled with the reason when disabled.
 */

export type CoversDisabledReason = 'ws-down' | 'clock-skew' | 'clock-offline' | 'kill-switch';

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
