#!/usr/bin/env node
// Renders every docs/assets/*.mmd to a PNG next to it (2x, Terminal theme, IBM Plex embedded), for the README:
// npm does not render Mermaid, so the README shows the PNG on both GitHub and npm.
//   node scripts/render-diagrams.mjs
// Uses @mermaid-js/mermaid-cli through npx (downloads it and its Chromium on first run).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(root, 'docs', 'assets');
const fonts = join(root, 'design', 'system', 'fonts');
const work = mkdtempSync(join(tmpdir(), 'overseer-diagrams-'));
try {
  // A font CSS loads too late for Mermaid's text measuring (labels get clipped), so Chromium gets IBM Plex as a
  // system font through a fontconfig file that adds design/system/fonts to the usual font dirs.
  const fontconfig = join(work, 'fonts.conf');
  writeFileSync(
    fontconfig,
    `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include><dir>${fonts}</dir><cachedir>${join(work, 'cache')}</cachedir></fontconfig>`,
  );
  for (const name of readdirSync(assets).filter((file) => file.endsWith('.mmd'))) {
    const output = join(assets, name.replace(/\.mmd$/, '.png'));
    const result = spawnSync(
      'npx',
      ['-y', '@mermaid-js/mermaid-cli@11', '-i', join(assets, name), '-o', output, '-c', join(assets, 'mermaid-config.json'),
        '-b', '#131311', '-s', '2'],
      { stdio: 'inherit', env: { ...process.env, FONTCONFIG_FILE: fontconfig } },
    );
    if (result.status !== 0) process.exit(result.status ?? 1);
    console.log(`render-diagrams: ${output}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
