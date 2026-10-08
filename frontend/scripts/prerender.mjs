// Write a real HTML file per route after the Vite build.
//
// This is a single-page app: Vercel rewrites every unmatched path to
// /index.html, so until now every URL on the site was served the same head.
// src/lib/seo.js fixes the head after React mounts, which is fine for
// Googlebot (it renders JavaScript) and useless for everyone else. Bing's
// crawler largely does not render, and ChatGPT's search leans on Bing's
// index — so the crawlers most likely to cite the site were the ones seeing
// fourteen identical pages.
//
// So: take the built dist/index.html, rewrite its head once per known route,
// and drop the result at dist/<route>/index.html. Vercel serves a matching
// file before it consults the rewrite rules, so these win and the SPA
// fallback still covers anything dynamic (/property/:id).
//
// ROUTE_SEO stays the only place route metadata is written. This script and
// the runtime both read it, so a page cannot have one title before hydration
// and a different one after.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROUTE_SEO, SITE_NAME, SITE_URL, DEFAULT_IMAGE } from '../src/lib/seo.js';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '..', 'dist');

// Attribute values land inside double quotes, so those are what must not
// escape. Descriptions legitimately contain & and ' (₹500, "SEBI's").
const attr = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Replace a tag if the template already has it, otherwise append to <head>.
// Appending matters: the template has no twitter:url, and a future key added
// to ROUTE_SEO should not silently go missing from the static HTML.
function upsert(html, matcher, tag) {
  if (matcher.test(html)) return html.replace(matcher, tag);
  return html.replace('</head>', `  ${tag}\n</head>`);
}

function meta(html, kind, key, content) {
  const re = new RegExp(`<meta\\s+${kind}="${key}"[^>]*>`, 'i');
  return upsert(html, re, `<meta ${kind}="${key}" content="${attr(content)}" />`);
}

function headFor(template, path, seo) {
  const url = SITE_URL + (path === '/' ? '/' : path);
  let html = template;

  html = upsert(html, /<title>[\s\S]*?<\/title>/i, `<title>${attr(seo.title)}</title>`);
  html = meta(html, 'name', 'description', seo.description);
  html = meta(html, 'name', 'robots', seo.noindex ? 'noindex, follow' : 'index, follow');
  html = upsert(html, /<link\s+rel="canonical"[^>]*>/i, `<link rel="canonical" href="${attr(url)}" />`);

  html = meta(html, 'property', 'og:title', seo.title);
  html = meta(html, 'property', 'og:description', seo.description);
  html = meta(html, 'property', 'og:url', url);
  html = meta(html, 'property', 'og:type', 'website');
  html = meta(html, 'property', 'og:site_name', SITE_NAME);
  html = meta(html, 'property', 'og:image', seo.image || DEFAULT_IMAGE);
  html = meta(html, 'name', 'twitter:card', 'summary_large_image');
  html = meta(html, 'name', 'twitter:title', seo.title);
  html = meta(html, 'name', 'twitter:description', seo.description);
  html = meta(html, 'name', 'twitter:image', seo.image || DEFAULT_IMAGE);

  return html;
}

async function main() {
  const template = await readFile(join(dist, 'index.html'), 'utf8');
  let written = 0;

  for (const [path, seo] of Object.entries(ROUTE_SEO)) {
    if (!seo || !seo.title || !seo.description) {
      throw new Error(`ROUTE_SEO["${path}"] is missing a title or description`);
    }
    const html = headFor(template, path, seo);
    // The home page overwrites dist/index.html itself, which also doubles as
    // the SPA fallback for dynamic routes.
    const out = path === '/' ? join(dist, 'index.html') : join(dist, path.replace(/^\//, ''), 'index.html');
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, html);
    written++;
  }

  console.log(`prerender: ${written} routes written to dist/`);
}

main().catch((e) => {
  console.error('prerender failed:', e.message);
  process.exit(1);
});
