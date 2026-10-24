import { git } from './project.js';

/** Hosting service a remote points to; `unknown` hosts (GitHub Enterprise, other servers) are for the user to name. */
export type RemoteHost = 'github' | 'gitlab' | 'unknown';

/** A remote URL split into its host and repository path. */
export interface ParsedRemoteUrl {
  /** Lowercase hostname without user or port. */
  hostname: string;
  /** Repository path without `.git` or slashes around it: `acme/demo`, `group/sub/project`. */
  repository: string;
}

/** One `git remote -v` entry; http(s) URLs lose their user and password so tokens are never printed. */
export interface RemoteRef {
  name: string;
  url: string;
}

/** A repository the project's remotes point to, with every remote entry that points to it. */
export interface RemoteRepository extends ParsedRemoteUrl {
  host: RemoteHost;
  remotes: RemoteRef[];
}

const SCHEME_URL = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:?#]+)(?::\d*)?(\/[^?#]*)?/i;
// scp-like `[user@]host:path`: git treats it so when a colon comes before the first slash.
const SCP_URL = /^(?:[^@/]+@)?(\[[^\]]+\]|[^/:]+):(?!\/\/)(.*)$/;
const REMOTE_LINE = /^(\S+)\t(.+) \((?:fetch|push)\)$/;

/** Repository path without `.git` or slashes around it: `/acme/demo.git/` → `acme/demo`. */
export function normalizeRepositoryPath(path: string): string {
  return path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
}

/** Host and repository of a remote URL (ssh, git, http(s) or scp-like); undefined for local paths and URLs without a repository. */
export function parseRemoteUrl(url: string): ParsedRemoteUrl | undefined {
  const value = url.trim();
  let host: string;
  let path: string;
  const scheme = SCHEME_URL.exec(value);
  if (scheme) {
    if (scheme[1]!.toLowerCase() === 'file') return undefined;
    host = scheme[2]!;
    path = scheme[3] ?? '';
  } else {
    const scp = SCP_URL.exec(value);
    // A single letter before the colon is a Windows drive (C:\repo), not a host.
    if (!scp || /^[a-z]$/i.test(scp[1]!)) return undefined;
    host = scp[1]!;
    path = scp[2]!;
  }
  const hostname = host.replace(/^\[|\]$/g, '').toLowerCase();
  const repository = normalizeRepositoryPath(path);
  return hostname && repository ? { hostname, repository } : undefined;
}

/** github.com → github; gitlab.com or any hostname containing "gitlab" → gitlab; anything else → unknown. */
export function classifyHost(hostname: string): RemoteHost {
  const name = hostname.toLowerCase();
  if (name === 'github.com' || name === 'www.github.com' || name === 'ssh.github.com') return 'github';
  if (name.includes('gitlab')) return 'gitlab';
  return 'unknown';
}

/**
 * Repositories named by `git remote -v` output, in order of first appearance. Fetch and push URLs both count; remotes
 * pointing to the same host and path (case-insensitive) share one entry. Local paths and unparsable URLs are skipped.
 */
export function parseRemotes(output: string): RemoteRepository[] {
  const repositories = new Map<string, RemoteRepository>();
  for (const line of output.split('\n')) {
    const match = REMOTE_LINE.exec(line.trimEnd());
    if (!match) continue;
    const parsed = parseRemoteUrl(match[2]!);
    if (!parsed) continue;
    const key = `${parsed.hostname}/${parsed.repository.toLowerCase()}`;
    let entry = repositories.get(key);
    if (!entry) {
      entry = { host: classifyHost(parsed.hostname), ...parsed, remotes: [] };
      repositories.set(key, entry);
    }
    // http(s) credentials (`https://user:token@host/…`) are dropped so tokens are never printed.
    const ref = { name: match[1]!, url: match[2]!.replace(/^(https?:\/\/)[^@/]*@/i, '$1') };
    if (!entry.remotes.some((known) => known.name === ref.name && known.url === ref.url)) entry.remotes.push(ref);
  }
  return [...repositories.values()];
}

/** Repositories of every git remote of `dir`; empty when `dir` is outside git or has no remotes. Reads local git config only. */
export function detectRemotes(dir: string): RemoteRepository[] {
  return parseRemotes(git(dir, ['remote', '-v']) ?? '');
}

/** Remote of the branch's upstream, else `origin` when that remote exists, else null. */
export function branchRemote(dir: string, branch: string | null): string | null {
  const upstream = branch === null ? undefined : git(dir, ['for-each-ref', '--format=%(upstream:remotename)', `refs/heads/${branch}`]);
  if (upstream) return upstream;
  return git(dir, ['remote', 'get-url', 'origin']) !== undefined ? 'origin' : null;
}
