#!/usr/bin/env node
// Offline, generated-media walkthrough. Run from a trusted machine with installed CLI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
const pairs = process.argv.slice(2);
assert(pairs.length === 8, 'Usage: node scripts/quickstart.mjs --bin /abs/editdock --ffmpeg /abs/ffmpeg --ffprobe /abs/ffprobe --output-dir /abs/fresh-dir');
const options = Object.fromEntries(Array.from({length: 4}, (_, i) => pairs.slice(i * 2, i * 2 + 2)));
assert(Object.keys(options).length === 4 && ['--bin','--ffmpeg','--ffprobe','--output-dir'].every(k => options[k] && isAbsolute(options[k])), 'All four flags require absolute paths');
const bin = options['--bin'], ffmpeg = options['--ffmpeg'], ffprobe = options['--ffprobe'], dir = options['--output-dir'];
function run(program, args, json = false) {
  const r = spawnSync(program, args, {encoding:'utf8', maxBuffer: 8 * 1024 * 1024});
  assert.equal(r.error, undefined, `${program}: ${r.error?.message}`);
  assert.equal(r.status, 0, `${program} ${args[0]}: ${r.stderr || r.stdout}`);
  if (!json) return r.stdout;
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'Expected one JSON line');
  const value = JSON.parse(lines[0]);
  assert.equal(value.schemaVersion, 1); assert.equal(value.ok, true);
  return value;
}
await mkdir(dir, {mode: 0o700}); // fresh directory only; EEXIST is intentional
const source = join(dir, 'generated.mp4'), blank = join(dir, 'blank.json');
const commandsPath = join(dir, 'commands.json'), edited = join(dir, 'edited.json');
const manifest = join(dir, 'manifest.json'), output = join(dir, 'rendered.mp4');
run(bin, ['help'], true); run(bin, ['schema'], true);
const doctor = run(bin, ['doctor', '--ffmpeg', ffmpeg], true);
run(ffmpeg, ['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=30','-frames:v','60','-c:v','libx264','-pix_fmt','yuv420p',source]);
const media = JSON.parse(run(ffprobe, ['-v','error','-show_entries','stream=codec_type,nb_frames,r_frame_rate:format=duration','-of','json',source]));
const video = media.streams.find(x => x.codec_type === 'video');
assert.equal(video?.nb_frames, '60'); assert.equal(video.r_frame_rate, '30/1');
assert.equal(media.streams.some(x => x.codec_type === 'audio'), false);
run(bin, ['project','init','--output',blank], true);
const initial = JSON.parse(await readFile(blank, 'utf8'));
assert(initial.version === 3 && Array.isArray(initial.tracks));
run(bin, ['project','validate','--project',blank], true);
const commands = [
  {type:'asset.add',asset:{id:'take1',name:'generated',kind:'video',durationFrames:Number(video.nb_frames),url:'/host/admitted/take1',hasSourceAudio:false}},
  {type:'clip.add',clip:{id:'video1',trackId:'L1',assetId:'take1',start:0,inFrame:0,duration:60}},
  {type:'clip.trim',id:'video1',edge:'start',frames:4},
  {type:'track.add'},
  {type:'clip.add',clip:{id:'title1',trackId:'L2',text:'Alpha title',role:'title',start:0,inFrame:0,duration:50}},
  {type:'track.add'},
  {type:'clip.add',clip:{id:'caption1',trackId:'L3',text:'Manual caption',role:'caption',start:4,inFrame:0,duration:40}},
];
await writeFile(commandsPath, JSON.stringify(commands, null, 2) + '\n', {flag:'wx'});
const applied = run(bin, ['project','apply','--project',blank,'--commands',commandsPath,'--output',edited], true);
assert.equal(applied.applied, commands.length);
run(bin, ['project','validate','--project',edited], true);
await writeFile(manifest, JSON.stringify({version:1,assets:{take1:source}}, null, 2) + '\n', {flag:'wx'});
const rendered = run(bin, ['render','--project',edited,'--manifest',manifest,'--output',output,'--ffmpeg',ffmpeg], true);
assert(rendered.stageRetained && rendered.output.bytes > 0);
const probe = JSON.parse(run(ffprobe, ['-v','error','-count_frames','-show_entries','stream=codec_name,codec_type,nb_read_frames,width,height','-of','json',output]));
const v = probe.streams.find(s => s.codec_type === 'video'), a = probe.streams.find(s => s.codec_type === 'audio');
assert.equal(v.codec_name, 'h264'); assert.equal(v.nb_read_frames, '60'); assert.equal(v.width, 960); assert.equal(v.height, 540); assert.equal(a.codec_name, 'aac');
run(ffmpeg, ['-v','error','-xerror','-i',output,'-map','0:v','-map','0:a','-f','null','-']);
console.log(JSON.stringify({ok:true, version:doctor.runtime.node, project:edited, output, frames:Number(v.nb_read_frames), decoded:true, stageDirectory:rendered.stageDirectory}));
