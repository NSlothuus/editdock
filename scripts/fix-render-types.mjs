import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

// Runtime source keeps its Node strip-types .ts imports. Declaration-only emit
// preserves those and browser-source extensionless imports, which NodeNext rejects.
const directory = resolve(process.argv[2] ?? 'dist/types');
const expected = ['core.d.ts', 'editor.d.ts', 'index.d.ts', 'server-render.d.ts', 'storage.d.ts', 'ui.d.ts'];
const files = (await readdir(directory)).filter(name => name.endsWith('.d.ts')).sort();
if (JSON.stringify(files) !== JSON.stringify(expected)) throw new Error(`Unexpected declaration layout: ${files.join(', ')}`);
const names = new Set(files);
const updates = [];
for (const name of files) {
  const file = resolve(directory, name);
  const source = await readFile(file, 'utf8');
  // Only TS-emitted declaration module references, not arbitrary quoted strings.
  // Handles `from`, side-effect imports and import('./relative') type references.
  const pattern = /\b(?:from\s*|import\s*(?:\(\s*)?)(['"])([^'"\r\n]+)\1/g;
  const edits = [];
  for (const match of source.matchAll(pattern)) {
    const specifier = match[2];
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue; // bare imports stay bare
    const target = specifier.endsWith('.ts') ? specifier.slice(0, -3) : specifier.endsWith('.js') ? specifier.slice(0, -3) : specifier;
    const declaration = resolve(dirname(file), `${target}.d.ts`);
    if (dirname(declaration) !== directory || !names.has(basename(declaration))) {
      throw new Error(`Unresolved or nonadjacent declaration ${name}: ${specifier}`);
    }
    if (!specifier.endsWith('.js')) {
      const start = match.index + match[0].length - specifier.length - 1;
      edits.push({ start, end: start + specifier.length, value: `${target}.js` });
    }
  }
  let fixed = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) fixed = fixed.slice(0, edit.start) + edit.value + fixed.slice(edit.end);
  updates.push([file, source, fixed]);
}
// Stage and validate every file before mutating any emitted declaration.
for (const [file, source, fixed] of updates) if (source !== fixed) await writeFile(file, fixed);
console.log(`Verified ${files.length} adjacent ESM declarations; normalized ${updates.filter(([, a, b]) => a !== b).length} files`);
