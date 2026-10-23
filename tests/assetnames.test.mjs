// A ledger key is not a property name.
//
// Every property on the rail is identified by a key like
// PROP-GREEN-VALLEY-PUNE-001. The key has to stay: the pilot ISIN is derived
// from it, settled instructions refer to it, and blocks already written name
// it. What it must never be is the thing a person reads or is asked to type,
// because a screen that does that looks like a database with a web page
// bolted on.
//
// These checks hold that line: the catalogue carries a human title for every
// asset, the screens resolve keys through the shared helper, and no screen
// offers a raw key as an example of what to type.
//
//   node tests/assetnames.test.mjs          (BASE=http://localhost:8080)

import { readFileSync, readdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8080';
let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

const src = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

const run = async () => {
  console.log('Asset names');

  // 1. Every catalogued property has a title and a city to show instead.
  const catalogue = JSON.parse(src('frontend/api/lib/catalogue.json'));
  ok('the catalogue is not empty', catalogue.length > 0);
  const untitled = catalogue.filter(p => !String(p.title || '').trim());
  ok('every property has a human title', untitled.length === 0,
    untitled.map(p => p.assetId).join(', '));
  const placeless = catalogue.filter(p => !(p.location && (p.location.city || p.location.state)));
  ok('every property has a place', placeless.length === 0,
    placeless.map(p => p.assetId).join(', '));
  const keyAsTitle = catalogue.filter(p => /^PROP[-_]/i.test(String(p.title || '')));
  ok('no title is just the key again', keyAsTitle.length === 0,
    keyAsTitle.map(p => p.assetId).join(', '));

  // 2. The shared helper exists and degrades to something readable.
  const helper = src('frontend/src/lib/assetNames.js');
  ok('the shared naming helper exports a fallback',
    helper.includes('export function prettifyAssetId') && helper.includes('export function labelFor'));

  const { prettifyAssetId, labelFor, labelForProperty } =
    await import('../frontend/src/lib/assetNames.js');
  ok('an unknown key still reads as words',
    prettifyAssetId('PROP-GREEN-VALLEY-PUNE-001') === 'Green Valley Pune (001)',
    prettifyAssetId('PROP-GREEN-VALLEY-PUNE-001'));
  ok('a known key resolves to its title',
    labelFor('PROP-GREEN-VALLEY-PUNE-001', catalogue).startsWith('Green Valley Villas'),
    labelFor('PROP-GREEN-VALLEY-PUNE-001', catalogue));
  ok('a title that already names the city is not given it twice',
    !/Pune.*Pune/.test(labelForProperty(catalogue[0])), labelForProperty(catalogue[0]));

  // 3. No screen asks a person to type a key by showing one as the example.
  const pagesDir = new URL('../frontend/src/pages/', import.meta.url);
  const offenders = [];
  for (const f of readdirSync(pagesDir)) {
    if (!f.endsWith('.jsx')) continue;
    const text = readFileSync(new URL(f, pagesDir), 'utf8');
    for (const line of text.split('\n')) {
      if (/placeholder\s*=/.test(line) && /PROP-[A-Z]/.test(line)) offenders.push(f + ': ' + line.trim());
    }
  }
  ok('no placeholder offers a raw ledger key as an example', offenders.length === 0,
    offenders.join('\n       '));

  // 4. The screens that pick a property resolve the name rather than printing
  //    the key on its own.
  for (const page of ['CrossBorder.jsx', 'SecondaryMarket.jsx', 'UMISettlement.jsx']) {
    const text = src('frontend/src/pages/' + page);
    ok(page + ' names properties through the shared helper',
      /labelFor|propLabel|prettifyAssetId/.test(text));
  }

  // 4b. A dropdown that offers assets must offer names, not keys. The
  //     generic shape of the bug is an option whose label is the same
  //     identifier as its value, which is how the cross-ledger transfer
  //     panel ended up listing raw PROP-<uuid> keys long after the pages
  //     had been fixed. Components were never scanned, only pages.
  const srcDirs = ['frontend/src/pages/', 'frontend/src/components/'];
  const rawOptions = [];
  for (const dir of srcDirs) {
    const d = new URL('../' + dir, import.meta.url);
    for (const f of readdirSync(d)) {
      if (!f.endsWith('.jsx')) continue;
      const text = readFileSync(new URL(f, d), 'utf8');
      // <option key={a} value={a}>{a}</option>: value and label identical.
      const re = /<option[^>]*value=\{(\w+)\}[^>]*>\{\1\}</g;
      let m;
      while ((m = re.exec(text))) {
        // Participant identifiers, cities and type filters are shown as
        // themselves everywhere (investor1 is the name, Pune is the name),
        // so only asset collections are held to this rule.
        const before = text.slice(Math.max(0, m.index - 160), m.index);
        if (/participants|holders|roles|members|counterparty|investor1|cities|types|statuses|currencies|coins/.test(before)) continue;
        rawOptions.push(dir + f + ': option labelled by {' + m[1] + '}');
      }
    }
  }
  ok('no dropdown labels an asset with its own ledger key', rawOptions.length === 0,
    rawOptions.join('\n       '));

  ok('the cross-ledger transfer panel names assets through the shared helper',
    /labelForProperty|prettifyAssetId/.test(src('frontend/src/components/InteropPanel.jsx')));

  // 5. No real third-party company is used as a property name.
  const banned = ['indiabulls', 'godrej', 'dlf', 'lodha', 'prestige estates'];
  const hits = [];
  for (const p of catalogue) {
    const hay = (String(p.title) + ' ' + String(p.description || '')).toLowerCase();
    for (const b of banned) if (hay.includes(b)) hits.push(p.assetId + ' uses ' + b);
  }
  ok('no catalogued property borrows a real company name', hits.length === 0, hits.join(', '));

  // 6. Served data still carries the title, which is what the screens read.
  try {
    const r = await fetch(BASE + '/api/properties');
    const d = await r.json();
    const list = (Array.isArray(d) ? d : d.properties || []);
    // Listings created at runtime have no title by design; the catalogued
    // ones must keep theirs all the way to the browser.
    const want = new Set(catalogue.map(p => p.assetId));
    const served = list.filter(p => want.has(p.assetId));
    const missing = served.filter(p => !String(p.title || '').trim());
    ok('catalogued properties keep their title all the way to the browser',
      served.length > 0 && missing.length === 0, missing.map(p => p.assetId).join(', '));
    ok('an untitled runtime listing is named, not left blank',
      prettifyAssetId('PROP-22c8e455-e88d-4606-abbd-422d4147f564').startsWith('Untitled listing'),
      prettifyAssetId('PROP-22c8e455-e88d-4606-abbd-422d4147f564'));
  } catch (e) {
    ok('the properties API returns titles, not only keys', false, String(e.message));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
};

run().catch((e) => { console.error(e); process.exit(1); });
