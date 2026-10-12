export type TargetId = 'claude' | 'omp' | 'codex' | 'gemini' | 'copilot' | 'cursor' | 'opencode';
export type Scope = 'user' | 'project';

export interface InstallContext {
  scope: Scope;
  home: string;
  env: Record<string, string | undefined>;
  /** Required for project scope. */
  projectRoot?: string;
  nodePath: string;
  cliPath: string;
  templatesDir: string;
  dryRun: boolean;
  force: boolean;
}

export type ActionStatus = 'created' | 'updated' | 'unchanged' | 'skipped' | 'removed' | 'manual' | 'planned' | 'failed';

export interface InstallAction {
  target: TargetId | 'shared';
  kind: 'file' | 'dir' | 'command';
  path?: string;
  command?: string[];
  status: ActionStatus;
  message?: string;
}

export interface InstallReport {
  scope: Scope;
  targets: TargetId[];
  actions: InstallAction[];
  warnings: string[];
}

export interface CheckLine {
  status: 'OK' | 'WARN' | 'FAIL';
  label: string;
  detail: string;
}

export const TARGET_IDS: readonly TargetId[] = ['claude', 'omp', 'codex', 'gemini', 'copilot', 'cursor', 'opencode'];

/** Marker text present in every file the installer owns (Markdown comment or TOML comment). */
export const MANAGED_MARKER_TEXT = 'managed-by: overseer-cli';
export const MD_MARKER = `<!-- ${MANAGED_MARKER_TEXT} -->`;
export const TOML_MARKER = `# ${MANAGED_MARKER_TEXT}`;

export const SKILL_NAMES = ['overseer', 'overseer-bootstrap', 'overseer-import'] as const;
export const SERVER_NAME = 'overseer';
export const BACKUP_SUFFIX = '.overseer-backup';
