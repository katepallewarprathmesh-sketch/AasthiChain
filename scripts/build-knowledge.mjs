// Build the assistant's knowledge index from this repository's own docs.
//
// The assistant knew the property catalogue and nothing else, so every
// question about how the thing actually works ("what happens if nobody
// attests the refund", "which corridor is blocked and why", "how was the
// fraud model scored") was answered from whatever the model remembered about
// the world. That is the exact failure mode a settlement system cannot
// tolerate: a confident sentence with no source behind it.
//
// This turns the docs into retrievable sections. Nothing is summarised and
// nothing is rewritten: a section goes in as it was written, with the file it
// came from, so an answer can be traced back to a document a reader can open.
//
// Run: node scripts/build-knowledge.mjs
// Checked by tests/knowledge.test.mjs, which rebuilds it and fails if the
// committed index is stale.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const OUT = join(root, 'frontend', 'api', 'lib', 'knowledge-index.json');

// Docs that describe the system. Deliberately not the whole repository: a
// backlog, an audit of open problems and a deployment runbook are notes to
// ourselves, and an assistant quoting a to-do list as fact is worse than one
// that says it does not know.
const EXCLUDE = new Set([
  'BACKLOG.md', 'REPOSITORY_AUDIT.md', 'DEPLOYMENT.md', 'NEON.md', 'DEMO.md',
]);

const MAX_SECTION_CHARS = 1400;

function sources() {
  const docs = readdirSync(join(root, 'docs'))
    .filter((f) => f.endsWith('.md') && !EXCLUDE.has(f))
    .sort()
    .map((f) => ({ file: 'docs/' + f, label: f.replace(/\.md$/, '') }));
  return [{ file: 'README.md', label: 'README' }, ...docs];
}

// Markdown, minus the things that are noise once retrieved: code fences,
// images, link scaffolding and table pipes. The words survive; the syntax
// does not.
function plain(md) {
  return md
    // House style has no em dashes, and this file is generated prose that
    // older documents still carry a few of. Normalising here keeps the
    // committed artefact consistent with everything else written by hand.
    .replace(/\s*\u2014\s*/g, ': ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*\|/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Split on the second-level headings people actually write, and keep the
// heading: it is the best one-line description of what the section answers.
function sections(md) {
  const lines = md.split('\n');
  const out = [];
  let heading = 'Overview';
  let buf = [];
  const flush = () => {
    const text = plain(buf.join('\n'));
    if (text.length > 220) out.push({ heading, text });
    buf = [];
  };
  for (const line of lines) {
    const m = /^(#{1,3})\s+(.*)$/.exec(line);
    if (m && m[1].length <= 2) {
      flush();
      heading = m[2].trim();
      continue;
    }
    buf.push(line);
  }
  flush();
  // A very long section is cut on a paragraph boundary rather than mid
  // sentence, because half a sentence retrieved is a quote nobody can check.
  const sized = [];
  for (const s of out) {
    if (s.text.length <= MAX_SECTION_CHARS) { sized.push(s); continue; }
    let rest = s.text;
    let part = 1;
    while (rest.length) {
      let cut = rest.length <= MAX_SECTION_CHARS ? rest.length : rest.lastIndexOf('\n\n', MAX_SECTION_CHARS);
      if (cut < 400) cut = Math.min(rest.length, MAX_SECTION_CHARS);
      sized.push({ heading: part === 1 ? s.heading : `${s.heading} (continued)`, text: rest.slice(0, cut).trim() });
      rest = rest.slice(cut).trim();
      part += 1;
    }
  }
  return sized;
}

function build() {
  const entries = [];
  const digest = createHash('sha256');
  for (const src of sources()) {
    const md = readFileSync(join(root, src.file), 'utf8');
    digest.update(src.file).update('\0').update(md).update('\0');
    for (const s of sections(md)) {
      entries.push({ doc: src.label, file: src.file, heading: s.heading, text: s.text });
    }
  }
  return {
    builtBy: 'scripts/build-knowledge.mjs',
    note: 'Sections of this repository\'s own documentation, quoted as written. The assistant answers from these and names the document it used.',
    sourceDigest: digest.digest('hex'),
    sections: entries,
  };
}

const index = build();
writeFileSync(OUT, JSON.stringify(index, null, 2) + '\n');
console.log(`knowledge: ${index.sections.length} sections from ${new Set(index.sections.map((s) => s.file)).size} documents written to ${OUT.replace(root + '/', '')}`);
