import { spawn } from 'node:child_process';
import { renameSync } from 'node:fs';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { clipKind, duration, FPS, getEffect, projectTracks, textLaneRank, textStyle, titleNeedsCaptionClearance, validate, type Asset, type Project } from './core.ts';
export { registerEffect, getEffect, validate } from './core.ts';
export type { Project, Asset, Clip } from './core.ts';

/** Hosts must preserve this private stage and withhold unsafe retry. */
export class RenderLifecycleError extends Error {
  readonly code = 'RENDER_LIFECYCLE_UNCERTAIN';
  readonly stageDirectory: string;
  readonly recoveryOutputPath: string | undefined;
  readonly lifecycle: {
    version: 1; coverage: 'posix-process-group-only'; rootTerminal: boolean;
    childClosed: boolean; ownedGroupEmpty: boolean; cleanupVerified: boolean;
    escapedDescendantsProvenAbsent: false;
  };
  constructor(stageDirectory: string, lifecycle: RenderLifecycleError['lifecycle'], cause: unknown, recoveryOutputPath?: string) {
    super('Render lifecycle uncertain; retain private stage and withhold retry', { cause });
    this.name = 'RenderLifecycleError';
    this.stageDirectory = stageDirectory;
    this.recoveryOutputPath = recoveryOutputPath;
    this.lifecycle = Object.freeze(lifecycle);
  }
}

/** Publication cannot be retracted after the native rename commits. Hosts must
 * preserve this output, not treat it as an ordinary unpublished/failed attempt. */
export class RenderPublicationCommittedError extends Error {
  readonly code = 'RENDER_PUBLICATION_COMMITTED';
  readonly publication = 'committed';
  readonly outputPath: string;
  readonly lateReason: 'abort' | 'timeout';
  constructor(outputPath: string, lateReason: 'abort' | 'timeout', cause: unknown) {
    super('Render publication committed before late cancellation/deadline observation; output retained', { cause });
    this.name = 'RenderPublicationCommittedError';
    this.outputPath = outputPath;
    this.lateReason = lateReason;
  }
}

/** No historical-PGID signals. Stop only the still-owned direct child; a
 * surviving group fails closed. Arbitrary setsid escapes are NOT contained. */
async function runNative(executable: string, args: string[], signal: AbortSignal | undefined,
  remainingMs: number, stage: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Render cancelled', 'AbortError')); return; }
    const child = spawn(executable, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let spawned = false, terminal = false, closed = false, settled = false;
    let stderr = '', failure: unknown, observationFailed = false;
    let drainDeadline: number | undefined;
    const groupEmpty = () => {
      if (!spawned || !child.pid) return true;
      try { process.kill(-child.pid, 0); return false; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') return true;
        if (code === 'EPERM') return false;
        observationFailed = true; return false;
      }
    };
    const finish = (uncertain: boolean, empty: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout); clearInterval(poll);
      signal?.removeEventListener('abort', onAbort);
      if (uncertain) {
        child.stderr.destroy(); // Release our pipe, not a surviving process.
        reject(new RenderLifecycleError(stage, { version: 1, coverage: 'posix-process-group-only',
          rootTerminal: terminal, childClosed: closed, ownedGroupEmpty: empty,
          cleanupVerified: false, escapedDescendantsProvenAbsent: false }, failure));
      } else if (failure) reject(failure);
      else resolve();
    };
    const inspect = () => {
      if (settled) return;
      const empty = groupEmpty();
      if (terminal && closed && empty && !observationFailed) { finish(false, true); return; }
      if (drainDeadline !== undefined && performance.now() >= drainDeadline) finish(true, empty);
    };
    const stop = (reason: Error) => {
      if (settled || failure) return;
      failure = reason;
      drainDeadline = performance.now() + 1000;
      if (!terminal) {
        try { if (!child.kill('SIGKILL')) observationFailed = true; }
        catch { observationFailed = true; }
      }
      inspect();
    };
    const onAbort = () => stop(new DOMException('Render cancelled', 'AbortError'));
    const timeout = setTimeout(() => stop(new Error('Render timed out')), Math.max(1, remainingMs));
    const poll = setInterval(inspect, 20);
    child.once('spawn', () => { spawned = true; if (signal?.aborted) onAbort(); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-6000); });
    child.on('error', cause => { failure ??= cause; if (!spawned) terminal = true; drainDeadline ??= performance.now() + 1000; });
    child.once('exit', code => {
      terminal = true;
      if (code !== 0) failure ??= new Error(stderr || `FFmpeg failed ${code}`);
      drainDeadline ??= performance.now() + 1000;
      inspect();
    });
    child.once('close', () => { closed = true; if (!spawned) terminal = true; inspect(); });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** Node-only renderer. A host, never the browser project, chooses every local path.
 * Final publication has a synchronous guarded commit decision: abort/deadline
 * observed before it denies publication. There is no JS scheduling gap between
 * the guard and native rename. A blocking syscall cannot be interrupted by an
 * AbortSignal or made conditional on a clock; a denial observed after its
 * irrevocable commit throws RENDER_PUBLICATION_COMMITTED and retains output.
 * Abort delivered after completion does not retract an already committed file. */
