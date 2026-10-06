import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const micromatch = require('micromatch');
const braces = createRequire(require.resolve('micromatch'))('braces');
const { prepare } = await import(
  new URL('../vendor/release-version/index.js', import.meta.url).href
);

test('release globs preserve matching, ranges, nesting and negation', () => {
  assert.deepEqual(braces.expand('v{1..3}.{a,{b,c}}'), [
    'v1.a',
    'v1.b',
    'v1.c',
    'v2.a',
    'v2.b',
    'v2.c',
    'v3.a',
    'v3.b',
    'v3.c',
  ]);
  assert.deepEqual(micromatch(['main', 'next', '1.x', '2.x'], ['main', '+([0-9]).x', '!2.x']), [
    'main',
    '1.x',
  ]);
  assert.deepEqual(
    micromatch(
      ['package.json', 'package-lock.json', 'CHANGELOG.md', 'src/a.ts'],
      ['package*.json', 'CHANGELOG.md'],
    ),
    ['package.json', 'package-lock.json', 'CHANGELOG.md'],
  );
});

test('patched braces rejects excessive nesting, even with raised depth options', () => {
  const input = '{'.repeat(101) + 'a,b' + '}'.repeat(101);
  for (const options of [{}, { maxDepth: Infinity }, { maxDepth: 10000 }]) {
    assert.throws(() => braces(input, options), /max depth/);
  }
  assert.throws(() => braces('('.repeat(101) + 'x' + ')'.repeat(101)), /max depth/);
});

test('patched braces bounds caller-supplied AST traversal', () => {
  const ast: { type: string; nodes: unknown[] } = { type: 'root', nodes: [] };
  let node = ast;
  for (let i = 0; i < 102; i++) {
    const child = { type: 'brace', nodes: [] as unknown[] };
    node.nodes.push(child);
    node = child;
  }
  for (const method of ['compile', 'expand', 'stringify']) {
    assert.throws(() => braces[method](structuredClone(ast)), /max depth/);
  }
});

test('local release hook updates only version metadata, without lifecycle execution', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mail-mcp-release-test-'));
  try {
    const manifest = {
      name: 'fixture',
      version: '0.2.3',
      private: true,
      scripts: { version: 'exit 99' },
    };
    const lock = {
      name: 'fixture',
      version: '0.2.3',
      lockfileVersion: 3,
      packages: { '': { version: '0.2.3' }, 'node_modules/fixture': { version: '1.0.0' } },
    };
    await writeFile(join(cwd, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(cwd, 'package-lock.json'), JSON.stringify(lock));
    await prepare({}, { cwd, nextRelease: { version: '0.2.4' }, logger: { log() {} } });
    const result = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
    const resultLock = JSON.parse(await readFile(join(cwd, 'package-lock.json'), 'utf8'));
    assert.deepEqual(result, { ...manifest, version: '0.2.4' });
    assert.equal(resultLock.version, '0.2.4');
    assert.equal(resultLock.packages[''].version, '0.2.4');
    assert.deepEqual(
      resultLock.packages['node_modules/fixture'],
      lock.packages['node_modules/fixture'],
    );
    await assert.rejects(
      prepare({}, { cwd, nextRelease: { version: 'bad/version' }, logger: { log() {} } }),
      /Invalid release version/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('semantic-release retains feature patch and breaking minor rules', async () => {
  const moduleName = '@semantic-release/commit-analyzer';
  const { analyzeCommits } = await import(moduleName);
  const config = {
    releaseRules: [
      { breaking: true, release: 'minor' },
      { type: 'feat', release: 'patch' },
    ],
  };
  for (const [message, expected] of [
    ['feat: add tool', 'patch'],
    ['fix: avoid resend', 'patch'],
    ['feat: change API\n\nBREAKING CHANGE: new input', 'minor'],
    ['docs: update usage', null],
  ]) {
    const result = await analyzeCommits(config, {
      cwd: process.cwd(),
      commits: [{ hash: 'fixture', message }],
      logger: { log() {} },
    });
    assert.equal(result, expected);
  }
});
