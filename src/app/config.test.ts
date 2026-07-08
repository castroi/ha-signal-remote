import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  DEFAULT_TUNABLES,
  RESERVED_WORDS,
  AliasTable,
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
  SIGNAL_TOKEN: 'wrapper-token',
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

  it('resolves the preset (to-position) verbs', () => {
    const table = loadAliasTable(exampleAliases);
    expect(table.resolveVerb('העלה')).toBe('open_to');
    expect(table.resolveVerb('הנמך')).toBe('close_to');
  });

  it('exposes per-cover preset positions and tolerance', () => {
    const table = loadAliasTable(exampleAliases);
    const salon = table.entities.get('cover.living_room');
    expect(salon?.openPosition).toBe(80);
    expect(salon?.closePosition).toBe(30);
    // per-cover override
    expect(salon?.tolerancePercent).toBe(5);
    // a cover without an override inherits the default tolerance
    expect(table.entities.get('cover.kitchen')?.tolerancePercent).toBe(3);
    // a cover with no preset positions leaves them undefined (full-only)
    const kids = table.entities.get('cover.kids_room');
    expect(kids?.openPosition).toBeUndefined();
    expect(kids?.closePosition).toBeUndefined();
  });

  it('exposes the position-script entities and default tolerance', () => {
    const table = loadAliasTable(exampleAliases);
    expect(table.positionScripts?.open).toBe('script.covers_up');
    expect(table.positionScripts?.close).toBe('script.covers_down');
    expect(table.positionScripts?.defaultTolerancePercent).toBe(3);
  });

  it('loads switch entities (issue #25)', () => {
    const table = loadAliasTable(exampleAliases);
    expect(table.entities.get('switch.fan')?.type).toBe('switch');
    expect(table.entities.get('switch.garden_socket')?.type).toBe('switch');
    expect(table.resolveEntity('מאוורר')?.entityId).toBe('switch.fan');
    expect(table.resolveEntity('שקע')?.entityId).toBe('switch.garden_socket');
    // switches never join the all-covers scope
    expect(table.coverEntityIds()).not.toContain('switch.fan');
  });
});

describe('help text (issue #21)', () => {
  type Raw = ConstructorParameters<typeof AliasTable>[0];
  const cover = (aliases: string[], entity_id: string) => ({
    type: 'cover',
    entity_id,
    completion_timeout_ms: 30_000,
    aliases,
  });
  const light = (aliases: string[], entity_id: string) => ({
    type: 'light',
    entity_id,
    completion_timeout_ms: 5_000,
    aliases,
  });
  const sw = (aliases: string[], entity_id: string) => ({
    type: 'switch',
    entity_id,
    completion_timeout_ms: 5_000,
    aliases,
  });
  const make = (entities: Record<string, unknown>, help?: string): AliasTable =>
    new AliasTable({
      verbs: { open: ['פתח'], close: ['סגור'] },
      entities,
      scopes: { all_covers: { word: 'תריסים', expands_to_type: 'cover' } },
      ...(help !== undefined ? { messages: { help } } : {}),
    } as unknown as Raw);

  it('fills {rooms} and {lights} from the first alias of each entity, in config order', () => {
    const table = make(
      {
        salon: cover(['סלון'], 'cover.living_room'),
        kitchen: cover(['מטבח'], 'cover.kitchen'),
        garden: light(['גינה'], 'light.garden'),
      },
      'חדרים: {rooms}\nאורות: {lights}',
    );
    expect(table.helpText()).toBe('חדרים: סלון · מטבח\nאורות: גינה');
  });

  it('uses only the first alias as the display name', () => {
    const table = make(
      { kids: cover(['חדר ילדים', 'ילדים'], 'cover.kids_room') },
      'חדרים: {rooms}',
    );
    expect(table.helpText()).toBe('חדרים: חדר ילדים');
  });

  it('drops a line whose placeholder resolves to empty, keeping other lines', () => {
    const table = make(
      { salon: cover(['סלון'], 'cover.living_room') },
      '🪟 תריסים\nחדרים: {rooms}\nאורות: {lights}\nℹ️ סטטוס',
    );
    expect(table.helpText()).toBe('🪟 תריסים\nחדרים: סלון\nℹ️ סטטוס');
  });

  it('fills {switches} from switch entities and drops the line when none exist (issue #25)', () => {
    const withSwitches = make(
      {
        garden: light(['גינה'], 'light.garden'),
        fan: sw(['מאוורר'], 'switch.fan'),
        socket: sw(['שקע'], 'switch.garden_socket'),
      },
      'אורות: {lights}\nמתגים: {switches}',
    );
    expect(withSwitches.helpText()).toBe('אורות: גינה\nמתגים: מאוורר · שקע');

    const noSwitches = make(
      { garden: light(['גינה'], 'light.garden') },
      'אורות: {lights}\nמתגים: {switches}\nℹ️ סטטוס',
    );
    expect(noSwitches.helpText()).toBe('אורות: גינה\nℹ️ סטטוס');
  });

  it('falls back to the built-in default when messages.help is absent', () => {
    const table = make({ salon: cover(['סלון'], 'cover.living_room') });
    const text = table.helpText();
    expect(text).toContain('מצב המערכת');
    expect(text).toContain('חדרים: סלון');
    expect(text).not.toContain('{rooms}');
    expect(text).not.toContain('{lights}');
  });
});

