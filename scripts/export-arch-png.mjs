#!/usr/bin/env node
// Re-export docs/architecture.png from docs/architecture.svg.
//
// The SVG is the source and the PNG exists only because GitHub's README
// renderer will not show an SVG from a relative path. Keeping the export by
// hand meant the two drifted: the diagram would be edited and the PNG, which
// is the one almost everybody actually sees, would still show the old shape.
//
//   node scripts/export-arch-png.mjs
//
// Rendering is done by headless Chromium through playwright-core, because
// the diagram sets its type per element and the common SVG rasterisers
// (ImageMagick's internal MSVG in particular) quietly drop or re-flow it. If
// the renderer is not installed the script says so and exits non-zero rather
// than writing a worse PNG over a good one.
//
// Export settings, which must stay matched to the SVG:
//   width            the viewBox width
//   deviceScaleFactor 2, so the README's full-width render is not soft
//
// The screenshot is taken of an inline <svg> in a bare HTML page. Pointing
// the browser at the .svg file directly hangs on fullPage capture.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = new URL('../', import.meta.url);
const SVG = fileURLToPath(new URL('docs/architecture.svg', ROOT));
const PNG = fileURLToPath(new URL('docs/architecture.png', ROOT));
const SCALE = 2;

const svg = readFileSync(SVG, 'utf8');
const m = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
if (!m) {
  console.error('docs/architecture.svg has no viewBox, so the export size is unknown.');
  process.exit(1);
}
const [width, height] = [Number(m[1]), Number(m[2])];

let chromium;
try {
  ({ chromium } = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core'));
} catch {
  console.error('playwright-core is not available, so the PNG was not rewritten.');
  console.error('  npm i -g playwright-core && npx playwright-core install chromium');
  console.error('  (or set PLAYWRIGHT_CORE to an installed copy)');
  process.exit(1);
}

const dir = mkdtempSync(path.join(tmpdir(), 'arch-'));
const page = path.join(dir, 'arch.html');
writeFileSync(page,
  '<!doctype html><meta charset="utf-8">' +
  '<style>html,body{margin:0;padding:0;background:#F7F5F0}svg{display:block}</style>' + svg);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const p = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: SCALE });
await p.goto('file://' + page, { waitUntil: 'load' });
await p.waitForTimeout(500);
await p.screenshot({ path: PNG, clip: { x: 0, y: 0, width, height } });
await browser.close();

console.log(`wrote docs/architecture.png at ${width * SCALE}x${height * SCALE}`);
console.log('Flat-colour diagram: shrink it with');
console.log('  convert docs/architecture.png -strip -colors 128 PNG8:docs/architecture.png');
