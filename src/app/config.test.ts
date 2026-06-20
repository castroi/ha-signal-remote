import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  DEFAULT_TUNABLES,
  RESERVED_WORDS,
  loadAliasTable,
  loadSecrets,
  loadConfig,
} from './config.js';

const here = dirname(fileURLToPath(import.meta.url));
const exampleAliases = resolve(here, '../../config/aliases.example.yaml');

const validEnv = (): NodeJS.ProcessEnv => ({
  HA_TOKEN: 'llat-token',
  HA_BASE_URL: 'http://localhost:8123',
  SIGNAL_API_URL: 'http://localhost:8080',
  BOT_NUMBER: '+15550001111',
  ALLOWLIST_UUIDS: 'uuid-a,uuid-b',
  AUDIT_SALT: 'some-salt',
});

describe('tunable defaults (design §9)', () => {
  it('match the §9 initial defaults exactly', () => {
    expect(DEFAULT_TUNABLES.freshnessWindowMs).toBe(30_000);
    expect(DEFAULT_TUNABLES.futureToleranceMs).toBe(10_000);
    expect(DEFAULT_TUNABLES.dedupTtlMs).toBe(90_000);
    expect(DEFAULT_TUNABLES.wsHealthyDebounceMs).toBe(10_000);
    expect(DEFAULT_TUNABLES.haReconnectDecisionWindowMs).toBe(30_000);
    expect(DEFAULT_TUNABLES.reconnectBackoffMinMs).toBe(1_000);
    expect(DEFAULT_TUNABLES.reconnectBackoffMaxMs).toBe(30_000);
    expect(DEFAULT_TUNABLES.rateLimitPerSender).toEqual({ max: 5, windowMs: 30_000 });
    expect(DEFAULT_TUNABLES.rateLimitGlobal).toEqual({ max: 15, windowMs: 30_000 });
    expect(DEFAULT_TUNABLES.confirmLanePerSenderPerMin).toBe(6);
    expect(DEFAULT_TUNABLES.clockSkewThresholdMs).toBe(30_000);
    expect(DEFAULT_TUNABLES.clockOfflineGraceMs).toBe(3_600_000);
    expect(DEFAULT_TUNABLES.confirmExpiryMs).toBe(20_000);
  });
});

describe('reserved control words (design §4)', () => {
  it('includes the locked set', () => {
    for (const w of ['כן', 'לא', 'תפריט', 'עזרה', 'סטטוס', 'תריסים']) {
      expect(RESERVED_WORDS.has(w)).toBe(true);
    }
  });
});

describe('alias table loading', () => {
  it('loads verbs, entities and scopes from the example file', () => {
    const table = loadAliasTable(exampleAliases);
    expect(table.entities.get('cover.living_room')?.type).toBe('cover');
    expect(table.entities.get('cover.living_room')?.completionTimeoutMs).toBe(30_000);
    // alias -> entity resolution
    expect(table.resolveEntity('סלון')?.entityId).toBe('cover.living_room');
    // verb resolution
    expect(table.resolveVerb('סגור')).toBe('close');
    // all-covers scope word, stored normalized (final mem folded)
    expect(table.allCoversWord).toBe('תריסימ');
    expect(table.coverEntityIds()).toContain('cover.living_room');
    expect(table.coverEntityIds()).not.toContain('light.garden');
  });

  it('rejects an alias table that uses a reserved word as an entity name', () => {
    const bad = resolve(here, '__fixtures__/reserved-entity.yaml');
    expect(() => loadAliasTable(bad)).toThrow(/reserved/i);
  });
});

describe('secret loading (fail-fast, design §6)', () => {
  it('reads all required secrets from env', () => {
    const secrets = loadSecrets(validEnv());
    expect(secrets.haToken).toBe('llat-token');
    expect(secrets.allowlistUuids.has('uuid-a')).toBe(true);
    expect(secrets.allowlistUuids.has('uuid-b')).toBe(true);
  });

  it('throws when a required secret is missing', () => {
    const env = validEnv();
    delete env.HA_TOKEN;
    expect(() => loadSecrets(env)).toThrow(/HA_TOKEN/);
  });

  it('throws when the allowlist is empty', () => {
    const env = validEnv();
    env.ALLOWLIST_UUIDS = '';
    expect(() => loadSecrets(env)).toThrow(/ALLOWLIST_UUIDS/);
  });
});

describe('loadConfig integration', () => {
  it('assembles tunables + aliases + secrets', () => {
    const cfg = loadConfig({ env: validEnv(), aliasPath: exampleAliases });
    expect(cfg.tunables.dedupTtlMs).toBe(90_000);
    expect(cfg.secrets.botNumber).toBe('+15550001111');
    expect(cfg.aliases.resolveVerb('פתח')).toBe('open');
  });
});
