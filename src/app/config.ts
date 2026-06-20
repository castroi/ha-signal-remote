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
export type Verb = 'open' | 'close' | 'stop' | 'on' | 'off';

export interface EntityDef {
  readonly canonical: string;
  readonly type: EntityType;
  readonly entityId: string;
  readonly completionTimeoutMs: number;
  readonly aliases: readonly string[];
}

interface RawAliasFile {
  verbs: Record<string, string[]>;
  entities: Record<
    string,
    { type: EntityType; entity_id: string; completion_timeout_ms: number; aliases: string[] }
  >;
  scopes: { all_covers: { word: string; expands_to_type: EntityType } };
}

export class AliasTable {
  readonly allCoversWord: string;
  readonly entities: ReadonlyMap<string, EntityDef>;
  private readonly aliasIndex: ReadonlyMap<string, EntityDef>;
  private readonly verbIndex: ReadonlyMap<string, Verb>;

  constructor(raw: RawAliasFile) {
    const entities = new Map<string, EntityDef>();
    const aliasIndex = new Map<string, EntityDef>();

    for (const [canonical, def] of Object.entries(raw.entities)) {
      const entity: EntityDef = {
        canonical,
        type: def.type,
        entityId: def.entity_id,
        completionTimeoutMs: def.completion_timeout_ms,
        aliases: def.aliases,
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
