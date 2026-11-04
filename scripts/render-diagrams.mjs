#!/usr/bin/env node
// Renders every docs/assets/<name>.mmd to <name>-terminal.png and <name>-paper.png next to it (2x, IBM Plex, colours
// from docs/assets/mermaid-{terminal,paper}.json), which the README swaps with <picture> and prefers-color-scheme:
// npm does not render Mermaid, so the README shows the PNG on both GitHub and npm.
//   node scripts/render-diagrams.mjs
// Uses @mermaid-js/mermaid-cli through npx (downloads it and its Chromium on first run) and Python fontTools with
// brotli (PYTHON, default python3) to unpack the IBM Plex woff2 files.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(root, 'docs', 'assets');
const fonts = join(root, 'design', 'system', 'fonts');
/** Theme → background (`bg` of design/system/tokens.json). */
const THEMES = { terminal: '#131311', paper: '#f5f3ee' };
const work = mkdtempSync(join(tmpdir(), 'overseer-diagrams-'));
try {
  // A font CSS loads too late for Mermaid's text measuring (labels get clipped), so Chromium gets IBM Plex Sans as
  // a system font: unpacked to TTF (Chromium skips woff2 system fonts) into a dir a temp fontconfig file adds.
  const fontDir = join(work, 'fonts');
  mkdirSync(fontDir);
  const unpack = spawnSync(
    process.env.PYTHON ?? 'python3',
    ['-c', 'import sys\nfrom fontTools.ttLib import TTFont\nfor src in sys.argv[2:]:\n f = TTFont(src); f.flavor = None; f.save(sys.argv[1] + "/" + src.rsplit("/", 1)[1].replace(".woff2", ".ttf"))',
      fontDir, ...[400, 500, 600].map((weight) => join(fonts, `IBMPlexSans-${weight}.woff2`))],
    { stdio: 'inherit' },
  );
  if (unpack.status !== 0) throw new Error('unpacking the IBM Plex fonts failed; install fontTools and brotli for PYTHON');
  const fontconfig = join(work, 'fonts.conf');
  writeFileSync(
    fontconfig,
    `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include><dir>${fontDir}</dir><cachedir>${join(work, 'cache')}</cachedir></fontconfig>`,
  );
  for (const name of readdirSync(assets).filter((file) => file.endsWith('.mmd'))) {
    for (const [theme, background] of Object.entries(THEMES)) {
      const output = join(assets, name.replace(/\.mmd$/, `-${theme}.png`));
      const result = spawnSync(
        'npx',
        ['-y', '@mermaid-js/mermaid-cli@11', '-i', join(assets, name), '-o', output, '-c', join(assets, `mermaid-${theme}.json`),
          '-b', background, '-s', '2'],
        { stdio: 'inherit', env: { ...process.env, FONTCONFIG_FILE: fontconfig } },
      );
      if (result.status !== 0) process.exit(result.status ?? 1);
      console.log(`render-diagrams: ${output}`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
