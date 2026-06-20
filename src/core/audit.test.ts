import { describe, it, expect, vi } from 'vitest';
import { AuditLogger, type AuditEvent } from './audit.js';

function makeLogger() {
  const lines: string[] = [];
  const logger = new AuditLogger({ salt: 'audit-salt', sink: (line) => lines.push(line) });
  return { logger, lines };
}

const baseEvent: AuditEvent = {
  ts: 1_700_000_000_000,
  sourceUuid: 'uuid-1234',
  intent: 'close cover.living_room',
  entity: 'cover.living_room',
  result: 'observed_target',
  latencyMs: 1234,
  reasonCode: undefined,
};

describe('AuditLogger (design §6)', () => {
  it('emits the required fields', () => {
    const { logger, lines } = makeLogger();
    logger.log(baseEvent);
    const rec = JSON.parse(lines[0]!);
    expect(rec.ts).toBe(baseEvent.ts);
    expect(rec.intent).toBe('close cover.living_room');
    expect(rec.entity).toBe('cover.living_room');
    expect(rec.result).toBe('observed_target');
    expect(rec.latencyMs).toBe(1234);
    expect(typeof rec.uuidHash).toBe('string');
  });

  it('hashes the UUID with the salt — raw UUID never appears', () => {
    const { logger, lines } = makeLogger();
    logger.log(baseEvent);
    expect(lines[0]).not.toContain('uuid-1234');
    const rec = JSON.parse(lines[0]!);
    expect(rec.uuidHash).not.toBe('uuid-1234');
    expect(rec).not.toHaveProperty('sourceUuid');
  });

  it('produces a stable hash for the same UUID and different for another', () => {
    const { logger, lines } = makeLogger();
    logger.log(baseEvent);
    logger.log({ ...baseEvent, sourceUuid: 'uuid-1234' });
    logger.log({ ...baseEvent, sourceUuid: 'uuid-9999' });
    const h1 = JSON.parse(lines[0]!).uuidHash;
    const h2 = JSON.parse(lines[1]!).uuidHash;
    const h3 = JSON.parse(lines[2]!).uuidHash;
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });

  it('carries reason codes when present', () => {
    const { logger, lines } = makeLogger();
    logger.log({ ...baseEvent, result: 'rejected', reasonCode: 'rate-limited' });
    logger.log({ ...baseEvent, result: 'rejected', reasonCode: 'unrecognized-control-reply' });
    expect(JSON.parse(lines[0]!).reasonCode).toBe('rate-limited');
    expect(JSON.parse(lines[1]!).reasonCode).toBe('unrecognized-control-reply');
  });

  it('refuses to log a raw message body even if one is attached', () => {
    const { logger, lines } = makeLogger();
    // @ts-expect-error -- body is intentionally not part of AuditEvent
    logger.log({ ...baseEvent, body: 'סגור את הסלון בבקשה' });
    expect(lines[0]).not.toContain('בבקשה');
    expect(JSON.parse(lines[0]!)).not.toHaveProperty('body');
  });

  it('never logs the salt', () => {
    const { logger, lines } = makeLogger();
    logger.log(baseEvent);
    expect(lines[0]).not.toContain('audit-salt');
  });

  it('defaults to a real sink when none is provided (smoke)', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new AuditLogger({ salt: 's' });
    logger.log(baseEvent);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  // Fix item 9 (LOW): distinct reason codes for unknown-sender vs entity-unknown.
  it('accepts unknown-sender reason code (fix item 9)', () => {
    const { logger, lines } = makeLogger();
    logger.log({ ...baseEvent, result: 'rejected', reasonCode: 'unknown-sender' });
    expect(JSON.parse(lines[0]!).reasonCode).toBe('unknown-sender');
  });

  it('accepts entity-issue-failed reason code (fix item 4)', () => {
    const { logger, lines } = makeLogger();
    logger.log({ ...baseEvent, result: 'failed', reasonCode: 'entity-issue-failed' });
    expect(JSON.parse(lines[0]!).reasonCode).toBe('entity-issue-failed');
  });
});
