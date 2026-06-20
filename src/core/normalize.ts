/**
 * Hebrew text normalization (design §4). Deterministic, pure, idempotent.
 *
 * Order matters: remove niqqud, fold final letters, strip the leading ה article,
 * collapse whitespace, trim. Normalization runs on the raw message before parsing
 * and before the dedup key is computed.
 */

// Hebrew points (niqqud) and cantillation marks: U+0591–U+05C7.
const NIQQUD = /[֑-ׇֽֿׁׂׅׄ]/g;

const FINAL_LETTERS: Record<string, string> = {
  ך: 'כ',
  ם: 'מ',
  ן: 'נ',
  ף: 'פ',
  ץ: 'צ',
};

function foldFinals(text: string): string {
  let out = '';
  for (const ch of text) {
    out += FINAL_LETTERS[ch] ?? ch;
  }
  return out;
}

/** Strip the leading ה article from each whitespace-separated token. */
function stripArticle(token: string): string {
  // Only strip if a stem remains (don't reduce a bare "ה" to empty).
  if (token.length > 1 && token.startsWith('ה')) {
    return token.slice(1);
  }
  return token;
}

export function normalize(input: string): string {
  const withoutNiqqud = input.normalize('NFC').replace(NIQQUD, '');
  const folded = foldFinals(withoutNiqqud);
  const tokens = folded
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map(stripArticle);
  return tokens.join(' ').trim();
}
