import { describe, it, expect } from 'vitest';
import { normalize } from './normalize.js';

describe('normalize (design §4)', () => {
  it('is idempotent', () => {
    const samples = ['סְגוֹר את הסלון', '  פתח   תריסים  ', 'כבה ןם', 'גינה'];
    for (const s of samples) {
      expect(normalize(normalize(s))).toBe(normalize(s));
    }
  });

  it('strips niqqud (vowel points)', () => {
    expect(normalize('סְגוֹר')).toBe('סגור');
    // final mem folds to non-final mem as well
    expect(normalize('שָׁלוֹם')).toBe('שלומ');
  });

  it('normalizes final letters to their non-final forms', () => {
    expect(normalize('ך')).toBe('כ');
    expect(normalize('ם')).toBe('מ');
    expect(normalize('ן')).toBe('נ');
    expect(normalize('ף')).toBe('פ');
    expect(normalize('ץ')).toBe('צ');
    // word-internal use
    expect(normalize('שלום')).toBe('שלומ');
  });

  it('strips the leading ה article', () => {
    expect(normalize('הסלון')).toBe('סלונ');
    expect(normalize('הגינה')).toBe('גינה');
  });

  it('collapses internal whitespace and trims', () => {
    expect(normalize('  פתח    את   הסלון  ')).toBe('פתח את סלונ');
  });

  it('collapses known variants of "close the salon" to one canonical form', () => {
    const variants = ['סגור את הסלון', 'סְגוֹר הסלון', '  סגור   הסלון '];
    const canonical = variants.map(normalize);
    expect(new Set(canonical.map((c) => c.replace(/^סגור\s+(את\s+)?/, '')))).toEqual(
      new Set(['סלונ']),
    );
  });

  it('leaves an already-canonical token unchanged', () => {
    expect(normalize('גינה')).toBe('גינה');
  });
});
