#!/usr/bin/env node
// Packaged Node-only, JSON-first entry; the editor's browser root is never imported.
import { open, mkdtemp, mkdir, link, lstat, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { apply, emptyProject, validate } from './core.ts';
import { renderMP4, RenderLifecycleError, RenderPublicationCommittedError } from './server-render.ts';

const VERSION = 1;
const COMMAND_FIELDS = Object.freeze({
  'track.add': ['kind'], 'project.upgradeTracks': [], 'asset.add': ['asset'],
  'clip.add': ['clip'], 'clip.trim': ['id', 'edge', 'frames'],
  'clip.resize': ['id', 'edge', 'delta'], 'clip.split': ['id', 'at', 'newId'],
  'clip.move': ['id', 'start', 'trackId'], 'clip.remove': ['id'],
  'clip.text': ['id', 'text'], 'clip.style': ['id', 'style'],
  'clip.sourceAudio': ['id', 'settings'], 'clip.effect': ['id', 'effect'],
});
const USAGE = Object.freeze({
  help: [], schema: [], doctor: ['--ffmpeg?'],
  'project init': ['--output'], 'project validate': ['--project'],
  'project apply': ['--project', '--commands', '--output'],
  render: ['--project', '--manifest', '--output', '--ffmpeg?', '--timeout-ms?'],
});
class CliError extends Error {
  constructor(code, message, exitCode, details = undefined) {
    super(message); this.code = code; this.exitCode = exitCode; this.details = details;
  }
}
const bad = (message, code = 'INVALID_INPUT', exitCode = 3) => { throw new CliError(code, message, exitCode); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const result = (ok, command, fields) => ({ schemaVersion: VERSION, ok, command, ...fields });
const emit = payload => process.stdout.write(JSON.stringify(payload) + '\n');
const diagnostic = message => process.stderr.write(`[editdock] ${message}\n`);
function parseArgs(argv) {
  const command = argv[0] === 'project' ? argv.slice(0, 2).join(' ') : argv[0];
  if (!Object.hasOwn(USAGE, command)) bad('Unknown subcommand. Run editdock help.', 'USAGE', 2);
  const args = argv.slice(argv[0] === 'project' ? 2 : 1);
  const declared = USAGE[command];
  const allowed = new Set(declared.map(x => x.replace('?', '')));
  const opts = Object.create(null);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!allowed.has(key) || typeof value !== 'string' || value.startsWith('--') || Object.hasOwn(opts, key))
      bad(`Invalid or repeated option ${key ?? '(missing)'}`, 'USAGE', 2);
    opts[key] = value;
  }
  for (const key of declared.filter(x => !x.endsWith('?'))) {
    if (!opts[key]) bad(`Missing ${key}`, 'USAGE', 2);
  }
  return [command, opts];
}
const absolute = (value, label) => {
  if (!isAbsolute(value) || value.includes('\0')) bad(`${label} must be an absolute local path`);
  return resolve(value);
};
async function jsonFile(path, label) {
  const f = await open(absolute(path, label), constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await f.stat();
    if (!info.isFile() || info.size > 8 * 1024 * 1024) bad(`${label} must be a regular JSON file of at most 8 MiB`);
    // A regular file may grow after fstat; never let readFile consume it unboundedly.
    const limit = 8 * 1024 * 1024, buffer = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await f.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > limit) bad(`${label} must be a regular JSON file of at most 8 MiB`);
    try { return JSON.parse(buffer.subarray(0, count).toString('utf8')); }
    catch (e) { bad(`${label}: invalid JSON (${e.message})`); }
  } finally { await f.close(); }
}
async function projectFile(path) {
  const project = await jsonFile(path, 'project');
  try { return validate(project); }
  catch (e) { bad(`project: ${e.message}`); }
}
function checkedCommands(input) {
  const commands = Array.isArray(input) ? input : [input];
  if (!commands.length || commands.length > 400) bad('commands: expected 1–400 typed commands');
  for (const [index, c] of commands.entries()) {
    if (!object(c) || !Object.hasOwn(COMMAND_FIELDS, c.type)) bad(`commands[${index}]: unknown command type`);
    const fields = COMMAND_FIELDS[c.type];
    if (Object.keys(c).some(key => key !== 'type' && !fields.includes(key))) bad(`commands[${index}]: unknown command field`);
    if (c.type !== 'track.add' && fields.some(key => !Object.hasOwn(c, key))) bad(`commands[${index}]: missing command field`);
    if (c.type === 'track.add' && c.kind === null) bad(`commands[${index}]: invalid kind`);
    // The core's apply + validate remain the authority for field types and invariants.
  }
  return commands;
}
async function publishJSON(path, value) {
  const output = absolute(path, 'output');
  // wx is create-only: never change an existing project (including symlinks).
  const file = await open(output, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  return output;
}
const sha = () => createHash('sha256');
async function digestFile(path) {
  const file = await open(path, 'r');
  try {
    const hash = sha(), buffer = Buffer.alloc(1024 * 1024);
    let position = 0, n;
    while ((n = (await file.read(buffer, 0, buffer.length, position)).bytesRead)) {
      hash.update(buffer.subarray(0, n)); position += n;
    }
    return { bytes: position, sha256: hash.digest('hex') };
  } finally { await file.close(); }
}
async function snapshotAsset(asset, source, stage, signal) {
  const sourcePath = absolute(source, `asset ${asset.id}`);
  // O_NONBLOCK prevents an untrusted FIFO from hanging before fstat can refuse it.
  const input = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const first = await input.stat();
    const entry = await lstat(sourcePath);
    if (!first.isFile() || !entry.isFile() || first.nlink !== 1 || first.ino !== entry.ino || first.dev !== entry.dev || first.size < 1)
      bad(`asset ${asset.id}: expected a non-symlink, single-link nonempty regular file`);
    const extension = extname(sourcePath).toLowerCase();
    const snapshot = join(stage, `asset-${asset.id}${/^[.][a-z0-9]{1,8}$/.test(extension) ? extension : '.bin'}`);
    const output = await open(snapshot, 'wx', 0o600);
    let count = 0;
    const hash = sha(), buffer = Buffer.alloc(1024 * 1024);
    try {
      for (;;) {
        if (signal.aborted) throw new DOMException('Render cancelled', 'AbortError');
        const { bytesRead } = await input.read(buffer, 0, buffer.length, count);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) written += (await output.write(buffer, written, bytesRead - written)).bytesWritten;
        count += bytesRead;
      }
      await output.sync();
    } finally { await output.close(); }
    const sourceAfter = await input.stat();
    const original = { bytes: count, sha256: hash.digest('hex') };
    const staged = await digestFile(snapshot);
    if (first.size !== count || sourceAfter.size !== count || sourceAfter.ino !== first.ino || sourceAfter.dev !== first.dev ||
        sourceAfter.mtimeMs !== first.mtimeMs || sourceAfter.ctimeMs !== first.ctimeMs ||
        staged.bytes !== count || staged.sha256 !== original.sha256)
      bad(`asset ${asset.id}: source changed or snapshot verification failed`, 'SOURCE_CHANGED', 6);
    return { id: asset.id, sourcePath, snapshot, ...original };
  } finally { await input.close(); }
}
function manifestMapping(manifest, project) {
  if (!object(manifest) || manifest.version !== 1 || !object(manifest.assets) ||
      Object.keys(manifest).some(k => !['version', 'assets'].includes(k))) bad('manifest: expected {"version":1,"assets":{...}}');
  const ids = project.assets.map(a => a.id).sort();
  const keys = Object.keys(manifest.assets).sort();
  if (JSON.stringify(ids) !== JSON.stringify(keys)) bad('manifest: asset IDs must exactly match project assets');
  for (const key of keys) if (typeof manifest.assets[key] !== 'string' || !isAbsolute(manifest.assets[key])) bad(`manifest: invalid absolute local path for ${key}`);
  return manifest.assets;
}
function executable(path) {
  if (path !== 'ffmpeg') absolute(path, 'ffmpeg');
  const probe = spawnSync(path, ['-version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
  return { available: !probe.error && probe.status === 0 && /^ffmpeg version /m.test(probe.stdout),
    version: probe.stdout?.split('\n')[0] ?? null,
    error: probe.error?.message ?? (probe.status === 0 ? null : `exit ${probe.status}`) };
}
async function render(project, mapping, options) {
  const target = absolute(options['--output'], 'output');
  const parent = dirname(target);
  const parentInfo = await stat(parent);
  if (!parentInfo.isDirectory()) bad('output parent must be a directory');
  try { await lstat(target); bad('output already exists', 'CONFLICT', 5); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const ffmpeg = options['--ffmpeg'] ?? 'ffmpeg';
  if (!executable(ffmpeg).available) bad('FFmpeg executable unavailable; run doctor --ffmpeg /absolute/path', 'PREREQUISITE', 4);
  const timeoutMs = options['--timeout-ms'] === undefined ? 120000 : Number(options['--timeout-ms']);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) bad('invalid timeout-ms');
  // Sibling stage keeps the final hard-link install on the same filesystem.
  const stage = await mkdtemp(join(parent, '.editdock-cli-'));
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const cancelled = () => { if (controller.signal.aborted) throw new DOMException('Render cancelled', 'AbortError'); };
  const assets = [];
  try {
    await mkdir(join(stage, 'renderer'), { mode: 0o700 });
    for (const asset of project.assets) {
      cancelled();
      assets.push(await snapshotAsset(asset, mapping[asset.id], stage, controller.signal));
    }
    cancelled();
    diagnostic(`snapshotted ${assets.length} assets; native rendering in private stage`);
    const stagedOutput = join(stage, 'rendered.mp4');
    await renderMP4({ project, outputPath: stagedOutput, workDirectory: join(stage, 'renderer'),
      ffmpeg, timeoutMs, signal: controller.signal,
      resolveAsset: asset => assets.find(x => x.id === asset.id).snapshot });
    // The renderer only publishes to our private directory; link() is atomic no-replace.
    const before = await digestFile(stagedOutput);
    if (!before.bytes) bad('empty render', 'NATIVE_FAILURE', 6);
    cancelled();
    try { await link(stagedOutput, target); }
    catch (e) {
      if (e.code === 'EEXIST') throw e; // Atomic no-replace conflict, never delete the owner.
      const fault = new CliError('PUBLICATION_UNCERTAIN', 'publication outcome uncertain; retain stage and inspect target', 7);
      fault.outputPath = target; throw fault;
    }
    // From here on the link committed. Even readback failure or a late signal is typed 7.
    try {
      const after = await digestFile(target);
      const inodes = [await stat(stagedOutput), await stat(target)];
      if (before.sha256 !== after.sha256 || before.bytes !== after.bytes ||
          inodes[0].ino !== inodes[1].ino || inodes[0].dev !== inodes[1].dev)
        throw new Error('publication identity or digest mismatch');
      if (controller.signal.aborted) throw new Error('late signal after publication');
    } catch (cause) {
      const fault = new CliError(controller.signal.aborted ? 'RENDER_PUBLICATION_COMMITTED' : 'PUBLICATION_UNCERTAIN',
        'publication committed or unverifiable; retain stage and inspect target', 7);
      fault.outputPath = target; fault.cause = cause; throw fault;
    }
    // Deliberately retain the owned stage: never blindly recursively clean a replacement.
    return { outputPath: target, output: before, stageDirectory: stage, assets: assets.map(({id, bytes, sha256}) => ({id, bytes, sha256})),
      stageRetained: true };
  } catch (e) {
    e.stageDirectory ??= stage;
    throw e;
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
}
async function main(argv) {
  const [command, opts] = parseArgs(argv);
  if (command === 'help') return result(true, command, { usage: USAGE, stdout: 'one versioned JSON object; errors use nonzero exit code',
    exitCodes: { usage: 2, invalidInput: 3, prerequisite: 4, conflict: 5, nativeOrSource: 6, uncertain: 7 } });
  if (command === 'schema') return result(true, command, { project: 'SDK Project v1/v2/v3; default emptyProject() is v3; unknown project fields remain opaque',
    commandFile: 'one Command object or nonempty array of typed Command objects; apply uses core.apply sequentially',
    commandFields: COMMAND_FIELDS, manifest: { version: 1, assets: 'exact project asset-ID → absolute local regular-file path' },
    output: 'create-only; never update project or output in place' });
  if (command === 'doctor') {
    const ffmpeg = opts['--ffmpeg'] ?? 'ffmpeg';
    const probe = executable(ffmpeg);
    const reference = process.platform === 'darwin' && process.arch === 'arm64' && process.versions.node === '26.7.0';
    return result(probe.available && reference, command, { runtime: { node: process.version, platform: process.platform, arch: process.arch,
      referenceCombination: reference, verifiedCombination: false, otherCombinationsUntested: true,
      qualification: 'Prerequisites only; current host executable identities and media workflow require independent verification' },
      ffmpeg: { path: ffmpeg, ...probe },
      capabilities: { core: true, installedNodeRenderer: true, localFileSnapshot: true, createOnlyOutput: true,
        browser: false, httpHost: false, remoteServer: false, ffmpegBundled: false, publicAuthentication: false },
      limitations: ['POSIX process-group lifecycle only; escaped descendants not proven absent', 'private stage retained',
        'caller supplies admitted media metadata and trusted absolute local asset paths'] });
  }
  if (command === 'project init') {
    const project = emptyProject();
    return result(true, command, { outputPath: await publishJSON(opts['--output'], project), project });
  }
  if (command === 'project validate') {
    const project = await projectFile(opts['--project']);
    return result(true, command, { version: project.version, revision: project.revision,
      assets: project.assets.length, clips: project.clips.length });
  }
  if (command === 'project apply') {
    let project = await projectFile(opts['--project']);
    const commands = checkedCommands(await jsonFile(opts['--commands'], 'commands'));
    for (const [index, cmd] of commands.entries()) {
      try { project = apply(project, cmd); }
      catch (e) { bad(`commands[${index}]: ${e.message}`); }
    }
    return result(true, command, { outputPath: await publishJSON(opts['--output'], project),
      applied: commands.length, revision: project.revision, project });
  }
  const project = await projectFile(opts['--project']);
  const mapping = manifestMapping(await jsonFile(opts['--manifest'], 'manifest'), project);
  const rendered = await render(project, mapping, opts);
  return result(true, command, rendered);
}
try {
  const argv = process.argv.slice(2);
  const command = argv[0] === 'project' ? argv.slice(0, 2).join(' ') : argv[0] ?? null;
  const payload = await main(argv);
  emit(payload);
  // Diagnostic output is not a readiness claim when prerequisites are missing.
  if (command === 'doctor' && !payload.ok) process.exitCode = 4;
} catch (e) {
  const uncertain = e instanceof RenderLifecycleError || e instanceof RenderPublicationCommittedError || e.code === 'PUBLICATION_UNCERTAIN';
  const code = uncertain ? e.code : e instanceof CliError ? e.code : e.code === 'EEXIST' ? 'CONFLICT' :
    e.name === 'AbortError' ? 'CANCELLED' : 'OPERATION_FAILED';
  const exit = uncertain ? 7 : e instanceof CliError ? e.exitCode : e.code === 'EEXIST' ? 5 : 6;
  diagnostic(`${code}: ${e.message}`);
  emit(result(false, process.argv[2] === 'project' ? process.argv.slice(2, 4).join(' ') : process.argv[2] ?? null,
    { error: { code, message: e.message, ...(e.stageDirectory ? { stageDirectory: e.stageDirectory } : {}),
      ...(e.recoveryOutputPath ? { recoveryOutputPath: e.recoveryOutputPath } : {}),
      ...(e.outputPath ? { outputPath: e.outputPath } : {}),
      ...(e.lifecycle ? { lifecycle: e.lifecycle } : {}),
      ...(e.lateReason ? { lateReason: e.lateReason } : {}) } }));
  process.exitCode = exit;
}