export async function renderMP4(options: {
  project: Project;
  resolveAsset(asset: Asset): Promise<string> | string;
  outputPath: string;
  workDirectory: string;
  ffmpeg?: string;
  timeoutMs?: number;
  maxFrames?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const { project, resolveAsset, outputPath, workDirectory } = options;
  const { signal } = options;
  const cancelled = () => new DOMException('Render cancelled', 'AbortError');
  if (signal?.aborted) throw cancelled();
  if (process.platform === 'win32') throw new Error('Renderer lifecycle requires POSIX process groups');
  const timeoutMs = options.timeoutMs ?? 120000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error('Invalid render timeout');
  const deadline = performance.now() + timeoutMs;
  const check = () => {
    if (signal?.aborted) throw cancelled();
    if (performance.now() >= deadline) throw new Error('Render timed out');
  };
  validate(project);
  const length = duration(project);
  if (!length || !project.clips.some(c => project.version === 3 ? clipKind(project,c) === 'video' : c.trackId.startsWith('V'))) throw new Error('Export needs video');
  if (length > (options.maxFrames ?? 54000)) throw new Error('Export exceeds host duration limit');
  const seconds = (frames: number) => (frames / FPS).toFixed(6);
  const tracks = projectTracks(project);
  const clips = project.clips.filter(c => c.assetId).sort((a, b) =>
    project.version === 3 ? tracks.findIndex(t=>t.id===a.trackId)-tracks.findIndex(t=>t.id===b.trackId) || a.start-b.start
      : a.trackId.localeCompare(b.trackId) || a.start - b.start);
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  const filters = [`color=c=0x111827:s=960x540:r=30:d=${seconds(length)}[v0]`];
  let vid = 'v0', count = 0;
  let stage: string | undefined;
  try {
    for (const clip of clips) {
      const asset = project.assets.find(a => a.id === clip.assetId)!;
      // Asset resolution is host-owned; abort need not wait for a stalled resolver.
      const path = await new Promise<string>((resolve, reject) => {
        if (signal?.aborted) { reject(cancelled()); return; }
        let settled = false;
        const finish = (completion: () => void) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          clearTimeout(timer);
          completion();
        };
        const onAbort = () => finish(() => reject(cancelled()));
        const timer = setTimeout(() => finish(() => reject(new Error('Render timed out'))), Math.max(1, deadline - performance.now()));
        signal?.addEventListener('abort', onAbort, { once: true });
        Promise.resolve().then(() => {
          check();
          return resolveAsset(asset);
        }).then(
          value => finish(() => resolve(value)),
          error => finish(() => reject(error))
        );
      });
      check();
      args.push('-i', path);
    }
    check();
    stage = await mkdtemp(join(workDirectory, '.editdock-render-'));
    check();
    const visual = project.version === 3
      ? project.clips.filter(c => clipKind(project,c) !== 'audio').sort((a,b) =>
          tracks.findIndex(t=>t.id===a.trackId)-tracks.findIndex(t=>t.id===b.trackId) || a.start-b.start)
      : [...clips.filter(c => c.trackId.startsWith('V')),
          ...project.clips.filter(c => c.trackId.startsWith('T')).sort((a,b) =>
            Number(a.role === 'caption')-Number(b.role === 'caption') || a.trackId.localeCompare(b.trackId) || a.start-b.start)];
    for (const clip of visual) {
      check();
      if (project.version === 3 ? clipKind(project,clip) === 'video' : clip.trackId.startsWith('V')) {
        const i = clips.indexOf(clip), layer = `layer${i}`, next = `v${++count}`;
        const effect = clip.effect ? ',' + getEffect(clip.effect)!.exportFilter : '';
        filters.push(`[${i}:v]trim=start=${seconds(clip.inFrame)}:duration=${seconds(clip.duration)},setpts=PTS-STARTPTS+${seconds(clip.start)}/TB,scale=960:540:force_original_aspect_ratio=increase,crop=960:540,setsar=1${effect}[${layer}]`);
        filters.push(`[${vid}][${layer}]overlay=0:0:eof_action=pass:repeatlast=0[${next}]`);
        vid = next;
      } else {
        const titleFile = join(stage, `${randomUUID()}-title.txt`);
        await writeFile(titleFile, clip.text!, 'utf8');
        check();
        const next = `v${++count}`;
        const titleIndex = project.version === 3
          ? textLaneRank(project, clip.trackId)
          : tracks.findIndex(t => t.id === clip.trackId) - tracks.filter(t => t.kind === 'video').length;
        const look = textStyle(clip);
        const style = clip.role === 'caption'
          ? `fontsize=${look.pixels}:boxcolor=black@0.82:boxborderw=12:y=h-78`
          : `fontsize=${look.pixels}:boxcolor=black@0.6:boxborderw=16:y=h-${115 + titleIndex * 108 + (titleIndex === 0 && titleNeedsCaptionClearance(project, clip) ? 85 : 0)}`;
        filters.push(`[${vid}]drawtext=textfile='${titleFile}':expansion=none:fontcolor=${look.color.ffmpeg}:box=1:${style}:x=(w-text_w)/2:enable='between(t,${seconds(clip.start)},${seconds(clip.start + clip.duration - 1)})'[${next}]`);
        vid = next;
      }
    }
    // Browser media.volume and FFmpeg volume both apply linear gain [0,1] per
    // active video before summing with music. V1 fields stay opaque and muted.
    const audio = clips.filter(c => (project.version === 3 ? clipKind(project,c) === 'audio' : c.trackId.startsWith('A')) ||
      (project.version !== 1 && (project.version === 3 ? clipKind(project,c) === 'video' : c.trackId.startsWith('V')) &&
       project.assets.find(a => a.id === c.assetId)?.hasSourceAudio &&
       !c.sourceAudio?.muted && (c.sourceAudio?.gain ?? 1) > 0));
    if (audio.length) {
      audio.forEach((c, n) => filters.push(`[${clips.indexOf(c)}:a]atrim=start=${seconds(c.inFrame)}:duration=${seconds(c.duration)},asetpts=PTS-STARTPTS,volume=${(project.version === 3 ? clipKind(project,c) === 'video' : c.trackId.startsWith('V')) ? c.sourceAudio?.gain ?? 1 : 1},adelay=${Math.round(c.start * 1000 / FPS)}:all=1[a${n}]`));
      filters.push(`${audio.map((_, n) => `[a${n}]`).join('')}amix=inputs=${audio.length}:duration=longest:dropout_transition=0:normalize=0,apad,atrim=duration=${seconds(length)}[aout]`);
    } else filters.push(`anullsrc=r=44100:cl=stereo,atrim=duration=${seconds(length)}[aout]`);
    const stagedOutput = join(stage, 'render.mp4');
    const renderArgs = [...args, '-filter_complex', filters.join(';'), '-map', `[${vid}]`, '-map', '[aout]', '-t', seconds(length), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', stagedOutput];
    check();
    await runNative(options.ffmpeg || 'ffmpeg', renderArgs, signal, deadline - performance.now(), stage);
    check();
    // Release scratch before atomically publishing; FFmpeg never -y overwrites ready output.
    const pendingOutput = join(dirname(outputPath), `.editdock-${randomUUID()}.mp4`);
    await rename(stagedOutput, pendingOutput);
    try { await rm(stage, { recursive: true }); }
    catch (cause) {
      // A cleanup fault is sticky: retain both owned locations rather than
      // retrying deletion and retrospectively declaring a successful release.
      throw new RenderLifecycleError(stage, { version: 1, coverage: 'posix-process-group-only',
        rootTerminal: true, childClosed: true, ownedGroupEmpty: true,
        cleanupVerified: false, escapedDescendantsProvenAbsent: false }, cause, pendingOutput);
    }
    stage = undefined;
    try {
      check();
      // Do not replace this with an awaited rename: that would reopen a window
      // where a denied attempt can overwrite prior ready bytes before resuming.
      renameSync(pendingOutput, outputPath);
    } catch (error) {
      try { await rm(pendingOutput, { force: true }); }
      catch {
        throw new RenderLifecycleError(workDirectory, { version: 1, coverage: 'posix-process-group-only',
          rootTerminal: true, childClosed: true, ownedGroupEmpty: true,
          cleanupVerified: false, escapedDescendantsProvenAbsent: false }, error, pendingOutput);
      }
      throw error;
    }
    try { check(); }
    catch (cause) {
      // Never unlink/roll back an irrevocably committed output. Report this
      // separately from AbortError/timeout so a host cannot claim "unpublished".
      throw new RenderPublicationCommittedError(outputPath, signal?.aborted ? 'abort' : 'timeout', cause);
    }
  } catch (error) {
    if (stage && !(error instanceof RenderLifecycleError)) {
      try { await rm(stage, { recursive: true }); }
      catch {
        throw new RenderLifecycleError(stage, { version: 1, coverage: 'posix-process-group-only',
          rootTerminal: true, childClosed: true, ownedGroupEmpty: true,
          cleanupVerified: false, escapedDescendantsProvenAbsent: false }, error);
      }
    }
    throw error;
  }
}
