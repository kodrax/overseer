import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { bundleKeys } from '../src/core/tracking.js';
import { install } from '../src/install/index.js';
import { sandbox } from './fixtures/install/harness.js';

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
      'overseer sync connection add --host github|gitlab --repo <repository> --mcp-server <server> --json',
      'overseer sync inspect <bundle> --source github|gitlab --json',
      'overseer sync mapping import <id> <file> --json',
      'overseer sync start <id> <file> --json',
      '## 5. Source of truth',
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
    // Source of truth (TASK-0066): derived from sync start, never asked for or set.
    const source = text.slice(text.indexOf('## 5. Source of truth'), text.indexOf('## 6. Finish'));
    expect(source).toMatch(/the board until sync starts on a connection while the board is the source of truth, then\s+that connection until it is removed/);
    expect(text).not.toMatch(/source-of-truth set|Choose the source of truth|Ask the user to choose/);
  });

  it('overseer-sync starts sync after connect and mapping from the full listing and says which case applied (TASK-0067 AC1)', () => {
    const text = readFileSync(join(skillsDir, 'overseer-sync', 'SKILL.md'), 'utf8');
    const start = text.slice(text.indexOf('## 4. Start sync'), text.indexOf('## 5. Source of truth'));
    const order = [
      text.indexOf('overseer sync connection add'),
      text.indexOf('overseer sync mapping import <id> <file> --json'),
      text.indexOf('## 4. Start sync'),
      text.indexOf('`list_issues` (`state: all`)', text.indexOf('## 4. Start sync')),
      text.indexOf('overseer sync start <id> <file> --json'),
    ];
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(start).toMatch(/after its mapping \(so the seeded issues get its labels\)/);
    expect(start).toMatch(/through the connection's\s+`mcp_server`/);
    expect(start).toMatch(/GitLab `list_work_items` \(all states\)/);
    expect(start).toMatch(/until the last page and join the pages' issues/);
    expect(start).toMatch(/Tell the user which case applied, from `from`/);
    expect(start).toMatch(/`board` — the repository had no issues, so the board seeds it: `queued` creates, by kind/);
    expect(start).toMatch(/`repository` — the repository's issues came to the board: `created` new items and `linked`/);
    expect(start).toMatch(/before the start are never pushed/);
    expect(start).toMatch(/`CONFLICT` means sync already started on this connection: go straight to \[Sync\]\(#sync\)/);
  });

  const mappingSection = () => {
    const text = readFileSync(join(skillsDir, 'overseer-sync', 'SKILL.md'), 'utf8');
    return text.slice(text.indexOf('## 3. Connect and map'), text.indexOf('## 4. Start sync')).replace(/\s+/g, ' ');
  };

  it('overseer-sync proposes a label with name and colour for each unmapped kind, status and priority, labels only (TASK-0028 AC1)', () => {
    const map = mappingSection();
    expect(map).toMatch(/5\. Propose a label for each kind, status and priority value still unmapped/);
    expect(map).toMatch(/a name in the repository's existing label style/);
    expect(map).toContain('else `kind: <kind>`, `status: <status>` and `priority: <priority>` (`kind: task`, `status: in progress`, `priority: must`');
    expect(map).toMatch(/a colour as 6 hex digits/);
    expect(map).toMatch(/Labels only: never propose or create an issue type\./);
    expect(map).toMatch(/Show the full proposal/);
  });

  it('overseer-sync and the README map kinds to labels only; issue types are information, never targets (BUG-0016 AC1)', () => {
    const skill = readFileSync(join(skillsDir, 'overseer-sync', 'SKILL.md'), 'utf8');
    const map = mappingSection();
    expect(skill).not.toMatch(/issue types? \(else labels\)/i);
    expect(skill.split('\n').find((l) => l.startsWith('description:'))).not.toMatch(/issue type/);
    expect(map).toMatch(/map kinds to existing labels only/);
    expect(map).toMatch(/`issue_types` are information only, never mapping targets/);
    expect(map).not.toMatch(/"(Feature|Task|Bug)"/);
    const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
    const section = readme.slice(readme.indexOf('### Kind, status and priority mapping'));
    const intro = section.slice(0, section.indexOf('| Dimension'));
    expect(intro).not.toMatch(/issue types or states/);
    expect(intro).toMatch(/issue types listed by `sync inspect` are information only, never mapping targets/);
    expect(readme).not.toMatch(/map one local value to a label, issue type or state/);
    expect(readme).not.toMatch(/--local task --remote Task/);
  });

  it('overseer-sync proposes a new kind label in step 5 for an issue type without a matching label (BUG-0016 AC2)', () => {
    const map = mappingSection();
    expect(map).toMatch(/a kind whose issue type has no matching label stays out here and gets a new kind label in step 5/);
    expect(map.indexOf('stays out here')).toBeLessThan(map.indexOf('5. Propose a label for each kind'));
  });

  it('overseer-sync creates only confirmed labels through MCP, then imports the mapping (TASK-0028 AC2)', () => {
    const map = mappingSection();
    expect(map).toMatch(/ask the user to confirm all of it, a subset, or none/);
    expect(map).toMatch(/Create only the new labels the user confirmed: nothing is created without that confirmation\./);
    expect(map).toContain("Use the connection's server: GitHub `label_write` with `method: create` (`owner`, `repo`, `name`, `color` without `#`); GitLab `create_label` (`project_id`, `name`, `color` with a leading `#`)");
    expect(map).toMatch(/7\. Only then save the mapping: the confirmed pairs of step 4 plus each label created or already there/);
    const order = [
      'overseer sync inspect <bundle>',
      '4. Propose a mapping',
      '5. Propose a label',
      'ask the user to confirm',
      '`label_write`',
      'overseer sync mapping import <id> <file> --json',
      'overseer sync mapping <id> --json',
    ].map((needle) => map.indexOf(needle));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The tools the skill names are documented, with their permissions.
    const guide = readFileSync(join(skillsDir, 'overseer-import', 'references', 'integrations.md'), 'utf8');
    expect(guide).toContain('`X-MCP-Tools: get_label,list_label,label_write,projects_get,projects_list`');
    expect(guide).toMatch(/`create_label`[^]*GITLAB_PERMISSION_MODE=modify/);
    expect(guide.match(/^### Creating labels$/gm)).toHaveLength(2);
  });

  it('overseer-sync says when the server cannot create labels and leaves those values unmapped (TASK-0028 AC3)', () => {
    const map = mappingSection();
    expect(map).toMatch(/When the server has no such tool \(GitLab's built-in server has none;[^)]*\), say it cannot create labels, create none and leave those values unmapped\./);
    expect(map).toMatch(/A failed call \(permission denied, …\): report its error and leave that value unmapped/);
    expect(map).toMatch(/list the local values still `null` as unmapped and leave them unmapped/);
    const guide = readFileSync(join(skillsDir, 'overseer-import', 'references', 'integrations.md'), 'utf8');
    expect(guide.slice(guide.indexOf('## GitLab: built-in server'))).toMatch(/No label-creation tool: the server's only label tool is `search_labels`/);
  });

  it('overseer-sync maps, new labels included, before it starts sync (TASK-0028)', () => {
    const text = readFileSync(join(skillsDir, 'overseer-sync', 'SKILL.md'), 'utf8');
    const order = [
      text.indexOf('`label_write` with `method: create`'),
      text.indexOf('overseer sync mapping import <id> <file> --json'),
      text.indexOf('## 4. Start sync'),
      text.indexOf('overseer sync start <id> <file> --json'),
    ];
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('overseer-sync explains the source-of-truth rule instead of asking for it (TASK-0067 AC2)', () => {
    const text = readFileSync(join(skillsDir, 'overseer-sync', 'SKILL.md'), 'utf8');
    const source = text.slice(text.indexOf('## 5. Source of truth'), text.indexOf('## 6. Finish'));
    expect(source).toMatch(/Nobody\s+chooses it: it is the board until sync starts/);
    expect(source).toMatch(/never ask them to choose/);
    expect(text).not.toMatch(/which (tracker|one) is the source of truth\?|source-of-truth set|Ask the user (to choose|which)/i);
  });

  it('overseer-sync runs the normal sync steps after seeding an empty repository (TASK-0067 AC3)', () => {
    const text = readFileSync(join(skillsDir, 'overseer-sync', 'SKILL.md'), 'utf8');
    const start = text.slice(text.indexOf('## 4. Start sync'), text.indexOf('## 5. Source of truth'));
    expect(start).toMatch(/Continue straight into \[Sync\]\(#sync\) steps 3–7 with the same listing \(plan → pushes\s+through the MCP server → confirm → outbox ack → status\), so the queued creates become issues/);
    expect(start).toMatch(/closed item's new issue is closed/);
    const sync = text.slice(text.indexOf('\n## Sync'));
    const steps = ['overseer sync plan <connection> <listing> --json', 'overseer sync confirm <connection> <results> --json', 'overseer sync status --json'].map((s) => sync.indexOf(s));
    expect(steps.every((at) => at >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  });

  it('overseer-sync asks for the MCP server and stores it on the connection (TASK-0030 AC1)', () => {
    const text = readFileSync(join(skillsDir, 'overseer-sync', 'SKILL.md'), 'utf8');
    const choose = text.slice(text.indexOf('## 2. Choose the MCP server'), text.indexOf('## 3. '));
    expect(choose).toMatch(/Ask which MCP server reaches the repository\. Offer the server\(s\) found/);
    expect(choose).toMatch(/offer the host default \(`github` or `gitlab`\)/);
    const connect = text.slice(text.indexOf('## 3. '), text.indexOf('## 4. '));
    const add = connect.indexOf('overseer sync connection add --host github|gitlab --repo <repository> --mcp-server <server> --json');
    const set = connect.indexOf('`CONFLICT` means it is already\n   connected: use the id it names and store the server with\n   `overseer sync connection set <id> --mcp-server <server> --json`');
    expect(add).toBeGreaterThanOrEqual(0);
    expect(set).toBeGreaterThan(add);
    // A repository connected earlier without a server gets one with set.
    const find = text.slice(text.indexOf('## 1. '), text.indexOf('## 2. '));
    expect(find).toMatch(/`mcp_server` is\s+`null`[^]*`overseer sync connection set <id> --mcp-server <server> --json`/);
  });

  it('overseer-sync calls the stored MCP server with the harness prefix, the default only without one (TASK-0030 AC2)', () => {
    const text = readFileSync(join(skillsDir, 'overseer-sync', 'SKILL.md'), 'utf8');
    const server = text.slice(text.indexOf('## MCP server'), text.indexOf('## 1. '));
    expect(server).toContain('`mcp_server` in\n`overseer sync connections --json`');
    expect(server).toMatch(/only when `mcp_server` is `null` use the host's\s+default server, `github` or `gitlab`/);
    expect(server).toMatch(/never the default server's\s+prefix when another server is stored/);
    for (const prefix of ['`mcp__<server>__<tool>`', '`mcp__<server>_<tool>`', '`mcp_<server>_<tool>`', '`<server>-<tool>`', '`<server>_<tool>`']) {
      expect(server).toContain(prefix);
    }
    // Bundle keys stay plain tool names; listing and pushes go through the stored server.
    expect(text).toMatch(/keyed by the plain MCP\s+tool name \(no harness prefix\)/);
    const sync = text.slice(text.indexOf('\n## Sync\n'));
    expect(sync).toMatch(/1\. Fetch the listing[^]*through the connection's\s+`mcp_server`/);
    expect(sync).toMatch(/4\. Run each `push` op with the tools of the connection's `mcp_server`/);
    // The MCP server section precedes every step that calls GitHub or GitLab.
    expect(text.indexOf('## MCP server')).toBeLessThan(text.indexOf('## 1. '));
  });

  it('overseer-sync pushes the plan through the host MCP tools, confirms the results and acknowledges ack (TASK-0022)', () => {
    const text = readFileSync(join(skillsDir, 'overseer-sync', 'SKILL.md'), 'utf8');
    const sync = text.slice(text.indexOf('## Sync'));
    const order = [
      'overseer sync plan <connection> <listing> --json',
      '`issue_write`',
      '`create_issue`',
      'overseer sync confirm <connection> <results> --json',
      'overseer sync outbox ack <seq...> --json',
    ].map((step) => sync.indexOf(step));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(sync).toMatch(/Labels only: never set an issue type/);
    expect(sync).toMatch(/A failed call adds no result: list it in\s+your reply[^]*stays pending/);
    expect(sync).toMatch(/`update_issue`[^]*`state_event: close`/);
  });

  it('overseer-sync syncs the source-of-truth connection first, pull then push, then the others (TASK-0053 AC4)', () => {
    const text = readFileSync(join(skillsDir, 'overseer-sync', 'SKILL.md'), 'utf8');
    const sync = text.slice(text.indexOf('\n## Sync\n'));
    expect(sync.indexOf('\n## Sync\n')).toBe(0);
    const several = sync.slice(sync.indexOf('\n### Several connections\n'));
    expect(several).not.toMatch(/\n## /);
    expect(several).toMatch(/one connection at a time, each completely \(pull, then push\)/);
    const first = several.indexOf('`overseer sync source-of-truth --json`');
    const others = several.indexOf('Then each other connection');
    expect(first).toBeGreaterThan(0);
    expect(others).toBeGreaterThan(first);
    expect(several).toMatch(/`overwritten` list/);
  });

  it('overseer-sync and the README say each repository keeps its existing issues and only new board items fan out (BUG-0019 AC3)', () => {
    const text = readFileSync(join(skillsDir, 'overseer-sync', 'SKILL.md'), 'utf8');
    const several = text.slice(text.indexOf('\n### Several connections\n'));
    expect(several).toMatch(/Each repository's existing issues stay in that repository/);
    expect(several).toMatch(/never created on another\s+connection, even when it changes later; its entries there come under `ack`/);
    expect(several).toMatch(/Only new board items fan\s+out: an item created on the board after the starts is pushed to every started connection\./);
    expect(text).toMatch(/its\s+issues are never created in the other connected repositories/);
    const readme = readFileSync(join(import.meta.dirname, '../README.md'), 'utf8');
    const section = readme.slice(readme.indexOf('\n#### Several connections\n'), readme.indexOf('\n### Sync plan\n'));
    expect(section).toMatch(/^\n#### Several connections\n\nEach repository's existing issues stay in that repository; only new board items fan out\./);
    expect(section).toMatch(/Another connection never gets a `create` for it, even when it changes later/);
    expect(section).toMatch(/created on the board after the starts is queued for and pushed to every connection/);
  });

  it('overseer-sync passes the plan op overwritten to sync confirm and reports the overwritten fields of sync status (TASK-0024)', () => {
    const text = readFileSync(join(skillsDir, 'overseer-sync', 'SKILL.md'), 'utf8');
    const sync = text.slice(text.indexOf('\n## Sync\n'));
    const confirm = sync.indexOf('overseer sync confirm <connection> <results> --json');
    expect(sync.indexOf('`"overwritten": <op overwritten>`')).toBeGreaterThan(0);
    expect(sync.indexOf('`"overwritten": <op overwritten>`')).toBeLessThan(confirm);
    expect(sync).toMatch(/records in the item's history each issue value the\s+push overwrote/);
    expect(sync).toMatch(/`overseer sync status --json` and report each connection's `overwritten`/);
  });

  it('the overseer skill and the subagent prompt point to overseer-sync for connecting and syncing', () => {
    expect(readFileSync(join(skillsDir, 'overseer', 'SKILL.md'), 'utf8')).toMatch(/Connecting or syncing[^]*`overseer-sync` skill/);
    const prompt = readFileSync(join(templates, 'agent-prompt.md'), 'utf8');
    expect(prompt).toMatch(/connecting or syncing[^]*`overseer-sync` skill/);
    expect(prompt).not.toMatch(/importing or syncing/);
  });

  it('overseer SKILL.md names every reference file, each exists and install copies it', () => {
    const text = readFileSync(join(skillsDir, 'overseer', 'SKILL.md'), 'utf8');
    const named = [...new Set([...text.matchAll(/`references\/([a-z0-9-]+\.md)`/g)].map((match) => match[1]))].sort();
    expect(named).toEqual(readdirSync(join(skillsDir, 'overseer', 'references')).sort());
    const box = sandbox({ shims: ['claude'] });
    install(box.ctx('user', { templatesDir: templates }), ['claude']);
    for (const name of named) {
      const installed = join(box.home, '.claude/skills/overseer/references', name);
      expect(existsSync(installed), installed).toBe(true);
      expect(readFileSync(installed, 'utf8')).toBe(readFileSync(join(skillsDir, 'overseer', 'references', name), 'utf8'));
    }
  });

  it('the overseer and ship skills run one Sync per request for sync_pending connections, or say the changes stay in the outbox (TASK-0023)', () => {
    const flat = (text: string) => text.replace(/\s+/g, ' ');
    const overseer = flat(readFileSync(join(skillsDir, 'overseer', 'SKILL.md'), 'utf8'));
    const ship = flat(readFileSync(join(skillsDir, 'overseer-ship', 'SKILL.md'), 'utf8'));
    for (const text of [overseer, ship]) {
      expect(text).toContain('`sync_pending: [{connection_id, host, repository}]`');
      expect(text).toMatch(/after the last write of the user's request,? \(?not after each item\)?, run the `overseer-sync` skill's \*\*Sync\*\* step once for each connection/i);
      expect(text).toMatch(/If the user said not to sync, or the session lacks the host's MCP tools, do not sync: say the changes stay in the outbox, pending, and `overseer sync status` shows them\./);
    }
    // overseer's rule names every write that reports it; ship syncs a new item before its branch, and never creates issues itself.
    expect(overseer).toMatch(/\(create, update, delete, link, import\)/);
    const resolve = ship.slice(ship.indexOf('## 1. Resolve the item'), ship.indexOf('## 2. '));
    expect(resolve).toMatch(/\*\*Connected repositories\*\*: when the `create_item` result has `sync_pending`, run that Sync before step 3/);
    expect(resolve).toMatch(/No `sync_pending` \(no connection, auto-sync off, sync not started\) → skip; never create issues on your own\./);
    expect(resolve).not.toMatch(/push the new item to its repository/);
    // The result shape is documented, the sync skill points back to the rule, and the subagent reports the outcome.
    expect(flat(readFileSync(join(skillsDir, 'overseer', 'references', 'tools.md'), 'utf8'))).toMatch(/`sync_pending: \[\{connection_id, host, repository\}\]` \(by `connection_id`\)[^]*one list for the whole write/);
    const sync = flat(readFileSync(join(skillsDir, 'overseer-sync', 'SKILL.md'), 'utf8'));
    const syncStart = sync.indexOf(' ## Sync ');
    expect(sync.slice(syncStart, sync.indexOf(' 1. Fetch the listing', syncStart))).toMatch(/right after writes whose results carry `sync_pending`, for those connections \(the `overseer` skill's rule 11\)/);
    expect(overseer).toMatch(/ 11\. A write result with `sync_pending/);
    expect(flat(readFileSync(join(templates, 'agent-prompt.md'), 'utf8'))).toMatch(/When results carried `sync_pending`: the connections synced after the writes \(skill rule 11\), or left pending in the outbox and why\./);
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

describe('DISABLED rule', () => {
  const EXCEPTION =
    'run `overseer enable` only when the user asked for it explicitly (also when the parent agent passes that request on in the task), then continue';
  const texts: Record<string, string> = {
    'agent-prompt.md': readFileSync(join(templates, 'agent-prompt.md'), 'utf8'),
    'overseer/SKILL.md': readFileSync(join(skillsDir, 'overseer', 'SKILL.md'), 'utf8'),
    'overseer-bootstrap/SKILL.md': readFileSync(join(skillsDir, 'overseer-bootstrap', 'SKILL.md'), 'utf8'),
  };

  /** The paragraph (list item or blank-line block) that first mentions `DISABLED`, whitespace-normalised. */
  function disabledRule(text: string): string {
    const blocks = text.split(/\n(?=\s*\n|- )/);
    const block = blocks.find((b) => b.includes('`DISABLED`'));
    expect(block).toBeDefined();
    return (block ?? '').replace(/\s+/g, ' ').trim();
  }

  for (const [name, text] of Object.entries(texts)) {
    it(`${name} gives the shared DISABLED rule`, () => {
      const rule = disabledRule(text);
      expect(rule).toContain('stop using overseer');
      expect(rule).toContain('answer in one line');
      expect(rule).toContain(EXCEPTION);
      expect(rule).not.toMatch(/\bnever\b|turn it on yourself|ask the user to run/i);
    });
  }
});
