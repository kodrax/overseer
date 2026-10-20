import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { isWithin } from '../core/project.js';
import { runCommand } from './exec.js';
import type { InstallAction, InstallContext, TargetId } from './types.js';
import { BACKUP_SUFFIX, MANAGED_MARKER_TEXT } from './types.js';

type Label = TargetId | 'shared';

/** One planned change. Planning never touches the filesystem; `applyOps` performs (or, in dry runs, reports) it. */
export type Op =
  /** Already-decided outcome (unchanged / skipped / manual). */
  | { kind: 'note'; action: InstallAction }
  | { kind: 'write'; target: Label; path: string; content: string; existed: boolean; backup: boolean }
  /** `backup`: copy each existing file to `<file>.overseer-backup` before overwriting it (`install --force` over an unmanaged folder). */
  | { kind: 'skill'; target: Label; dir: string; files: { path: string; content: string }[]; existed: boolean; backup: boolean }
  | { kind: 'remove-file'; target: Label; path: string; backup: boolean }
  | { kind: 'remove-dir'; target: Label; path: string }
  | {
      kind: 'command';
      target: Label;
      /** Resolved executable path. */
      bin: string;
      /** Name shown in reports (`claude`). */
      program: string;
      /** Run in order; the last one is the reported command. */
      steps: { args: string[]; ignoreFailure: boolean }[];
      success: 'created' | 'updated' | 'removed';
      /** Status reported when a failing last step is tolerated (e.g. removing an absent server). */
      failureStatus?: 'unchanged';
    };

export function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function isManaged(text: string | undefined): boolean {
  return text !== undefined && text.includes(MANAGED_MARKER_TEXT);
}

/** Files under `dir`, sorted, as paths relative to `dir`. */
export function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(dir, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** Per-run mutable state shared by every target. */
export class Run {
  readonly actions: InstallAction[] = [];
  readonly warnings: string[] = [];
  /** Skill roots written/removed in this run (shared `.agents/skills` is handled once). */
  readonly skillRoots = new Set<string>();

  constructor(readonly ctx: InstallContext) {}

  warn(message: string): void {
    this.warnings.push(message);
  }

  /**
   * Copies an existing file to `<file>.overseer-backup` before overseer changes it. An existing backup is never
   * overwritten: it holds the file as it was before overseer first touched it.
   */
  private backup(path: string): void {
    const target = path + BACKUP_SUFFIX;
    if (!existsSync(path) || existsSync(target)) return;
    copyFileSync(path, target);
  }

  /**
   * Removes `dir` and its parents while they are empty, stopping at the scope base (home or project root),
   * so directories created by install (`.omp/`, `.claude/skills/`, …) do not outlive the files in them.
   */
  private pruneEmptyDirs(dir: string): void {
    const base = this.ctx.scope === 'user' ? this.ctx.home : this.ctx.projectRoot;
    if (base === undefined) return;
    for (let current = dir; relative(base, current) !== '' && isWithin(base, current); current = dirname(current)) {
      try {
        rmdirSync(current); // only succeeds on an empty directory
      } catch {
        return;
      }
    }
  }

  applyOps(ops: Op[]): void {
    const { dryRun } = this.ctx;
    for (const op of ops) {
      switch (op.kind) {
        case 'note':
          this.actions.push(op.action);
          break;
        case 'write': {
          const verb = op.existed ? 'updated' : 'created';
          if (dryRun) {
            this.actions.push({ target: op.target, kind: 'file', path: op.path, status: 'planned', message: op.existed ? 'update' : 'create' });
            break;
          }
          if (op.backup) this.backup(op.path);
          mkdirSync(dirname(op.path), { recursive: true });
          writeFileSync(op.path, op.content);
          this.actions.push({ target: op.target, kind: 'file', path: op.path, status: verb });
          break;
        }
        case 'skill': {
          if (dryRun) {
            this.actions.push({ target: op.target, kind: 'dir', path: op.dir, status: 'planned', message: op.existed ? 'update' : 'create' });
            break;
          }
          for (const file of op.files) {
            if (op.backup) this.backup(file.path);
            mkdirSync(dirname(file.path), { recursive: true });
            writeFileSync(file.path, file.content);
          }
          this.actions.push({ target: op.target, kind: 'dir', path: op.dir, status: op.existed ? 'updated' : 'created' });
          break;
        }
        case 'remove-file':
          if (dryRun) {
            this.actions.push({ target: op.target, kind: 'file', path: op.path, status: 'planned', message: 'remove' });
            break;
          }
          if (op.backup) this.backup(op.path);
          rmSync(op.path, { force: true });
          this.pruneEmptyDirs(dirname(op.path));
          this.actions.push({ target: op.target, kind: 'file', path: op.path, status: 'removed' });
          break;
        case 'remove-dir':
          if (dryRun) {
            this.actions.push({ target: op.target, kind: 'dir', path: op.path, status: 'planned', message: 'remove' });
            break;
          }
          rmSync(op.path, { recursive: true, force: true });
          this.pruneEmptyDirs(dirname(op.path));
          this.actions.push({ target: op.target, kind: 'dir', path: op.path, status: 'removed' });
          break;
        case 'command': {
          const command = (args: string[]) => [op.program, ...args];
          if (dryRun) {
            for (const step of op.steps) {
              this.actions.push({ target: op.target, kind: 'command', command: command(step.args), status: 'planned', message: 'run' });
            }
            break;
          }
          let failure: string | undefined;
          let tolerated = false;
          for (const [index, step] of op.steps.entries()) {
            const result = runCommand(this.ctx, op.bin, step.args);
            if (result.ok) continue;
            if (!step.ignoreFailure) {
              failure = result.stderr.trim() || result.stdout.trim() || 'command failed';
              break;
            }
            tolerated = index === op.steps.length - 1;
          }
          const reported = command(op.steps.at(-1)!.args);
          if (failure !== undefined) {
            this.actions.push({ target: op.target, kind: 'command', command: reported, status: 'failed', message: failure });
            this.warn(`${op.target}: command failed: ${reported.join(' ')}: ${failure}`);
          } else if (tolerated && op.failureStatus) {
            this.actions.push({ target: op.target, kind: 'command', command: reported, status: op.failureStatus, message: 'not registered' });
          } else {
            this.actions.push({ target: op.target, kind: 'command', command: reported, status: op.success });
          }
          break;
        }
      }
    }
  }
}
