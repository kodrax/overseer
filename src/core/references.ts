import { CONNECTION_HOSTS, type Connection, type ConnectionHost, parseRepository } from './connections.js';
import type { Database } from './db.js';
import { OverseerError } from './errors.js';
import { classifyHost, parseRemoteUrl } from './remotes.js';

/**
 * A GitHub or GitLab issue reference: `#7`, `acme/demo#7`, `github:acme/demo#7`, `gitlab:group/sub/project#3`, a
 * GitHub `…/issues/7` URL or a GitLab `…/-/issues/3` or `…/-/work_items/3` URL.
 */
export interface IssueReference {
  /** The reference as given, trimmed. */
  text: string;
  /** Hosts the repository can be on: both for `owner/repo#N`, GitLab alone for deeper paths; empty for `#N`. */
  hosts: ConnectionHost[];
  /** Repository path; null for `#N`. */
  repository: string | null;
  number: number;
  /** The URL when the reference was one; null otherwise. */
  url: string | null;
}

/** What to import when a reference to a connected repository matches no item (the `NOT_FOUND` details). */
export interface MissingIssue {
  source: ConnectionHost;
  repo: string;
  /** `<repo>#<number>`, the `external_id` of `import_items`. */
  external_id: string;
  url: string;
}

const NUMBER = '([1-9]\\d*)';
const BARE = new RegExp(`^#${NUMBER}$`);
const SHORT = new RegExp(`^(?:(github|gitlab):)?([^\\s#:/]+(?:/[^\\s#:/]+)+)#${NUMBER}$`, 'i');
const GITLAB_PATH = new RegExp(`^(.+?)/-/(?:issues|work_items)/${NUMBER}$`);
const ISSUES_PATH = new RegExp(`^(.+?)/issues/${NUMBER}$`);

function parseShort(text: string): IssueReference | undefined {
  const match = SHORT.exec(text);
  if (!match) return undefined;
  const host = match[1]?.toLowerCase() as ConnectionHost | undefined;
  const number = Number(match[3]);
  if (host) return { text, hosts: [host], repository: parseRepository(host, match[2]!), number, url: null };
  // owner/repo is a GitHub or a GitLab repository; group/sub/project only a GitLab one.
  const repository = parseRepository('gitlab', match[2]!);
  return { text, hosts: repository.split('/').length === 2 ? [...CONNECTION_HOSTS] : ['gitlab'], repository, number, url: null };
}

function parseUrl(text: string): IssueReference | undefined {
  if (!/^https?:\/\//i.test(text)) return undefined;
  const parsed = parseRemoteUrl(text);
  if (!parsed) return undefined;
  const url = text.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const host = classifyHost(parsed.hostname);
  // `/-/` paths are GitLab's on any hostname (self-managed servers included).
  const gitlab = GITLAB_PATH.exec(parsed.repository) ?? (host === 'gitlab' ? ISSUES_PATH.exec(parsed.repository) : null);
  if (gitlab) return { text, hosts: ['gitlab'], repository: parseRepository('gitlab', gitlab[1]!), number: Number(gitlab[2]), url };
  const github = host === 'github' ? ISSUES_PATH.exec(parsed.repository) : null;
  if (github) return { text, hosts: ['github'], repository: parseRepository('github', github[1]!), number: Number(github[2]), url };
  return undefined;
}

/**
 * The issue reference `text` names; undefined when it is no reference (item IDs included). A reference-shaped text
 * with an impossible repository (`github:a/b/c#1`) gives INVALID_INPUT.
 */
export function parseIssueReference(text: string): IssueReference | undefined {
  const value = text.trim();
  const bare = BARE.exec(value);
  if (bare) return { text: value, hosts: [], repository: null, number: Number(bare[1]), url: null };
  return parseUrl(value) ?? parseShort(value);
}

const HOST_NAME: Record<ConnectionHost, string> = { github: 'GitHub', gitlab: 'GitLab' };

/** `#N` names an issue of the one connected repository; INVALID_INPUT when none or several are connected. */
function bareTarget(reference: IssueReference, connections: Connection[]): { hosts: ConnectionHost[]; repository: string } {
  if (connections.length === 1) return { hosts: [connections[0]!.host], repository: connections[0]!.repository };
  const why =
    connections.length === 0
      ? 'no repository is connected'
      : `${connections.length} repositories are connected (${connections.map((connection) => `${connection.host} ${connection.repository}`).join(', ')})`;
  throw new OverseerError(
    'INVALID_INPUT',
    `${reference.text} is ambiguous: ${why}. Write owner/repo${reference.text} (group/project${reference.text} on GitLab) or the issue URL.`,
  );
}

/**
 * The ID of the item an issue reference names, through the imported `items.external_ref` (`<host>:<repo>#<n>`) and
 * the connections' `item_remote_refs` (`<repo>#<n>` or `<host>:<repo>#<n>`); repositories compare case-insensitively.
 * No item: NOT_FOUND, with {@link MissingIssue} details when the repository is connected.
 */
export function resolveIssueReference(db: Database, connections: Connection[], reference: IssueReference): string {
  const { hosts, repository } = reference.repository === null ? bareTarget(reference, connections) : { hosts: reference.hosts, repository: reference.repository };
  const imported = db.prepare('SELECT id FROM items WHERE lower(external_ref) = lower(?)');
  const synced = db.prepare(
    `SELECT r.item_id AS id FROM item_remote_refs r JOIN connections c ON c.id = r.connection_id
     WHERE c.host = ? AND lower(c.repository) = lower(?) AND lower(r.external_ref) IN (lower(?), lower(?))
     ORDER BY c.id LIMIT 1`,
  );
  const externalId = `${repository}#${reference.number}`;
  for (const host of hosts) {
    const row = imported.get(`${host}:${externalId}`) ?? synced.get(host, repository, externalId, `${host}:${externalId}`);
    if (row) return String(row.id);
  }
  const connection = connections.find((candidate) => hosts.includes(candidate.host) && candidate.repository.toLowerCase() === repository.toLowerCase());
  if (!connection) throw new OverseerError('NOT_FOUND', `No item for ${reference.text}.`);
  const { host: source, repository: repo } = connection;
  const missing: MissingIssue = {
    source,
    repo,
    external_id: `${repo}#${reference.number}`,
    url: reference.url ?? (source === 'github' ? `https://github.com/${repo}/issues/${reference.number}` : `https://gitlab.com/${repo}/-/issues/${reference.number}`),
  };
  throw new OverseerError(
    'NOT_FOUND',
    `No item for ${reference.text}: issue ${missing.external_id} of the connected ${HOST_NAME[missing.source]} repository is not on the board. Import it (source ${missing.source}, repo ${missing.repo}, external_id ${missing.external_id}, url ${missing.url}) and retry.`,
    missing,
  );
}
