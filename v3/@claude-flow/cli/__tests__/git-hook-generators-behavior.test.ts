/**
 * Behavioural tests for the generated git hooks (generatePreCommitHook /
 * generatePostCommitHook).
 *
 * These scripts run on every commit in a user's repository, but until now they
 * were only checked as strings (adr-545-pinning.test.ts asserts the version
 * pin). Here each hook is executed with bash inside a throwaway git repo, with
 * `npx` replaced by a stub that logs its argv one-per-line, so we assert what
 * the hook actually does with real staged files and real commit messages.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generatePostCommitHook, generatePreCommitHook } from '../src/init/helpers-generator.js';

const hasBash = spawnSync('bash', ['--version']).status === 0;
const hasGit = spawnSync('git', ['--version']).status === 0;
const d = hasBash && hasGit ? describe : describe.skip;

let repo: string;
let binDir: string;
let npxLog: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

/** Run a generated hook script with the stub npx first on PATH. */
function runHook(script: string) {
  const file = join(repo, '.hook.sh');
  writeFileSync(file, script);
  return spawnSync('bash', [file], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
  });
}

/** Each npx invocation, as an array of its arguments. */
function npxCalls(): string[][] {
  if (!existsSync(npxLog)) return [];
  return readFileSync(npxLog, 'utf8')
    .split('\u0000CALL\n')
    .filter(Boolean)
    .map((block) => block.split('\n').filter((l, i, a) => i < a.length - 1 || l !== ''));
}

/** The --file argument passed to every `hooks pre-edit` call. */
function validatedFiles(): string[] {
  return npxCalls()
    .filter((c) => c.includes('pre-edit'))
    .map((c) => c[c.indexOf('--file') + 1]);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'ruflo-githook-'));
  binDir = join(repo, '.stub-bin');
  npxLog = join(repo, '.npx.log');
  mkdirSync(binDir);
  // Stub npx: append each argument on its own line, then a call separator.
  writeFileSync(
    join(binDir, 'npx'),
    `#!/bin/bash\nfor a in "$@"; do printf '%s\\n' "$a"; done >> "${npxLog}"\nprintf '\\0CALL\\n' >> "${npxLog}"\n`,
  );
  chmodSync(join(binDir, 'npx'), 0o755);
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Hook Test');
  git('config', 'commit.gpgsign', 'false');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

d('generated pre-commit hook', () => {
  it('is syntactically valid bash', () => {
    const file = join(repo, '.syntax.sh');
    writeFileSync(file, generatePreCommitHook());
    expect(spawnSync('bash', ['-n', file]).status).toBe(0);
  });

  it('validates only staged ts/js/tsx/jsx files', () => {
    for (const f of ['a.ts', 'b.js', 'c.tsx', 'd.jsx', 'e.md', 'f.json', 'g.tsbak']) {
      writeFileSync(join(repo, f), 'x');
    }
    writeFileSync(join(repo, 'unstaged.ts'), 'x');
    git('add', 'a.ts', 'b.js', 'c.tsx', 'd.jsx', 'e.md', 'f.json', 'g.tsbak');

    const r = runHook(generatePreCommitHook());
    expect(r.status).toBe(0);
    expect(validatedFiles().sort()).toEqual(['a.ts', 'b.js', 'c.tsx', 'd.jsx']);
  });

  it('passes a staged file whose name contains spaces as ONE path', () => {
    writeFileSync(join(repo, 'my file.ts'), 'x');
    git('add', 'my file.ts');

    runHook(generatePreCommitHook());
    expect(validatedFiles()).toEqual(['my file.ts']);
  });

  it('does not glob-expand a staged file named with a wildcard', () => {
    // Without quoting, `for FILE in $STAGED_FILES` expands `*.ts` against the
    // working tree and validates every .ts file instead of the staged one.
    writeFileSync(join(repo, '*.ts'), 'x');
    writeFileSync(join(repo, 'other.ts'), 'x');
    git('add', '*.ts'.replace('*', '\\*'));

    runHook(generatePreCommitHook());
    expect(validatedFiles()).toEqual(['*.ts']);
  });

  it('skips deleted files (diff-filter=ACM)', () => {
    writeFileSync(join(repo, 'gone.ts'), 'x');
    git('add', 'gone.ts');
    git('commit', '-q', '--no-verify', '-m', 'add');
    git('rm', '-q', 'gone.ts');

    const r = runHook(generatePreCommitHook());
    expect(r.status).toBe(0);
    expect(validatedFiles()).toEqual([]);
  });

  it('pins the validator spec on both channels', () => {
    writeFileSync(join(repo, 'a.ts'), 'x');
    git('add', 'a.ts');
    runHook(generatePreCommitHook('latest'));
    expect(npxCalls()[0][0]).toBe('@claude-flow/cli@latest');
  });
});

d('generated post-commit hook', () => {
  function commit(message: string) {
    writeFileSync(join(repo, 'f.txt'), String(Math.random()));
    git('add', 'f.txt');
    git('commit', '-q', '--no-verify', '-m', message);
  }

  it('is syntactically valid bash', () => {
    const file = join(repo, '.syntax.sh');
    writeFileSync(file, generatePostCommitHook());
    expect(spawnSync('bash', ['-n', file]).status).toBe(0);
  });

  it('notifies with the commit hash in valid JSON metadata', () => {
    commit('feat: something');
    const hash = git('rev-parse', 'HEAD').trim();

    const r = runHook(generatePostCommitHook());
    expect(r.status).toBe(0);
    const call = npxCalls()[0];
    expect(call).toContain('notify');
    const meta = JSON.parse(call[call.indexOf('--metadata') + 1]);
    expect(meta).toEqual({ hash });
  });

  it('never executes shell syntax from the commit message', () => {
    const marker = join(repo, 'PWNED');
    commit(`fix: $(touch ${marker}) \`touch ${marker}\` "quoted" 'single'`);

    const r = runHook(generatePostCommitHook());
    expect(r.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
    const call = npxCalls()[0];
    const message = call[call.indexOf('--message') + 1];
    expect(message).toContain(`$(touch ${marker})`);
    expect(message).toContain('"quoted"');
  });

  it('passes a multi-line commit message as a single --message argument', () => {
    commit('subject line\n\nbody line one\nbody line two');

    runHook(generatePostCommitHook());
    const call = npxCalls()[0];
    const message = call.slice(call.indexOf('--message') + 1, call.indexOf('--level')).join('\n');
    expect(message.startsWith('Commit: subject line')).toBe(true);
    expect(message).toContain('body line two');
    // exactly one --message flag, i.e. the body did not split into extra argv
    expect(call.filter((a) => a === '--message')).toHaveLength(1);
  });

  it('still exits 0 when the notifier fails', () => {
    commit('x');
    writeFileSync(join(binDir, 'npx'), '#!/bin/bash\nexit 7\n');
    expect(runHook(generatePostCommitHook()).status).toBe(0);
  });
});
