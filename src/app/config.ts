import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { normalize } from '../core/normalize.js';

/**
 * All §9 tunables with their stated initial defaults. Every value is "tune on
 * hardware" but the defaults here must match the design doc exactly.
 */
export interface RateLimitRule {
  readonly max: number;
  readonly windowMs: number;
}

export interface Tunables {
  readonly freshnessWindowMs: number;
  readonly futureToleranceMs: number;
  readonly dedupTtlMs: number;
  readonly wsHealthyDebounceMs: number;
  readonly haReconnectDecisionWindowMs: number;
  readonly reconnectBackoffMinMs: number;
  readonly reconnectBackoffMaxMs: number;
  readonly rateLimitPerSender: RateLimitRule;
  readonly rateLimitGlobal: RateLimitRule;
  readonly confirmLanePerSenderPerMin: number;
  readonly clockSkewThresholdMs: number;
  readonly clockOfflineGraceMs: number;
  readonly confirmExpiryMs: number;
}

export const DEFAULT_TUNABLES: Tunables = {
  freshnessWindowMs: 30_000,
  futureToleranceMs: 10_000,
  dedupTtlMs: 90_000,
  wsHealthyDebounceMs: 10_000,
  haReconnectDecisionWindowMs: 30_000,
  reconnectBackoffMinMs: 1_000,
  reconnectBackoffMaxMs: 30_000,
  rateLimitPerSender: { max: 5, windowMs: 30_000 },
  rateLimitGlobal: { max: 15, windowMs: 30_000 },
  confirmLanePerSenderPerMin: 6,
  clockSkewThresholdMs: 30_000,
  clockOfflineGraceMs: 3_600_000,
  confirmExpiryMs: 20_000,
};

/** Reserved control words — never parsed as device names (design §4). */
export const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'כן',
  'לא',
  'תפריט',
  'עזרה',
  'סטטוס',
  'תריסים',
]);

export type EntityType = 'cover' | 'light';
export type Verb = 'open' | 'close' | 'stop' | 'on' | 'off' | 'open_to' | 'close_to';

export interface EntityDef {
  readonly canonical: string;
  readonly type: EntityType;
  readonly entityId: string;
  readonly completionTimeoutMs: number;
  readonly aliases: readonly string[];
  /** Target position (0–100) for the open_to verb; undefined = no preset (full-only). */
  readonly openPosition?: number | undefined;
  /** Target position (0–100) for the close_to verb; undefined = no preset (full-only). */
  readonly closePosition?: number | undefined;
  /** Completion tolerance band (%); resolved from per-cover override or the script default. */
  readonly tolerancePercent?: number | undefined;
}

/** Default completion tolerance band (%) when neither per-cover nor script-level override is set. */
export const DEFAULT_TOLERANCE_PERCENT = 3;

/**
 * Fallback help/menu text when the alias table has no `messages.help`. `{rooms}`
 * and `{lights}` are filled at render time from the configured entities so the
 * device list never drifts; a line whose placeholder resolves to empty is dropped.
 */
export const DEFAULT_HELP_TEMPLATE = [
  '🪟 תריסים — "פתח" / "סגור" / "עצור" + חדר',
  'חדרים: {rooms}',
  '',
  '📐 מצב שמור — "העלה" / "הנמך" + חדר',
  '',
  '💡 אורות — "הדלק" / "כבה" + שם',
  'אורות: {lights}',
  '',
  '🏠 כל התריסים — שלח "תריסים", ואז כן / לא',
  'ℹ️ מצב המערכת — שלח "סטטוס"',
].join('\n');

/** HA entity-id shape: `domain.object_id` (lowercase letters/underscore . lowercase alphanumeric/underscore). */
const ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/;

/** The HA scripts the bridge calls to drive covers to a preset position (design issue #1). */
export interface PositionScripts {
  readonly open: string;
  readonly close: string;
  readonly defaultTolerancePercent: number;
}

interface RawAliasFile {
  verbs: Record<string, string[]>;
  entities: Record<
    string,
    {
      type: EntityType;
      entity_id: string;
      completion_timeout_ms: number;
      aliases: string[];
      open_position?: number;
      close_position?: number;
      tolerance_percent?: number;
    }
  >;
  scopes: { all_covers: { word: string; expands_to_type: EntityType } };
  position_scripts?: { open: string; close: string; default_tolerance_percent?: number };
  messages?: { help?: string };
}

