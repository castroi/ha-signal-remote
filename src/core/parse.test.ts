import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadAliasTable } from '../app/config.js';
import { parseCommand } from './parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const aliases = loadAliasTable(resolve(here, '../../config/aliases.example.yaml'));

describe('parseCommand (design §4 failure taxonomy)', () => {
  it('resolves a single-entity cover command', () => {
    const r = parseCommand('סגור את הסלון', aliases);
    expect(r.kind).toBe('command');
    if (r.kind === 'command') {
      expect(r.verb).toBe('close');
      expect(r.scope).toEqual({ type: 'entity', entityId: 'cover.living_room' });
    }
  });

  it('resolves a light command', () => {
    const r = parseCommand('הדלק גינה', aliases);
    expect(r.kind).toBe('command');
    if (r.kind === 'command') {
      expect(r.verb).toBe('on');
      expect(r.scope).toEqual({ type: 'entity', entityId: 'light.garden' });
    }
  });

  it('resolves bare תריסים to the all-covers scope', () => {
    const r = parseCommand('סגור תריסים', aliases);
    expect(r.kind).toBe('command');
    if (r.kind === 'command') {
      expect(r.verb).toBe('close');
      expect(r.scope).toEqual({ type: 'all-covers' });
    }
  });

  it('no verb / gibberish -> menu fallback', () => {
    const r = parseCommand('בלאבלא משהו', aliases);
    expect(r.kind).toBe('no-verb');
  });

  it('verb known but entity unknown -> echo + list valid targets', () => {
    const r = parseCommand('סגור מוסך', aliases);
    expect(r.kind).toBe('entity-unknown');
    if (r.kind === 'entity-unknown') {
      expect(r.rejectedWord).toContain('מוסכ');
      expect(r.validTargets.length).toBeGreaterThan(0);
    }
  });

  it('verb only, no entity at all -> ambiguous, ask by name', () => {
    const r = parseCommand('סגור', aliases);
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') {
      expect(r.candidates.length).toBeGreaterThan(0);
    }
  });

  it('reserved confirm words כן/לא are surfaced as control replies, never entities', () => {
    const yes = parseCommand('כן', aliases);
    expect(yes.kind).toBe('control-reply');
    if (yes.kind === 'control-reply') expect(yes.word).toBe('כן');

    const no = parseCommand('לא', aliases);
    expect(no.kind).toBe('control-reply');
  });

  it('reserved menu/help/status words are control replies', () => {
    expect(parseCommand('תפריט', aliases).kind).toBe('control-reply');
    expect(parseCommand('עזרה', aliases).kind).toBe('control-reply');
    expect(parseCommand('סטטוס', aliases).kind).toBe('control-reply');
  });

  it('covers reject typos — no fuzzy matching (design §2)', () => {
    // "סלין" is a typo of "סלון" and must NOT resolve to a cover.
    const r = parseCommand('סגור סלין', aliases);
    expect(r.kind).toBe('entity-unknown');
  });

  it('a reserved word never resolves to a device entity', () => {
    const r = parseCommand('סגור תריסים', aliases);
    // resolves to all-covers scope, never to an entity named after a reserved word
    expect(r.kind).toBe('command');
    if (r.kind === 'command') expect(r.scope.type).toBe('all-covers');
  });
});
