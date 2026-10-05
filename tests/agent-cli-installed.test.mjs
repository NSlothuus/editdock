// Offline installed-bin proof. No HTTP/browser/host server is started.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, lstat, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const evidence = process.argv[2];
assert(evidence && evidence.startsWith('/'), 'absolute evidence directory required');
const ffmpeg = process.env.FFMPEG;
const ffprobe = process.env.FFPROBE;
assert(ffmpeg && ffmpeg.startsWith('/') && ffprobe && ffprobe.startsWith('/'), 'absolute FFMPEG and FFPROBE required');
const sha = b => createHash('sha256').update(b).digest('hex');
const log = [];
function run(name, program, args, cwd = root, expected = 0) {
  const r = spawnSync(program, args, { cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  log.push({ name, command: [program, ...args], exit: r.status, stdout: r.stdout?.trim(), stderr: r.stderr?.trim() });
  assert.equal(r.status, expected, `${name}: ${r.error?.message ?? r.stderr}`);
  return r;
}
async function main() {
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const packed = JSON.parse(run('pack', 'npm', ['pack', '--json', '--pack-destination', evidence]).stdout);
  assert.equal(packed.length, 1);
  const archive = join(evidence, packed[0].filename);
  const consumer = join(evidence, 'consumer');
  await mkdir(consumer, { recursive: true });
  run('offline install', 'npm', ['install', '--prefix', consumer, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', archive]);
  const bin = join(consumer, 'node_modules', '.bin', 'editdock');
  const binInfo = await lstat(bin);
  assert(binInfo.isSymbolicLink(), 'npm must create an actual bin symlink');
  const cli = (name, args, expected = 0) => {
    const r = run(name, bin, args, consumer, expected);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1, `${name}: stdout must be a single JSON line`);
    const doc = JSON.parse(lines[0]);
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.ok, expected === 0);
    return doc;
  };
  cli('help', ['help']);
  const schema = cli('schema', ['schema']);
  assert(schema.commandFields['clip.trim'].includes('frames'));
  const doctor = cli('doctor', ['doctor', '--ffmpeg', ffmpeg]);
  assert(doctor.ffmpeg.available && doctor.runtime.referenceCombination && !doctor.runtime.verifiedCombination);
  cli('doctor missing binary', ['doctor', '--ffmpeg', '/absent/ffmpeg'], 4);
  const fixture = join(evidence, 'fixture');
  await mkdir(fixture, { recursive: true, mode: 0o700 });
  const source = join(fixture, 'original.mp4');
  run('generate admitted media', ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=320x180:rate=30', '-frames:v', '60', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
  const sourceBytes = await readFile(source), sourceSha256 = sha(sourceBytes);
  const media = JSON.parse(run('probe source', ffprobe, ['-v', 'error', '-show_entries',
    'stream=codec_type,nb_frames,r_frame_rate:format=duration', '-of', 'json', source]).stdout);
  assert.equal(media.streams.filter(s => s.codec_type === 'video')[0].nb_frames, '60');
  assert.equal(media.streams.filter(s => s.codec_type === 'audio').length, 0);
  assert.equal(media.streams[0].r_frame_rate, '30/1');
  const blank = join(fixture, 'blank.json');
  cli('init', ['project', 'init', '--output', blank]);
  cli('init existing', ['project', 'init', '--output', blank], 5);
  const blankHash = sha(await readFile(blank));
  const imported = join(fixture, 'imported.json');
  const blankObject = JSON.parse(await readFile(blank));
  blankObject.hostMarker = { unchanged: 'opaque' };
  await writeFile(imported, JSON.stringify(blankObject));
  cli('validate imported', ['project', 'validate', '--project', imported]);
  const commands = [
    { type: 'asset.add', asset: { id: 'take1', name: 'generated testsrc', kind: 'video', durationFrames: 60,
      url: '/media/not-a-local-authority.mp4', hasSourceAudio: false, hostNote: 'opaque asset' } },
    { type: 'clip.add', clip: { id: 'video1', trackId: 'L1', assetId: 'take1', start: 0, inFrame: 0, duration: 60,
      hostNote: 'opaque clip' } },
    { type: 'clip.trim', id: 'video1', edge: 'start', frames: 4 },
    { type: 'track.add' },
    { type: 'clip.add', clip: { id: 'title1', trackId: 'L2', text: 'Agent title', role: 'title',
      start: 0, inFrame: 0, duration: 50 } },
    { type: 'track.add' },
    { type: 'clip.add', clip: { id: 'caption1', trackId: 'L3', text: 'Agent caption', role: 'caption',
      start: 4, inFrame: 0, duration: 40 } },
  ];
  const commandsPath = join(fixture, 'commands.json');
  await writeFile(commandsPath, JSON.stringify(commands));
  const edited = join(fixture, 'edited.json');
  const applied = cli('apply commands', ['project', 'apply', '--project', imported, '--commands', commandsPath, '--output', edited]);
  assert.equal(applied.applied, commands.length);
  assert.equal(applied.project.revision, commands.length);
  assert.equal(applied.project.clips.find(c => c.id === 'video1').inFrame, 4);
  assert.equal(applied.project.hostMarker.unchanged, 'opaque');
  assert.equal(applied.project.assets[0].hostNote, 'opaque asset');
  assert.equal(applied.project.clips[0].hostNote, 'opaque clip');
  assert.deepEqual(applied.project.assets.map(a => a.id), ['take1']);
  cli('validate edited', ['project', 'validate', '--project', edited]);
  cli('apply existing', ['project', 'apply', '--project', imported, '--commands', commandsPath, '--output', edited], 5);
  const invalidCommands = join(fixture, 'invalid-commands.json');
  await writeFile(invalidCommands, JSON.stringify([{ type: 'clip.trim', id: 'video1', edge: 'start', frames: 999 }]));
  cli('invalid typed command', ['project', 'apply', '--project', edited, '--commands', invalidCommands,
    '--output', join(fixture, 'should-not-exist.json')], 3);
  await writeFile(invalidCommands, JSON.stringify([{ type: 'not-a-command' }]));
  cli('unknown command', ['project', 'apply', '--project', edited, '--commands', invalidCommands,
    '--output', join(fixture, 'should-not-exist.json')], 3);
  const manifest = join(fixture, 'assets.json');
  await writeFile(manifest, JSON.stringify({version: 1, assets: {take1: source}}));
  const fifo = join(fixture, 'blocked.fifo');
  run('make owned FIFO', 'mkfifo', [fifo]);
  const fifoCli = (name, args) => {
    const r = spawnSync(bin, args, { cwd: consumer, encoding: 'utf8', timeout: 3000 });
    log.push({ name, exit: r.status, signal: r.signal, stderr: r.stderr?.trim(), stdout: r.stdout?.trim() });
    assert.equal(r.error, undefined, `${name}: blocked before regular-file refusal`);
    assert.equal(r.status, 3, name);
    assert.equal(JSON.parse(r.stdout).error.code, 'INVALID_INPUT');
  };
  fifoCli('FIFO project', ['project', 'validate', '--project', fifo]);
  fifoCli('FIFO commands', ['project', 'apply', '--project', imported, '--commands', fifo, '--output', join(fixture, 'fifo-result.json')]);
  fifoCli('FIFO manifest', ['render', '--project', edited, '--manifest', fifo, '--output', join(fixture, 'fifo.mp4'), '--ffmpeg', ffmpeg]);
  const fifoManifest = join(fixture, 'fifo-assets.json');
  await writeFile(fifoManifest, JSON.stringify({version:1, assets:{take1:fifo}}));
  fifoCli('FIFO asset', ['render', '--project', edited, '--manifest', fifoManifest, '--output', join(fixture, 'fifo.mp4'), '--ffmpeg', ffmpeg]);
  const invalidManifest = join(fixture, 'invalid-assets.json');
  await writeFile(invalidManifest, JSON.stringify({version: 1, assets: {take1: './relative.mp4'}}));
  cli('invalid manifest relative', ['render', '--project', edited, '--manifest', invalidManifest,
    '--output', join(fixture, 'invalid.mp4'), '--ffmpeg', ffmpeg], 3);
  await writeFile(invalidManifest, JSON.stringify({version: 1, assets: {other: source}}));
  cli('invalid manifest ID', ['render', '--project', edited, '--manifest', invalidManifest,
    '--output', join(fixture, 'invalid.mp4'), '--ffmpeg', ffmpeg], 3);
  const ready = join(fixture, 'ready.mp4');
  const rendered = cli('render installed CLI', ['render', '--project', edited, '--manifest', manifest,
    '--output', ready, '--ffmpeg', ffmpeg]);
  assert(rendered.output.bytes > 0 && rendered.stageRetained);
  assert.equal(rendered.assets[0].sha256, sourceSha256);
  assert.equal(rendered.output.sha256, sha(await readFile(ready)));
  cli('render existing output', ['render', '--project', edited, '--manifest', manifest,
    '--output', ready, '--ffmpeg', ffmpeg], 5);
  const outputMedia = JSON.parse(run('probe rendered', ffprobe, ['-v', 'error', '-count_frames', '-show_entries',
    'stream=codec_name,codec_type,nb_read_frames,width,height:format=duration', '-of', 'json', ready]).stdout);
  const video = outputMedia.streams.find(s => s.codec_type === 'video');
  const audio = outputMedia.streams.find(s => s.codec_type === 'audio');
  assert.equal(video.codec_name, 'h264'); assert.equal(video.nb_read_frames, '60');
  assert.equal(video.width, 960); assert.equal(video.height, 540);
  assert.equal(audio.codec_name, 'aac');
  run('strict decode all streams', ffmpeg, ['-v', 'error', '-xerror', '-i', ready, '-map', '0:v', '-map', '0:a',
    '-f', 'null', '-']);
  // Test-owned preload instruments real Node fs/link and child spawn. It never substitutes
  // the renderer, decoder or encoder; all target mutations stay inside this fixture.
  const preload = join(fixture, 'fault-preload.mjs');
  await writeFile(preload, `import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const mode = process.env.EDITDOCK_FAULT_MODE, target = process.env.EDITDOCK_FAULT_TARGET;
const link = fs.promises.link, open = fs.promises.open, spawn = cp.spawn;
fs.promises.link = async (src, dest) => {
  if (dest !== target) return link(src, dest);
  if (mode === 'conflict') await fs.promises.writeFile(dest, 'FOREIGN');
  await link(src, dest);
  process.stderr.write('[fault] LINK_COMMITTED ' + mode + '\\n');
  if (mode === 'replaced' || mode === 'missing') await fs.promises.unlink(dest);
  if (mode === 'replaced') await fs.promises.writeFile(dest, 'FOREIGN');
};
fs.promises.open = async (path, ...rest) => {
  if (path === target && mode === 'held') throw Object.assign(new Error('held readback'), {code:'EIO'});
  return open(path, ...rest);
};
cp.spawn = (...args) => {
  const child = spawn(...args);
  if (mode === 'native' && args[0] === process.env.EDITDOCK_ENCODER)
    child.once('spawn', () => process.stderr.write('[fault] NATIVE_PID ' + child.pid + '\\n'));
  return child;
};
syncBuiltinESMExports();
`);
  const fault = (name, mode, expected, expectedCode) => {
    const target = join(fixture, `fault-${mode}.mp4`);
    const r = spawnSync(bin, ['render', '--project', edited, '--manifest', manifest, '--output', target,
      '--ffmpeg', ffmpeg], {cwd:consumer, encoding:'utf8', timeout:120000,
      env:{...process.env, NODE_OPTIONS:`--import=${preload}`, EDITDOCK_FAULT_MODE:mode, EDITDOCK_FAULT_TARGET:target}});
    log.push({name, mode, exit:r.status, stdout:r.stdout?.trim(), stderr:r.stderr?.trim()});
    assert.equal(r.error, undefined, name);
    assert.equal(r.status, expected, name);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.error.code, expectedCode, name);
    assert(doc.error.stageDirectory && doc.error.outputPath === target || mode === 'conflict' && doc.error.stageDirectory);
    assert(r.stderr.includes(mode === 'conflict' ? 'EEXIST' : 'LINK_COMMITTED'), name);
    return {target, doc};
  };
  const held = fault('post-link held readback', 'held', 7, 'PUBLICATION_UNCERTAIN');
  const replaced = fault('post-link replaced target', 'replaced', 7, 'PUBLICATION_UNCERTAIN');
  const missing = fault('post-link missing target', 'missing', 7, 'PUBLICATION_UNCERTAIN');
  const conflict = fault('raced foreign EEXIST', 'conflict', 5, 'CONFLICT');
  for (const {target, doc} of [held, replaced, missing, conflict]) {
    assert((await stat(doc.error.stageDirectory)).isDirectory());
    assert((await stat(join(doc.error.stageDirectory, 'rendered.mp4'))).isFile());
    if (target === missing.target) assert.equal(await lstat(target).then(() => true, () => false), false);
    else if (target === held.target) assert.equal(sha(await readFile(target)), sha(await readFile(join(doc.error.stageDirectory, 'rendered.mp4'))));
    else assert.equal((await readFile(target)).toString(), 'FOREIGN');
  }
  const cancelledOutput = join(fixture, 'cancelled.mp4');
  const cancellation = await new Promise((done, reject) => {
    const child = spawn(bin, ['render', '--project', edited, '--manifest', manifest, '--output', cancelledOutput,
      '--ffmpeg', ffmpeg], { cwd: consumer, stdio: ['ignore', 'pipe', 'pipe'],
        env:{...process.env, NODE_OPTIONS:`--import=${preload}`, EDITDOCK_FAULT_MODE:'native', EDITDOCK_ENCODER:ffmpeg} });
    let stdout = '', stderr = '', signalled = false, nativePid = null;
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => {
      stderr += b;
      const match = stderr.match(/\[fault\] NATIVE_PID (\d+)/);
      if (!signalled && match) {
        nativePid = Number(match[1]);
        signalled = true; child.kill('SIGINT');
      }
    });
    child.on('error', reject);
    child.on('close', code => done({ exit: code, stdout: stdout.trim(), stderr: stderr.trim(), signalled, nativePid }));
  });
  log.push({ name: 'signal cancellation', ...cancellation });
  assert(cancellation.signalled && cancellation.nativePid, 'signal delivered only after real native spawn');
  assert(cancellation.exit === 6 || cancellation.exit === 7, `unexpected cancellation exit ${cancellation.exit}`);
  const cancelJson = JSON.parse(cancellation.stdout);
  assert.equal(cancelJson.ok, false);
  assert(cancelJson.error.stageDirectory);
  assert((await stat(cancelJson.error.stageDirectory)).isDirectory());
  if (cancellation.exit === 6) assert.equal(cancelJson.error.code, 'CANCELLED');
  else assert(['RENDER_LIFECYCLE_UNCERTAIN','RENDER_PUBLICATION_COMMITTED'].includes(cancelJson.error.code));
  let ownedGroupAlive = true;
  for (let i = 0; i < 40; i++) {
    try { process.kill(-cancellation.nativePid, 0); }
    catch (e) { if (e.code === 'ESRCH') { ownedGroupAlive = false; break; } throw e; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(!ownedGroupAlive || cancellation.exit === 7 && cancelJson.error.code === 'RENDER_LIFECYCLE_UNCERTAIN',
    'owned group must release or report typed retained uncertainty');
  const cancelOutputExists = await lstat(cancelledOutput).then(() => true, () => false);
  if (cancelOutputExists) assert.equal(cancelJson.error.code, 'RENDER_PUBLICATION_COMMITTED');
  assert.equal(sha(await readFile(source)), sourceSha256);
  assert.equal(sha(await readFile(blank)), blankHash);
  assert.equal(sha(await readFile(ready)), rendered.output.sha256);
  const summary = { schemaVersion: 1, status: 'PASS', archive, archiveSha256: sha(await readFile(archive)),
    installedBin: bin, installedBinSymlink: binInfo.isSymbolicLink(), sourceSha256,
    outputs: { applied: applied.applied, revision: applied.revision, videoFrames: Number(video.nb_read_frames),
      videoCodec: video.codec_name, audioCodec: audio.codec_name, decoded: true,
      renderSha256: rendered.output.sha256, renderBytes: rendered.output.bytes,
      stageDirectory: rendered.stageDirectory, cancellation: { exit: cancellation.exit, code: cancelJson.error.code,
        stageDirectory: cancelJson.error.stageDirectory, finalExists: cancelOutputExists,
        nativePid: cancellation.nativePid, ownedGroupAlive } },
    negativeCases: log.filter(x => x.exit && x.name !== 'signal cancellation').map(x => ({name:x.name,exit:x.exit})),
    testActions: log.length };
  await writeFile(join(evidence, 'INSTALLED-CLI-TRACE.json'), JSON.stringify(log, null, 2) + '\n');
  await writeFile(join(evidence, 'INSTALLED-CLI-PROOF.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary));
}
try { await main(); }
catch (error) {
  await mkdir(evidence, {recursive:true});
  await writeFile(join(evidence, 'INSTALLED-CLI-TRACE.json'), JSON.stringify(log, null, 2) + '\n');
  throw error;
}