describe('alias table validation (issue #1 hardening)', () => {
  // These build deliberately-malformed alias tables to assert load-time rejection,
  // so the raw shape is cast to the constructor's parameter type.
  type Raw = ConstructorParameters<typeof AliasTable>[0];
  const cover = (extra: Record<string, unknown>) => ({
    type: 'cover',
    entity_id: 'cover.living_room',
    completion_timeout_ms: 30_000,
    aliases: ['סלון'],
    ...extra,
  });
  const scripts = { open: 'script.covers_up', close: 'script.covers_down' };
  const base = (entitySalon: Record<string, unknown>, positionScripts: unknown = scripts): Raw =>
    ({
      verbs: { open: ['פתח'], close: ['סגור'], open_to: ['העלה'], close_to: ['הנמך'] },
      entities: { salon: entitySalon },
      scopes: { all_covers: { word: 'תריסים', expands_to_type: 'cover' } },
      ...(positionScripts ? { position_scripts: positionScripts } : {}),
    }) as unknown as Raw;

  it('rejects an out-of-range position', () => {
    expect(() => new AliasTable(base(cover({ open_position: 150 })))).toThrow(/0–100/);
  });

  it('rejects a non-integer position', () => {
    expect(() => new AliasTable(base(cover({ close_position: 50.5 })))).toThrow(/0–100/);
  });

  it('rejects an out-of-range tolerance_percent', () => {
    expect(() => new AliasTable(base(cover({ open_position: 80, tolerance_percent: 200 })))).toThrow(
      /0–100/,
    );
  });

  it('rejects a preset position with no position_scripts block', () => {
    expect(() => new AliasTable(base(cover({ open_position: 80 }), null))).toThrow(
      /position_scripts/,
    );
  });

  it('rejects a malformed entity id', () => {
    expect(() => new AliasTable(base(cover({ entity_id: 'cover bad id' })))).toThrow(
      /valid HA entity id/,
    );
  });

  it('rejects a malformed position-script id', () => {
    expect(() =>
      new AliasTable(base(cover({ open_position: 80 }), { open: 'not a script', close: 'script.x' })),
    ).toThrow(/valid HA entity id/);
  });
});

describe('secret loading (fail-fast, design §6)', () => {
  it('reads all required secrets from env', () => {
    const secrets = loadSecrets(validEnv());
    expect(secrets.haToken).toBe('llat-token');
    expect(secrets.signalToken).toBe('wrapper-token');
    expect(secrets.allowlistUuids.has('uuid-a')).toBe(true);
    expect(secrets.allowlistUuids.has('uuid-b')).toBe(true);
  });

  it('throws when a required secret is missing', () => {
    const env = validEnv();
    delete env.HA_TOKEN;
    expect(() => loadSecrets(env)).toThrow(/HA_TOKEN/);
  });

  it('throws when SIGNAL_TOKEN is missing', () => {
    const env = validEnv();
    delete env.SIGNAL_TOKEN;
    expect(() => loadSecrets(env)).toThrow(/SIGNAL_TOKEN/);
  });

  it('throws when the allowlist is empty', () => {
    const env = validEnv();
    env.ALLOWLIST_UUIDS = '';
    expect(() => loadSecrets(env)).toThrow(/ALLOWLIST_UUIDS/);
  });

  it('reads SIGNAL_TOKEN from SIGNAL_TOKEN_FILE, which takes precedence over the env var', () => {
    const tokenFile = join(mkdtempSync(join(tmpdir(), 'ha-secret-')), 'signal_token');
    writeFileSync(tokenFile, 'file-token\n'); // trailing newline must be trimmed
    const env = validEnv();
    env.SIGNAL_TOKEN = 'env-token';
    env.SIGNAL_TOKEN_FILE = tokenFile;
    expect(loadSecrets(env).signalToken).toBe('file-token');
  });

  it('throws when the secret file is empty', () => {
    const tokenFile = join(mkdtempSync(join(tmpdir(), 'ha-secret-')), 'signal_token');
    writeFileSync(tokenFile, '  \n');
    const env = validEnv();
    env.SIGNAL_TOKEN_FILE = tokenFile;
    expect(() => loadSecrets(env)).toThrow(/empty/);
  });

  it('throws a clean error (code + path, not contents) when the secret file is unreadable', () => {
    const env = validEnv();
    env.SIGNAL_TOKEN_FILE = join(tmpdir(), 'no-such-dir', 'signal_token');
    expect(() => loadSecrets(env)).toThrow(/Cannot read secret file for SIGNAL_TOKEN \(ENOENT\)/);
  });

  it('trims surrounding whitespace from the SIGNAL_TOKEN env fallback', () => {
    const env = validEnv();
    env.SIGNAL_TOKEN = '  spaced-token\n';
    expect(loadSecrets(env).signalToken).toBe('spaced-token');
  });

  it('throws when the SIGNAL_TOKEN env value is whitespace-only', () => {
    const env = validEnv();
    env.SIGNAL_TOKEN = '   ';
    expect(() => loadSecrets(env)).toThrow(/Missing required secret: SIGNAL_TOKEN/);
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
