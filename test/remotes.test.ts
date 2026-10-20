import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyHost, detectRemotes, parseRemotes, parseRemoteUrl } from '../src/core/remotes.js';
import { git, isolateGitConfig, tempDir, tempRepo } from './helpers/tmp.js';

beforeEach(isolateGitConfig);
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parseRemoteUrl', () => {
  it.each([
    ['git@github.com:acme/demo.git', 'github.com', 'acme/demo'],
    ['git@github.com:acme/demo', 'github.com', 'acme/demo'],
    ['github.com:acme/demo.git/', 'github.com', 'acme/demo'],
    ['git@gitlab.example.com:/group/sub/project.git', 'gitlab.example.com', 'group/sub/project'],
    ['https://github.com/acme/demo.git', 'github.com', 'acme/demo'],
    ['https://github.com/acme/demo/', 'github.com', 'acme/demo'],
    ['https://GitHub.com/acme/demo.git/', 'github.com', 'acme/demo'],
    ['https://x-access-token:ghp_secret@github.com/acme/demo.git', 'github.com', 'acme/demo'],
    ['https://oauth2@gitlab.com/group/sub/project', 'gitlab.com', 'group/sub/project'],
    ['http://git.example.com:8080/team/tool.git', 'git.example.com', 'team/tool'],
    ['ssh://git@gitlab.example.com:2222/group/sub/project.git', 'gitlab.example.com', 'group/sub/project'],
    ['ssh://gitlab.com/group/project/', 'gitlab.com', 'group/project'],
    ['git+ssh://git@github.com/acme/demo.git', 'github.com', 'acme/demo'],
    ['git://git.example.com/team/tool.git', 'git.example.com', 'team/tool'],
    ['ssh://git@[::1]:22/acme/demo.git', '::1', 'acme/demo'],
  ])('%s → %s %s', (url, hostname, repository) => {
    expect(parseRemoteUrl(url)).toEqual({ hostname, repository });
  });

  it.each(['/srv/git/demo.git', './demo', '../demo.git', 'file:///srv/git/demo.git', 'C:\\repos\\demo', 'C:/repos/demo', 'https://github.com/', 'git@github.com:', ''])(
    'ignores %j (local path or no repository)',
    (url) => {
      expect(parseRemoteUrl(url)).toBeUndefined();
    },
  );
});

describe('classifyHost', () => {
  it.each([
    ['github.com', 'github'],
    ['GitHub.com', 'github'],
    ['ssh.github.com', 'github'],
    ['gitlab.com', 'gitlab'],
    ['gitlab.example.com', 'gitlab'],
    ['code.gitlab.acme.io', 'gitlab'],
    ['github.acme.com', 'unknown'],
    ['git.example.com', 'unknown'],
    ['bitbucket.org', 'unknown'],
  ])('%s → %s', (hostname, host) => {
    expect(classifyHost(hostname)).toBe(host);
  });
});

describe('parseRemotes', () => {
  it('lists every remote once per repository, keeping all remote names and the unknown hosts', () => {
    const output = [
      'origin\tgit@github.com:acme/demo.git (fetch)',
      'origin\tgit@github.com:acme/demo.git (push)',
      'mirror\thttps://token:secret@github.com/Acme/Demo/ (fetch)',
      'mirror\thttps://token:secret@github.com/Acme/Demo/ (push)',
      'lab\tssh://git@gitlab.example.com:2222/group/sub/project.git (fetch)',
      'lab\thttps://gitlab.example.com/group/sub/project (push)',
      'ghe\tgit@github.acme.com:team/tool.git (fetch)',
      'ghe\tgit@github.acme.com:team/tool.git (push)',
      'local\t/srv/git/demo.git (fetch)',
      'local\t/srv/git/demo.git (push)',
      '',
    ].join('\n');

    expect(parseRemotes(output)).toEqual([
      {
        host: 'github',
        hostname: 'github.com',
        repository: 'acme/demo',
        remotes: [
          { name: 'origin', url: 'git@github.com:acme/demo.git' },
          { name: 'mirror', url: 'https://github.com/Acme/Demo/' },
        ],
      },
      {
        host: 'gitlab',
        hostname: 'gitlab.example.com',
        repository: 'group/sub/project',
        remotes: [
          { name: 'lab', url: 'ssh://git@gitlab.example.com:2222/group/sub/project.git' },
          { name: 'lab', url: 'https://gitlab.example.com/group/sub/project' },
        ],
      },
      { host: 'unknown', hostname: 'github.acme.com', repository: 'team/tool', remotes: [{ name: 'ghe', url: 'git@github.acme.com:team/tool.git' }] },
    ]);
  });

  it('returns an empty list for empty output', () => {
    expect(parseRemotes('')).toEqual([]);
  });
});

describe('detectRemotes', () => {
  it('reads every remote of a repository', () => {
    const repo = tempRepo();
    git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/demo.git');
    git(repo, 'remote', 'add', 'upstream', 'https://gitlab.com/group/sub/project.git');
    expect(detectRemotes(repo).map(({ host, repository, remotes }) => [host, repository, remotes.map((remote) => remote.name)])).toEqual([
      ['github', 'acme/demo', ['origin']],
      ['gitlab', 'group/sub/project', ['upstream']],
    ]);
  });

  it('returns an empty list without remotes or outside git', () => {
    expect(detectRemotes(tempRepo())).toEqual([]);
    expect(detectRemotes(tempDir())).toEqual([]);
  });
});
