import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

const sourceGitUrl = new URL('./source-git.mjs', import.meta.url).href;
const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'source-git-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'), home = join(dir, 'home'), xdg = join(dir, 'xdg');
  const template = join(dir, 'template');
  for (const path of [home, join(xdg, 'git'), template]) mkdirSync(path, { recursive: true });
  const env = { ...inherited, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (args, childEnv = env) => execFileSync('git', args, { env: childEnv, encoding: 'utf8' }).trim();
  const setupEnv = { ...env, GIT_CONFIG_GLOBAL: devNull };
  git(['init', '--quiet', '--initial-branch=main', `--template=${template}`, repo], setupEnv);
  git(['-C', repo, '-c', 'user.name=SDK tests', '-c', 'user.email=tests@example.invalid',
    'commit', '--quiet', '--no-gpg-sign', '--allow-empty', '-m', 'fixture'], setupEnv);
  const args = ['-C', repo, 'rev-parse', '--short', 'HEAD'];
  // A fresh process captures each fixture environment when source-git.mjs loads.
  const source = (childEnv = env) => execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { sourceGit } from ${JSON.stringify(sourceGitUrl)}; process.stdout.write(sourceGit(JSON.parse(process.argv[1]), { encoding: 'utf8' }));`,
    JSON.stringify(args)], { env: childEnv, encoding: 'utf8' }).trim();
  return { repo, home, xdg, env, git, args, source };
}

test('sourceGit ignores the global Git config in HOME', t => {
  const { home, git, args, source } = fixture(t);
  const baseline = source();
  writeFileSync(join(home, '.gitconfig'), '[core]\n\tabbrev = 12\n');
  const configured = git(args);
  assert.equal(configured.length, 12, 'ordinary Git must observe the temporary global config');
  assert.notEqual(configured, baseline);
  assert.equal(source(), baseline);
});

test('sourceGit ignores XDG global config even with a parent GIT_CONFIG_GLOBAL override', t => {
  const { home, xdg, env, git, args, source } = fixture(t);
  const baseline = source();
  writeFileSync(join(xdg, 'git', 'config'), '[core]\n\tabbrev = 12\n');
  assert.equal(git(args).length, 12, 'ordinary Git must observe the temporary XDG config');
  const override = join(home, 'override.gitconfig');
  writeFileSync(override, '[core]\n\tabbrev = 16\n');
  const parent = { ...env, GIT_CONFIG_GLOBAL: override };
  assert.equal(git(args, parent).length, 16, 'ordinary Git must observe the parent override');
  assert.equal(source(parent), baseline);
});

test('sourceGit preserves repository-local Git config', t => {
  const { repo, home, git, source } = fixture(t);
  writeFileSync(join(home, '.gitconfig'), '[core]\n\tabbrev = 12\n');
  git(['-C', repo, 'config', '--local', 'core.abbrev', '9']);
  assert.equal(source().length, 9);
});

test('sourceGit ignores the system Git config', { skip: process.platform === 'win32' && 'the PATH wrapper is a POSIX shell script' }, t => {
  const { home, env, git, args, source } = fixture(t);
  const baseline = source();
  const system = join(home, 'system.gitconfig');
  writeFileSync(system, '[core]\n\tabbrev = 12\n');
  // sourceGit drops inherited GIT_* variables, so a wrapper between it and Git
  // points GIT_CONFIG_SYSTEM (Git >= 2.32) at the temporary system config.
  const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { env, encoding: 'utf8' }).trim();
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nGIT_CONFIG_SYSTEM=${quote(system)} exec ${quote(realGit)} "$@"\n`, { mode: 0o755 });
  const wrapped = { ...env, PATH: `${bin}${delimiter}${env.PATH}` };
  const withSystem = { ...wrapped };
  delete withSystem.GIT_CONFIG_NOSYSTEM;
  assert.equal(git(args, withSystem).length, 12, 'ordinary Git must observe the temporary system config');
  assert.equal(source(wrapped), baseline);
});
