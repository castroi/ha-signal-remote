import type { AliasTable, Verb } from '../app/config.js';
import { RESERVED_WORDS } from '../app/config.js';
import { normalize } from './normalize.js';

// Reserved control words, normalized to match normalized input tokens.
// We keep a map normalized->original so the control-reply carries the canonical word.
const NORMALIZED_RESERVED: ReadonlyMap<string, string> = new Map(
  [...RESERVED_WORDS].map((w) => [normalize(w), w]),
);

/**
 * Command parser (design §4). Matches normalized tokens against the verb/entity/
 * scope whitelists. Exact + prefix only; no fuzzy matching for covers (§2).
 *
 * The result is a discriminated union: every failure mode is its own typed value
 * so the reply layer (and audit log) can react precisely.
 */

export type Scope = { type: 'entity'; entityId: string } | { type: 'all-covers' };

export type ParseResult =
  | { kind: 'command'; verb: Verb; scope: Scope }
  // No recognized verb at all -> menu fallback.
  | { kind: 'no-verb'; normalized: string }
  // Verb recognized, but the target word is not a known entity -> echo + list.
  | { kind: 'entity-unknown'; verb: Verb; rejectedWord: string; validTargets: string[] }
  // Verb recognized, no target word supplied -> ask by name.
  | { kind: 'ambiguous'; verb: Verb; candidates: string[] }
  // A reserved control word (כן/לא/תפריט/עזרה/סטטוס) outside any matching context.
  | { kind: 'control-reply'; word: string };

export function parseCommand(raw: string, aliases: AliasTable): ParseResult {
  const normalized = normalize(raw);
  const tokens = normalized.split(' ').filter((t) => t.length > 0);

  // A single reserved control word (other than תריסים, which is a scope) is a
  // control reply, never a device command.
  if (tokens.length === 1) {
    const only = tokens[0]!;
    const canonical = NORMALIZED_RESERVED.get(only);
    if (canonical !== undefined && only !== aliases.allCoversWord) {
      return { kind: 'control-reply', word: canonical };
    }
  }

  // Find the first token that resolves to a verb.
  let verb: Verb | undefined;
  let verbIndex = -1;
  for (let i = 0; i < tokens.length; i++) {
    const v = aliases.resolveVerb(tokens[i]!);
    if (v) {
      verb = v;
      verbIndex = i;
      break;
    }
  }

  if (!verb) {
    return { kind: 'no-verb', normalized };
  }

  // Tokens after the verb are the target; skip the connective "את".
  const targetTokens = tokens.slice(verbIndex + 1).filter((t) => t !== 'את');

  if (targetTokens.length === 0) {
    return { kind: 'ambiguous', verb, candidates: aliases.allAliases() };
  }

  // All-covers scope word.
  if (targetTokens.some((t) => t === aliases.allCoversWord)) {
    return { kind: 'command', verb, scope: { type: 'all-covers' } };
  }

  // Try matching the target tokens against entity aliases. Aliases may be
  // multi-word ("חדר ילדים"), so try the joined remainder and each token.
  const joined = targetTokens.join(' ');
  const entity = aliases.resolveEntity(joined) ?? aliases.resolveEntity(targetTokens[0]!);

  if (!entity) {
    return {
      kind: 'entity-unknown',
      verb,
      rejectedWord: joined,
      validTargets: aliases.allAliases(),
    };
  }

  return { kind: 'command', verb, scope: { type: 'entity', entityId: entity.entityId } };
}