export class AliasTable {
  readonly allCoversWord: string;
  readonly entities: ReadonlyMap<string, EntityDef>;
  readonly positionScripts: PositionScripts | undefined;
  private readonly aliasIndex: ReadonlyMap<string, EntityDef>;
  private readonly verbIndex: ReadonlyMap<string, Verb>;
  private readonly helpTemplate: string;

  constructor(raw: RawAliasFile) {
    const entities = new Map<string, EntityDef>();
    const aliasIndex = new Map<string, EntityDef>();

    if (raw.position_scripts) {
      assertValidEntityId(raw.position_scripts.open, 'position_scripts.open');
      assertValidEntityId(raw.position_scripts.close, 'position_scripts.close');
      assertValidPercent(
        raw.position_scripts.default_tolerance_percent,
        'position_scripts',
        'default_tolerance_percent',
      );
    }
    const defaultTolerance =
      raw.position_scripts?.default_tolerance_percent ?? DEFAULT_TOLERANCE_PERCENT;
    this.positionScripts = raw.position_scripts
      ? {
          open: raw.position_scripts.open,
          close: raw.position_scripts.close,
          defaultTolerancePercent: defaultTolerance,
        }
      : undefined;

    let anyPreset = false;
    for (const [canonical, def] of Object.entries(raw.entities)) {
      assertValidEntityId(def.entity_id, `${canonical}.entity_id`);
      assertValidPosition(def.open_position, canonical, 'open_position');
      assertValidPosition(def.close_position, canonical, 'close_position');
      assertValidPercent(def.tolerance_percent, canonical, 'tolerance_percent');
      const hasPreset = def.open_position !== undefined || def.close_position !== undefined;
      anyPreset = anyPreset || hasPreset;
      const entity: EntityDef = {
        canonical,
        type: def.type,
        entityId: def.entity_id,
        completionTimeoutMs: def.completion_timeout_ms,
        aliases: def.aliases,
        openPosition: def.open_position,
        closePosition: def.close_position,
        // Resolve the completion band: per-cover override, else the script default.
        // Only meaningful for covers that have a preset target.
        tolerancePercent: hasPreset ? (def.tolerance_percent ?? defaultTolerance) : undefined,
      };
      entities.set(entity.entityId, entity);
      for (const alias of def.aliases) {
        if (RESERVED_WORDS.has(alias)) {
          throw new Error(
            `Alias table invalid: reserved control word "${alias}" cannot be an entity alias`,
          );
        }
        // Index by normalized form so lookups against normalized input match.
        aliasIndex.set(normalize(alias), entity);
      }
    }

    // Fail-fast: a preset position is unusable without the scripts that actuate it.
    if (anyPreset && this.positionScripts === undefined) {
      throw new Error(
        'Alias table invalid: an entity defines open_position/close_position but no position_scripts block is configured',
      );
    }

    const verbIndex = new Map<string, Verb>();
    for (const [verb, variants] of Object.entries(raw.verbs)) {
      for (const variant of variants) {
        verbIndex.set(normalize(variant), verb as Verb);
      }
    }

    this.entities = entities;
    this.aliasIndex = aliasIndex;
    this.verbIndex = verbIndex;
    this.allCoversWord = normalize(raw.scopes.all_covers.word);
    this.helpTemplate = raw.messages?.help ?? DEFAULT_HELP_TEMPLATE;
  }

  /**
   * Renders the configured help/menu text (item: configurable help, issue #21).
   * Fills `{rooms}` / `{lights}` with the display names (first alias) of the
   * configured cover / light entities in config order, and drops any line whose
   * placeholder resolves to empty so there is no dangling label or blank gap.
   */
  helpText(): string {
    const rooms = this.displayNames('cover').join(' · ');
    const lights = this.displayNames('light').join(' · ');
    return this.helpTemplate
      .split('\n')
      .filter(
        (line) =>
          !(line.includes('{rooms}') && rooms === '') &&
          !(line.includes('{lights}') && lights === ''),
      )
      .map((line) => line.split('{rooms}').join(rooms).split('{lights}').join(lights))
      .join('\n');
  }

