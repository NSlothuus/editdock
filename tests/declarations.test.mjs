import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const names = ['core', 'editor', 'index', 'server-render', 'storage', 'ui'];
const hook = new URL('../scripts/fix-render-types.mjs', import.meta.url).pathname;
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'editweave-declarations-'));
  for (const name of names) await writeFile(join(dir, `${name}.d.ts`), 'export {};\n');
  return dir;
}
const run = dir => spawnSync(process.execPath, [hook, dir], { encoding: 'utf8' });

test('normalizes root, transitive, type-only and renderer declarations without touching bare or .js', async () => {
  const dir = await fixture();
  try {
    await writeFile(join(dir, 'index.d.ts'), "export { x } from './editor';\nexport type { T } from './storage';\nexport { y } from 'some-package';\n");
    await writeFile(join(dir, 'editor.d.ts'), "import type { T } from './core';\nexport type Indirect = import('./ui').Thing;\n");
    await writeFile(join(dir, 'server-render.d.ts'), "import type { T } from './core.ts';\nexport { y } from './core.js';\nimport type { Stats } from 'node:fs';\n");
    const first = run(dir);
    assert.equal(first.status, 0, first.stderr);
    assert.match(await readFile(join(dir, 'index.d.ts'), 'utf8'), /'\.\/editor\.js'.*\n.*'\.\/storage\.js'.*\n.*'some-package'/);
    assert.match(await readFile(join(dir, 'editor.d.ts'), 'utf8'), /'\.\/core\.js'.*\n.*'\.\/ui\.js'/);
    const render = await readFile(join(dir, 'server-render.d.ts'), 'utf8');
    assert.match(render, /'\.\/core\.js'/);
    assert.match(render, /'node:fs'/);
    const snapshot = await Promise.all((await readdir(dir)).map(async file => readFile(join(dir, file), 'utf8')));
    const second = run(dir);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(await Promise.all((await readdir(dir)).map(async file => readFile(join(dir, file), 'utf8'))), snapshot);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('fails closed on missing adjacent target or an unexpected declaration layout', async () => {
  const dir = await fixture();
  try {
    await writeFile(join(dir, 'index.d.ts'), "export { x } from './editor';\n");
    await writeFile(join(dir, 'ui.d.ts'), "export type Missing = import('./missing').Thing;\n");
    const before = await readFile(join(dir, 'index.d.ts'), 'utf8');
    assert.notEqual(run(dir).status, 0);
    assert.equal(await readFile(join(dir, 'index.d.ts'), 'utf8'), before);
    await writeFile(join(dir, 'ui.d.ts'), 'export {};\n');
    await writeFile(join(dir, 'unexpected.d.ts'), 'export {};\n');
    assert.notEqual(run(dir).status, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
