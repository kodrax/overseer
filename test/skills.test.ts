import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { bundleKeys } from '../src/core/tracking.js';

const templates = fileURLToPath(new URL('../templates/', import.meta.url));
const skillsDir = join(templates, 'skills');
const MARKER = '<!-- managed-by: overseer-cli -->';
const SKILLS = ['overseer', 'overseer-bootstrap', 'overseer-import', 'overseer-ship'];

function endsWithMarker(text: string): boolean {
  return text.endsWith(MARKER) || text.endsWith(`${MARKER}\n`);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('skill templates', () => {
  for (const skill of SKILLS) {
    it(`${skill}/SKILL.md has valid frontmatter and marker`, () => {
      const text = readFileSync(join(skillsDir, skill, 'SKILL.md'), 'utf8');
      expect(text.startsWith('---\n')).toBe(true);
      const end = text.indexOf('\n---\n', 4);
      expect(end).toBeGreaterThan(0);
      const fm = parse(text.slice(4, end)) as Record<string, unknown>;
      expect(Object.keys(fm).sort()).toEqual(['description', 'name']);
      expect(fm.name).toBe(skill);
      expect(fm.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(typeof fm.description).toBe('string');
      expect((fm.description as string).length).toBeGreaterThan(0);
      expect((fm.description as string).length).toBeLessThanOrEqual(1024);
      expect(endsWithMarker(text)).toBe(true);
    });
  }

  it('every markdown file under templates/skills ends with the marker', () => {
    const files = walk(skillsDir).filter((f) => f.endsWith('.md'));
    expect(files.length).toBeGreaterThan(SKILLS.length);
    for (const f of files) expect(endsWithMarker(readFileSync(f, 'utf8')), f).toBe(true);
  });

  it('agent-prompt.md has both placeholders and no triple single quotes', () => {
    const text = readFileSync(join(templates, 'agent-prompt.md'), 'utf8');
    expect(text).toContain('{{SKILL_PATH}}');
    expect(text).toContain('{{TOOL_PREFIX}}');
    expect(text).not.toContain("'''");
    expect(text).not.toContain(MARKER);
    expect(text.startsWith('---')).toBe(false);
  });

  it('overseer-ship step 1 passes an issue reference to get_item and imports only on NOT_FOUND with details', () => {
    const text = readFileSync(join(skillsDir, 'overseer-ship', 'SKILL.md'), 'utf8');
    const step = text.slice(text.indexOf('## 1. Resolve the item'), text.indexOf('## 2. '));
    const reference = step.slice(step.indexOf('- **Issue reference**'), step.indexOf('- **Free text**'));
    expect(reference).toMatch(/pass it unchanged to `get_item`/);
    const imports = reference.split('\n  - ').filter((branch) => branch.includes('import_items'));
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatch(/^`NOT_FOUND` with `details \{source, repo, external_id, url\}`/);
    expect(reference).toMatch(/`NOT_FOUND` without details → the repository is not connected; import nothing/);
  });
});

describe('integrations.md and overseer sync inspect', () => {
  const guide = readFileSync(join(skillsDir, 'overseer-import', 'references', 'integrations.md'), 'utf8');
  const heading = '### Tools `overseer sync inspect` reads';
  // Each host's section, the setting that enables toolsets and, for GitHub, the header that adds single tools.
  const hosts = [
    {
      source: 'github',
      start: '## GitHub (official remote server)',
      end: '## GitLab: zereight/gitlab-mcp',
      toolsets: /X-MCP-Toolsets(?::\s*|"\s*[:=]\s*")([a-z_,]+)/g,
      tools: /X-MCP-Tools(?::\s*|"\s*[:=]\s*")([a-z_,]+)/g,
    },
    {
      source: 'gitlab',
      start: '## GitLab: zereight/gitlab-mcp',
      end: '## GitLab: built-in server',
      toolsets: /(?:GITLAB_TOOLSETS(?:=|": ")|--toolsets=)([a-z_,]+)/g,
      tools: null,
    },
  ] as const;

  for (const { source, start, end, toolsets, tools } of hosts) {
    it(`names every ${source} tool sync inspect reads, enabled by the setup or listed as unknown`, () => {
      const section = guide.slice(guide.indexOf(start), guide.indexOf(end));
      expect(section.indexOf(heading), `${source} section has "${heading}"`).toBeGreaterThan(0);
      const setup = section.slice(0, section.indexOf(heading));
      const table = section.slice(section.indexOf(heading));
      const rows = new Map(
        [...table.matchAll(/^\| `(\w+)` \| ([^|]+) \| ([^|]+) \|$/gm)].map(([, tool, answers, enabledBy]) => [tool, { answers: answers.trim(), enabledBy: enabledBy.trim() }]),
      );
      const toolsetValues = [...setup.matchAll(toolsets)].map((match) => match[1].split(','));
      const toolValues = tools ? [...setup.matchAll(tools)].map((match) => match[1].split(',')) : [];
      const readers = [...bundleKeys(source).matchAll(/(\w+) \(([^)]*)\)/g)].map(([, tool, parts]) => ({ tool, parts }));
      expect(readers.length).toBeGreaterThan(0);
      expect([...rows.keys()].sort()).toEqual(readers.map((reader) => reader.tool).sort());
      for (const { tool, parts } of readers) {
        const { answers, enabledBy } = rows.get(tool)!;
        expect(answers, tool).toBe(parts);
        // A tool the setup cannot enable must say its part stays unknown, and why.
        if (/stay unknown/.test(enabledBy)) continue;
        const toolset = /toolset `(\w+)`/.exec(enabledBy)?.[1];
        if (toolset) {
          // Every harness snippet plus the description line.
          expect(toolsetValues.length, `${tool}: setups enabling toolsets`).toBeGreaterThanOrEqual(7);
          for (const value of toolsetValues) expect(value, `${tool} needs toolset ${toolset}`).toContain(toolset);
        } else {
          expect(enabledBy, tool).toBe('header `X-MCP-Tools`');
          expect(toolValues.length, `${tool}: setups adding tools`).toBeGreaterThanOrEqual(7);
          for (const value of toolValues) expect(value, `${tool} needs X-MCP-Tools`).toContain(tool);
        }
      }
    });
  }
});
