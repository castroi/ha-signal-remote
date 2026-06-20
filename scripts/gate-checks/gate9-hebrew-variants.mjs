// Gate 9 probe (offline-automatable, design §10).
// Runs the real normalize + parse path over a table of real Hebrew phrasings and
// asserts each resolves to the expected verb/scope or the expected failure class.
//
// Usage: node scripts/gate-checks/gate9-hebrew-variants.mjs
// Requires: pnpm build (uses dist/).

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

const { loadAliasTable } = await import(resolve(root, 'dist/app/config.js'));
const { parseCommand } = await import(resolve(root, 'dist/core/parse.js'));

const aliases = loadAliasTable(resolve(root, 'config/aliases.example.yaml'));

// [input, expected] where expected is a predicate description.
const cases = [
  ['סגור את הסלון', (r) => r.kind === 'command' && r.verb === 'close' && r.scope.entityId === 'cover.living_room'],
  ['סְגוֹר הסלון', (r) => r.kind === 'command' && r.verb === 'close'],
  ['פתח תריסים', (r) => r.kind === 'command' && r.verb === 'open' && r.scope.type === 'all-covers'],
  ['הדלק גינה', (r) => r.kind === 'command' && r.verb === 'on' && r.scope.entityId === 'light.garden'],
  ['כבה את הגינה', (r) => r.kind === 'command' && r.verb === 'off'],
  ['סגור מטבח', (r) => r.kind === 'command' && r.scope.entityId === 'cover.kitchen'],
  ['סגור סלין', (r) => r.kind === 'entity-unknown'], // typo, no fuzzy
  ['בלאבלא', (r) => r.kind === 'no-verb'],
  ['סטטוס', (r) => r.kind === 'control-reply'],
  ['סגור', (r) => r.kind === 'ambiguous'],
];

let failures = 0;
for (const [input, predicate] of cases) {
  const r = parseCommand(input, aliases);
  const ok = predicate(r);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  "${input}" -> ${r.kind}${r.verb ? '/' + r.verb : ''}`);
}

if (failures > 0) {
  console.error(`\nGate 9: ${failures} case(s) failed`);
  process.exit(1);
}
console.log('\nGate 9: all Hebrew-variant cases resolved correctly (offline)');
