// The frontend inspector: rules that are measurable, measured.
//
// Visual quality is mostly judgement and cannot be asserted. A handful of
// things can be, and they are the ones that make an interface look assembled
// by a machine rather than designed: a palette with a hundred colours in it,
// a type scale with every half point in it, decorative gradients, shadows on
// things that are not floating, and rows of tiny uppercase labels.
//
// Two kinds of check here.
//
//   HARD    the rule holds everywhere, now. Breaking it fails the build.
//   RATCHET the codebase already violates it dozens of times. The count is
//           recorded as a budget that may fall and may not rise. New code
//           cannot add to the pile, and every cleanup tightens the budget
//           automatically when someone lowers the number here.
//
// A ratchet is honest about where we are. A hard rule we cannot pass today
// would have to be disabled, and a disabled rule protects nothing.
//
// Landing.jsx is excluded by instruction: it is frozen and not to be edited.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'frontend', 'src');
const FROZEN = ['Landing.jsx'];

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  ok   ${name}`);
    pass++;
  } else {
    console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
    fail++;
  }
};

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(jsx|js)$/.test(entry.name) && !FROZEN.includes(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(SRC).map((path) => ({ path, src: readFileSync(path, 'utf8') }));
const all = files.map((f) => f.src).join('\n');
const count = (re) => (all.match(re) || []).length;
const where = (re) => files.filter((f) => re.test(f.src)).map((f) => f.path.replace(SRC + '/', ''));

console.log(`\n  inspecting ${files.length} files under frontend/src (Landing.jsx frozen, excluded)\n`);

/* ---------------------------------------------------------------- HARD */

// A gradient is the single clearest tell of generated design, and it is
// never the only way to express whatever it was expressing.
ok('no gradients', count(/linear-gradient|radial-gradient|conic-gradient/g) === 0,
  where(/linear-gradient|radial-gradient/).join(', '));

// Glass is a 2021 costume: backdrop blur panels and floating pill navigation.
ok('no backdrop blur', count(/backdropFilter|backdrop-filter/g) === 0,
  where(/backdropFilter/).join(', '));

// Shadows belong on things that genuinely float. Everything else is
// separated from the page by a step in tone.
const FLOATS = ['NotificationBell.jsx', 'AasthiAI.jsx', 'MoreMenu.jsx', 'App.jsx'];
const shadowOffenders = files
  .filter((f) => /boxShadow:\s*'(?!none)/.test(f.src))
  .map((f) => f.path.split('/').pop())
  .filter((name) => !FLOATS.includes(name));
ok('shadows only on menus and dialogs', shadowOffenders.length === 0, shadowOffenders.join(', '));

// An emoji is not an icon and is not a picture. It renders differently on
// every platform and it reads as a placeholder for art nobody made. The
// range is deliberately the pictograph blocks only: a check mark, a cross,
// a star and a four-pointed spark are typography and are allowed to stay.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F0FF}]/gu;
ok('no emoji in the interface', count(EMOJI) === 0, where(EMOJI).slice(0, 4).join(', '));

// The tokens exist and carry the things the product actually needs.
const tokens = readFileSync(join(SRC, 'lib', 'tokens.js'), 'utf8');
ok('tokens define one accent, one ink and one ground', /accent:/.test(tokens) && /ink:/.test(tokens) && /ground:/.test(tokens));
ok('tokens carry tabular figures for money', /tabular-nums/.test(tokens));
ok('tokens distinguish a pending row from a settled one', /pending:/.test(tokens) && /settled:/.test(tokens));

/* ------------------------------------------------------------- RATCHET */

// Lower a budget whenever you clean up. Never raise one.
const BUDGET = {
  colours: 105,
  fontSizes: 34,
  uppercaseLabels: 41,
  monospace: 47,
};

const ratchet = (name, actual, budget, note) => {
  if (actual > budget) {
    console.log(`  FAIL ${name}: ${actual}, budget ${budget}. ${note}`);
    fail++;
  } else if (actual < budget) {
    console.log(`  ok   ${name}: ${actual}, budget ${budget}. Lower the budget in this file to ${actual}.`);
    pass++;
  } else {
    console.log(`  ok   ${name}: ${actual}, at budget`);
    pass++;
  }
};

const colours = new Set((all.match(/#[0-9a-fA-F]{3,8}\b/g) || []).map((c) => c.toLowerCase()));
ratchet('distinct hex colours', colours.size, BUDGET.colours,
  'Use frontend/src/lib/tokens.js instead of a new hex.');

const sizes = new Set((all.match(/fontSize:\s*'?"?(\d+(?:\.\d+)?)/g) || []).map((m) => m.split(/:\s*'?"?/)[1]));
ratchet('distinct font sizes', sizes.size, BUDGET.fontSizes,
  'Seven steps are defined in tokens.js; a size between two of them is not a hierarchy.');

ratchet('tiny uppercase labels', count(/textTransform:\s*'uppercase'/g), BUDGET.uppercaseLabels,
  'Sentence case at a readable size says the same thing.');

ratchet('monospace outside code', count(/monospace/g), BUDGET.monospace,
  'Monospace is correct for a hash or an identifier and is costume anywhere else.');

/* --------------------------------------------------------------- close */

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
