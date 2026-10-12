import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { errorMessage, OverseerError } from './errors.js';
import { isGuardedRoot, isWithin } from './project.js';

type Env = Record<string, string | undefined>;

const CONFIG_FILE = 'config.json';

const folderList = z
  .array(z.string().refine(isAbsolute).transform((folder) => resolve(folder)))
  .default([]);

/** overseer is off by default. Each listed folder covers everything below it; the closest one to a project decides. */
const userConfigSchema = z.looseObject({
  /** Folders turned on with `overseer enable` (or `overseer init`). */
  enabled_projects: folderList,
  /** Folders turned off with `overseer disable`: exceptions inside an enabled folder. */
  disabled_projects: folderList,
});

type UserConfig = z.infer<typeof userConfigSchema>;

export interface ProjectState {
  root: string;
  enabled: boolean;
  /** Folder whose rule decides (`root` itself or an ancestor); absent when no rule covers `root` (off by default). */
  rule?: string;
}

/** Result of `overseer enable` / `overseer disable`. */
export interface ProjectSwitch {
  root: string;
  /** Whether overseer is on for `root` after the call. */
  enabled: boolean;
  /** False when `root` already was in that state. */
  changed: boolean;
  /** Ancestor folder whose rule decides the state of `root`. */
  through?: string;
  config_file: string;
}

/** Per-user settings file: OVERSEER_CONFIG_DIR, else the per-OS user config dir. */
export function userConfigFile(env: Env = process.env): string {
  if (env.OVERSEER_CONFIG_DIR) return join(env.OVERSEER_CONFIG_DIR, CONFIG_FILE);
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'overseer', CONFIG_FILE);
  if (process.platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'overseer', CONFIG_FILE);
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'overseer', CONFIG_FILE);
}

/** A broken file throws instead of reading as empty: silently ignoring it would change which projects are on. */
function readUserConfig(file: string): UserConfig {
  if (!existsSync(file)) return { enabled_projects: [], disabled_projects: [] };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new OverseerError('CONFIG_PARSE', `${file} is not valid JSON (${errorMessage(error)}); fix or delete it.`);
  }
  const parsed = userConfigSchema.safeParse(data);
  if (!parsed.success) {
    throw new OverseerError(
      'CONFIG_PARSE',
      `${file} must be a JSON object whose "enabled_projects" and "disabled_projects" are lists of absolute folder paths.`,
    );
  }
  return parsed.data;
}

function writeUserConfig(file: string, config: UserConfig): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

/** The closest covering rule decides; when one folder is in both lists, disabled wins. */
function stateIn(config: UserConfig, root: string): ProjectState {
  const rules = [
    ...config.enabled_projects.map((folder) => ({ folder, enabled: true })),
    ...config.disabled_projects.map((folder) => ({ folder, enabled: false })),
  ].filter((rule) => isWithin(rule.folder, root));
  // Covering folders are all ancestors of `root` (or `root` itself), so the longest path is the closest.
  rules.sort((a, b) => b.folder.length - a.folder.length || Number(a.enabled) - Number(b.enabled));
  const [closest] = rules;
  return closest ? { root, enabled: closest.enabled, rule: closest.folder } : { root, enabled: false };
}

export function projectState(root: string, env: Env = process.env): ProjectState {
  return stateIn(readUserConfig(userConfigFile(env)), root);
}

/**
 * Throws DISABLED unless the user turned overseer on for `root` (or an ancestor). Guarded roots (home, `/`) are left to
 * the home guard, so agents get NO_PROJECT and retry with `project_dir` instead of giving up.
 */
export function assertProjectEnabled(root: string, env: Env = process.env): void {
  if (isGuardedRoot(root)) return;
  const state = projectState(root, env);
  if (state.enabled) return;
  const where =
    state.rule === undefined
      ? `${root} (overseer is off by default and works only in projects the user turned on)`
      : state.rule === root
        ? root
        : `${state.rule} and everything below it`;
  throw new OverseerError(
    'DISABLED',
    `overseer is off for ${where}. Do not use overseer in this project; to turn it on, the user runs: overseer enable --project ${root}`,
  );
}

/**
 * `overseer enable` / `overseer disable`: drops the opposite rule of `root` itself, then adds a rule for `root` only when
 * an ancestor rule (or the off default) still decides otherwise. Nothing is written into the project.
 */
export function setProjectEnabled(root: string, enabled: boolean, env: Env = process.env): ProjectSwitch {
  const file = userConfigFile(env);
  const config = readUserConfig(file);
  const result = (state: ProjectState, changed: boolean): ProjectSwitch => ({
    root,
    enabled: state.enabled,
    changed,
    ...(state.rule !== undefined && state.rule !== root ? { through: state.rule } : {}),
    config_file: file,
  });
  const before = stateIn(config, root);
  if (before.enabled === enabled) return result(before, false);
  const next: UserConfig = {
    ...config,
    enabled_projects: enabled ? config.enabled_projects : config.enabled_projects.filter((folder) => folder !== root),
    disabled_projects: enabled ? config.disabled_projects.filter((folder) => folder !== root) : config.disabled_projects,
  };
  if (stateIn(next, root).enabled !== enabled) {
    if (enabled) next.enabled_projects = [...next.enabled_projects, root].sort();
    else next.disabled_projects = [...next.disabled_projects, root].sort();
  }
  writeUserConfig(file, next);
  return result(stateIn(next, root), true);
}
