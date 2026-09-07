#!/usr/bin/env node
/*
 * ZoeWeb single-file build: bundles the app, inlines the CSS and embeds all
 * vehicle databases (gzip+base64) into one self-contained dist/zoeweb.html
 * that runs when opened directly (double-click, file://).
 *
 *   npm install esbuild && node build/build.mjs
 */
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 1. bundle the app
const bundle = await build({
  entryPoints: [join(root, 'js/main.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  write: false,
  target: 'chrome100',
});
const js = bundle.outputFiles[0].text;

// 2. collect + compress the vehicle databases
const assets = {};
for (const car of readdirSync(join(root, 'assets'))) {
  const dir = join(root, 'assets', car);
  if (!statSync(dir).isDirectory()) continue;
  for (const file of readdirSync(dir)) {
    assets[`${car}/${file}`] = readFileSync(join(dir, file), 'utf8');
  }
}
const assetB64 = gzipSync(JSON.stringify(assets), { level: 9 }).toString('base64');

// 3. assemble the HTML from index.html
const css = readFileSync(join(root, 'css/app.css'), 'utf8');
let version = 'dev';
try { version = execSync('git describe --tags --always', { cwd: root }).toString().trim(); } catch (_) {}

let html = readFileSync(join(root, 'index.html'), 'utf8');
html = html.replace('<link rel="stylesheet" href="css/app.css">',
  `<!-- ZoeWeb single-file build ${version} (${new Date().toISOString().slice(0, 10)}) -->\n  <style>\n${css}\n  </style>`);
html = html.replace('<script type="module" src="js/main.js"></script>',
  `<script>window.__ZOEWEB_ASSETS__=${JSON.stringify(assetB64)};</script>\n` +
  `  <script>\n${js}\n  </script>`);

if (html.includes('js/main.js') || html.includes('css/app.css')) {
  throw new Error('template substitution failed — index.html changed?');
}

mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist', 'zoeweb.html');
writeFileSync(out, html);
console.log(`dist/zoeweb.html: ${(html.length / 1024 / 1024).toFixed(2)} MB ` +
  `(app ${(js.length / 1024).toFixed(0)} kB, databases ${(assetB64.length / 1024 / 1024).toFixed(2)} MB compressed, version ${version})`);