  /** First (canonical) alias of each entity of a given type, in config order. */
  private displayNames(type: EntityType): string[] {
    const names: string[] = [];
    for (const entity of this.entities.values()) {
      const [first] = entity.aliases;
      if (entity.type === type && first) names.push(first);
    }
    return names;
  }

  resolveEntity(alias: string): EntityDef | undefined {
    return this.aliasIndex.get(normalize(alias));
  }

  /** Exact or prefix match against verb variants (design §2: no fuzzy). */
  resolveVerb(token: string): Verb | undefined {
    const norm = normalize(token);
    const exact = this.verbIndex.get(norm);
    if (exact) return exact;
    for (const [variant, verb] of this.verbIndex) {
      if (variant.startsWith(norm) || norm.startsWith(variant)) return verb;
    }
    return undefined;
  }

  coverEntityIds(): string[] {
    return [...this.entities.values()].filter((e) => e.type === 'cover').map((e) => e.entityId);
  }

  /**
   * Returns the canonical (display) alias names for use in user-facing replies such
   * as entity-unknown and ambiguous messages (item 10). The alias index is keyed by
   * normalized form; we return the original alias strings from each EntityDef so the
   * user sees recognizable Hebrew names rather than normalized stems.
   */
  allAliases(): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const entity of this.entities.values()) {
      for (const alias of entity.aliases) {
        if (!seen.has(alias)) {
          seen.add(alias);
          result.push(alias);
        }
      }
    }
    return result;
  }
}

function assertValidPosition(value: number | undefined, canonical: string, field: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error(
      `Alias table invalid: ${canonical}.${field} must be an integer 0–100, got ${value}`,
    );
  }
}

/** Same 0–100 integer constraint as a position, used for tolerance bands. */
function assertValidPercent(value: number | undefined, canonical: string, field: string): void {
  assertValidPosition(value, canonical, field);
}

/** Reject a malformed HA entity id before it reaches a request URL or body. */
function assertValidEntityId(value: string, field: string): void {
  if (!ENTITY_ID_RE.test(value)) {
    throw new Error(
      `Alias table invalid: ${field} "${value}" is not a valid HA entity id (domain.object_id)`,
    );
  }
}

export function loadAliasTable(path: string): AliasTable {
  const raw = parseYaml(readFileSync(path, 'utf8')) as RawAliasFile;
  return new AliasTable(raw);
}

export interface Secrets {
  readonly haToken: string;
  readonly haBaseUrl: string;
  readonly signalApiUrl: string;
  readonly botNumber: string;
  readonly allowlistUuids: ReadonlySet<string>;
  readonly auditSalt: string;
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required secret: ${key}`);
  }
  return value;
}

export function loadSecrets(env: NodeJS.ProcessEnv): Secrets {
  const allowlistRaw = requireEnv(env, 'ALLOWLIST_UUIDS');
  const allowlistUuids = new Set(
    allowlistRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  if (allowlistUuids.size === 0) {
    throw new Error('Missing required secret: ALLOWLIST_UUIDS (no UUIDs parsed)');
  }
  return {
    haToken: requireEnv(env, 'HA_TOKEN'),
    haBaseUrl: requireEnv(env, 'HA_BASE_URL'),
    signalApiUrl: requireEnv(env, 'SIGNAL_API_URL'),
    botNumber: requireEnv(env, 'BOT_NUMBER'),
    allowlistUuids,
    auditSalt: requireEnv(env, 'AUDIT_SALT'),
  };
}

export interface Config {
  readonly tunables: Tunables;
  readonly aliases: AliasTable;
  readonly secrets: Secrets;
}

export interface LoadConfigOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly aliasPath: string;
  readonly tunables?: Tunables;
}

export function loadConfig(opts: LoadConfigOptions): Config {
  return {
    tunables: opts.tunables ?? DEFAULT_TUNABLES,
    aliases: loadAliasTable(opts.aliasPath),
    secrets: loadSecrets(opts.env ?? process.env),
  };
}
