import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const templates = fileURLToPath(new URL('../templates/', import.meta.url));
const skillsDir = join(templates, 'skills');
const MARKER = '<!-- managed-by: overseer-cli -->';
const SKILLS = ['overseer', 'overseer-bootstrap', 'overseer-import', 'overseer-ship', 'overseer-sync'];

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

  it('overseer-sync runs the connect flow with existing sync commands only', () => {
    const text = readFileSync(join(skillsDir, 'overseer-sync', 'SKILL.md'), 'utf8');
    const order = [
      'overseer sync remotes --json',
      'overseer sync connection add --host github|gitlab --repo <repository> --json',
      'overseer sync inspect <bundle> --source github|gitlab --json',
      'overseer sync mapping import <id> <file> --json',
      'overseer sync status --json',
    ].map((command) => text.indexOf(command));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toMatch(/Connect only those the user confirms/);
    expect(text).toMatch(/"unknown"[^]*ask whether it is GitHub, GitLab or neither/);
    expect(text).toMatch(/unmapped and leave them\s+unmapped/);
    // No-MCP path: the import skill's guide, reached as a sibling folder in every install layout.
    expect(text).toContain('`../overseer-import/references/integrations.md`');
    expect(text).toMatch(/ask the user to authenticate, and stop/);
    expect(readFileSync(join(skillsDir, 'overseer-sync', '../overseer-import/references/integrations.md'), 'utf8').length).toBeGreaterThan(0);
    // Source of truth (TASK-0052) and MCP server choice (TASK-0030) are not part of this flow.
    expect(text).not.toMatch(/source[- ]of[- ]truth/i);
    expect(text).not.toContain('--mcp-server');
    expect(text).not.toMatch(/sync connection set/);
  });

  it('the overseer skill and the subagent prompt point to overseer-sync for connecting and syncing', () => {
    expect(readFileSync(join(skillsDir, 'overseer', 'SKILL.md'), 'utf8')).toMatch(/Connecting or syncing[^]*`overseer-sync` skill/);
    const prompt = readFileSync(join(templates, 'agent-prompt.md'), 'utf8');
    expect(prompt).toMatch(/connecting or syncing[^]*`overseer-sync` skill/);
    expect(prompt).not.toMatch(/importing or syncing/);
  });
});
