export const FPS = 30;
export type TrackKind = 'video' | 'title' | 'audio' | 'general';
export type Track = { id: string; kind: TrackKind; label: string };
export const TRACKS: readonly Track[] = [
  { id: 'V1', kind: 'video', label: 'MAIN VIDEO' },
  { id: 'V2', kind: 'video', label: 'OVERLAY' },
  { id: 'T1', kind: 'title', label: 'TITLES' },
  { id: 'A1', kind: 'audio', label: 'MUSIC' },
];
const TRACK_LIMITS: Record<'video' | 'title' | 'audio', number> = { video: 8, title: 4, audio: 4 };
const TRACK_PREFIX: Record<'video' | 'title' | 'audio', string> = { video: 'V', title: 'T', audio: 'A' };
function makeTrack(kind: 'video' | 'title' | 'audio', number: number): Track {
  const id = `${TRACK_PREFIX[kind]}${number}`;
  return TRACKS.find(t => t.id === id) || { id, kind, label: `${kind.toUpperCase()} ${number}` };
}
export type Kind = 'video' | 'audio';
/** V2 video media: host-admitted stream fact, not inferred from URLs. */
export type Asset = { id: string; name: string; kind: Kind; durationFrames: number; url: string; posterUrl?: string; hasSourceAudio?: boolean };
export type SourceAudio = { muted: boolean; gain: number };
export const DEFAULT_SOURCE_AUDIO: Readonly<SourceAudio> = Object.freeze({ muted: false, gain: 1 });
function validSourceAudio(value: unknown): value is SourceAudio {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 2 &&
    Object.hasOwn(value, 'muted') && Object.hasOwn(value, 'gain') &&
    typeof (value as SourceAudio).muted === 'boolean' && typeof (value as SourceAudio).gain === 'number' &&
    Number.isFinite((value as SourceAudio).gain) && (value as SourceAudio).gain >= 0 && (value as SourceAudio).gain <= 1;
}
/** Fixed text looks only. No project-supplied CSS, font paths or filter fragments. */
export type TextStyle = { palette: 'white' | 'warm'; size: 'small' | 'medium' | 'large' };
export const TEXT_PALETTES = { white: { label: 'White on dark', css: '#ffffff', ffmpeg: '0xFFFFFF' }, warm: { label: 'Warm yellow on dark', css: '#ffe082', ffmpeg: '0xFFE082' } } as const;
export const TEXT_SIZES = { small: { label: 'Small', title: 36, caption: 26 }, medium: { label: 'Medium', title: 48, caption: 32 }, large: { label: 'Large', title: 60, caption: 40 } } as const;
export const DEFAULT_TEXT_STYLE: Readonly<TextStyle> = Object.freeze({ palette: 'white', size: 'medium' });
export function textStyle(clip: Clip) {
  const style = clip.style ?? DEFAULT_TEXT_STYLE;
  return { color: TEXT_PALETTES[style.palette], pixels: TEXT_SIZES[style.size][clip.role === 'caption' ? 'caption' : 'title'] };
}
function validTextStyle(value: unknown): value is TextStyle {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 2 && Object.hasOwn(value, 'palette') && Object.hasOwn(value, 'size') &&
    Object.hasOwn(TEXT_PALETTES, (value as TextStyle).palette) && Object.hasOwn(TEXT_SIZES, (value as TextStyle).size);
}
/** Missing role on a title-lane clip is the legacy title. Captions are burned into video, not a subtitle stream. */
export type Clip = { id: string; trackId: string; assetId?: string; text?: string; role?: 'title' | 'caption'; style?: TextStyle; sourceAudio?: SourceAudio; start: number; inFrame: number; duration: number; effect?: string };
/** V1 stays V1 when read or edited: absent tracks means V1/V2/T1/A1, and only track.add materializes tracks.
 * Unknown JSON fields survive snapshot/command/save as opaque data, not executable editor or renderer options.
 * A future interpretation of existing fields or a required layout change needs a new version and an explicit migration.
 */
export type Project = { version: 1 | 2 | 3; fps: 30; name: string; revision: number; assets: Asset[]; clips: Clip[]; tracks?: Track[] };
export function projectTracks(project: Project): readonly Track[] { return project.tracks === undefined ? TRACKS : project.tracks; }
/** Clip identity is independent of its lane ID and label. */
export function clipKind(project: Project, clip: Clip): Kind | 'title' | 'caption' | undefined {
  if (clip.assetId !== undefined) return project.assets.find(a => a.id === clip.assetId)?.kind;
  if (typeof clip.text === 'string') return clip.role === 'caption' ? 'caption' : 'title';
  return undefined;
}
/** Rank only text-bearing lanes; intervening media lanes never shift text off screen. */
export function textLaneRank(project: Project, trackId: string) {
  return projectTracks(project).filter(t => project.clips.some(c => c.trackId === t.id &&
    (clipKind(project, c) === 'title' || clipKind(project, c) === 'caption'))).findIndex(t => t.id === trackId);
}
export function titleNeedsCaptionClearance(project: Project, title: Clip) {
  return project.clips.some(clip => clip.role === 'caption' &&
    clip.start < title.start + title.duration && title.start < clip.start + clip.duration);
}
export type Command =
  | { type: 'track.add'; kind?: TrackKind }
  | { type: 'project.upgradeTracks' }
  | { type: 'asset.add'; asset: Asset }
  | { type: 'clip.add'; clip: Clip }
  | { type: 'clip.trim'; id: string; edge: 'start' | 'end'; frames: number }
  | { type: 'clip.resize'; id: string; edge: 'start' | 'end'; delta: number }
  | { type: 'clip.split'; id: string; at: number; newId: string }
  | { type: 'clip.move'; id: string; start: number; trackId: string }
  | { type: 'clip.remove'; id: string }
  | { type: 'clip.text'; id: string; text: string }
  | { type: 'clip.style'; id: string; style: TextStyle | null }
  | { type: 'clip.sourceAudio'; id: string; settings: SourceAudio }
  | { type: 'clip.effect'; id: string; effect: string | null };
export type Effect = { id: string; name: string; kind: 'video'; previewCSS: string; exportFilter: string };
const effects = new Map<string, Effect>();
export function registerEffect(effect: Effect) {
  if (!/^[a-z][a-z0-9-]*$/.test(effect.id) || effects.has(effect.id)) throw new Error('Invalid or duplicate effect');
  effects.set(effect.id, Object.freeze({ ...effect }));
}
export function getEffect(id: string) { return effects.get(id); }
export function listEffects() { return [...effects.values()]; }
// Trusted, fixed presets shared by the browser entry and Node-only render entry.
// Mono uses CSS grayscale(1)'s fixed Rec.709 RGB luminance coefficients.
// Other presets remain perceptual counterparts, not proven pixel-identical pipelines.
registerEffect({ id: 'mono', name: 'Monochrome', kind: 'video', previewCSS: 'grayscale(1)', exportFilter: 'colorchannelmixer=rr=.2126:rg=.7152:rb=.0722:gr=.2126:gg=.7152:gb=.0722:br=.2126:bg=.7152:bb=.0722' });
registerEffect({ id: 'vivid', name: 'Vivid', kind: 'video', previewCSS: 'saturate(1.8)', exportFilter: 'eq=saturation=1.8' });
registerEffect({ id: 'contrast', name: 'High contrast', kind: 'video', previewCSS: 'contrast(1.35)', exportFilter: 'lutrgb=r=val*1.35-44.8:g=val*1.35-44.8:b=val*1.35-44.8' });
registerEffect({ id: 'sepia', name: 'Sepia', kind: 'video', previewCSS: 'sepia(1)', exportFilter: 'colorchannelmixer=rr=.393:rg=.769:rb=.189:gr=.349:gg=.686:gb=.168:br=.272:bg=.534:bb=.131' });
export const emptyProject = (): Project => ({ version: 3, fps: FPS, name: 'Untitled edit', revision: 0, assets: [], clips: [], tracks: [{id:'L1',kind:'general',label:'Track 1'}] });
const integer = (v: unknown, min = 0, max = 54000): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const id = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v);
const mediaURL = (v: unknown) => typeof v === 'string' && v.length <= 2048 &&
  ((v.startsWith('/') && !v.startsWith('//') && !/[\\\u0000-\u001f]/.test(v)) ||
   (/^https?:\/\//.test(v) && (() => { try { const u = new URL(v); return !u.username && !u.password; } catch { return false; } })()));
export function validate(project: Project) {
  if (!project || (project.version !== 1 && project.version !== 2 && project.version !== 3)) throw new Error('Unsupported project version');
  if (project.fps !== FPS || !Array.isArray(project.assets) || !Array.isArray(project.clips) || !integer(project.revision, 0, 1000000) || typeof project.name !== 'string' || project.name.length > 120) throw new Error('Unsupported project');
  if (project.assets.length > 100 || project.clips.length > 400) throw new Error('Project limit exceeded');
  if (project.version === 3 && project.tracks === undefined) throw new Error('Invalid tracks');
  const tracks = projectTracks(project);
  if (!Array.isArray(tracks)) throw new Error('Invalid tracks');
  if (project.version === 3) {
    if (tracks.length < 1 || tracks.length > 16 || new Set(tracks.map(t => t?.id)).size !== tracks.length ||
      tracks.some(t => !t || t.kind !== 'general' || !id(t.id) || typeof t.label !== 'string' ||
        !t.label.trim() || t.label.length > 80 || /[\u0000-\u001f\u007f]/.test(t.label))) throw new Error('Invalid tracks');
  } else {
    const counts = { video: 0, title: 0, audio: 0 };
    for (const t of tracks) {
      if (!t || !['video', 'title', 'audio'].includes(t.kind)) throw new Error('Invalid tracks');
      counts[t.kind as keyof typeof counts]++;
    }
    if (counts.video < 2 || counts.title < 1 || counts.audio < 1 ||
        (Object.keys(counts) as (keyof typeof counts)[]).some(kind => counts[kind] > TRACK_LIMITS[kind])) throw new Error('Invalid tracks');
    const expected = (['video', 'title', 'audio'] as (keyof typeof counts)[]).flatMap(kind =>
      Array.from({length:counts[kind]}, (_, index) => makeTrack(kind, index + 1)));
    if (tracks.length !== expected.length || tracks.some((t, i) => t.id !== expected[i].id || t.kind !== expected[i].kind || t.label !== expected[i].label)) throw new Error('Invalid tracks');
  }
  const ids = new Set<string>();
  for (const a of project.assets) {
    if (!a || !id(a.id) || ids.has(a.id) || !['video', 'audio'].includes(a.kind) || typeof a.name !== 'string' || a.name.length > 150 || !integer(a.durationFrames, 1) || !mediaURL(a.url) || (a.posterUrl !== undefined && (a.kind !== 'video' || !mediaURL(a.posterUrl)))) throw new Error('Invalid asset');
    if (project.version !== 1 && (a.kind === 'video' ? typeof a.hasSourceAudio !== 'boolean' : a.hasSourceAudio !== undefined)) throw new Error('Invalid source audio metadata');
    ids.add(a.id);
  }
  ids.clear();
  for (const c of project.clips) {
    const t = tracks.find(t => t.id === c?.trackId);
    if (!c || !id(c.id) || ids.has(c.id) || !t || !integer(c.start) || !integer(c.inFrame) || !integer(c.duration, 1) || c.start + c.duration > 54000 || (c.effect && !getEffect(c.effect))) throw new Error('Invalid clip');
    ids.add(c.id);
    const kind = project.version === 3 ? clipKind(project, c) : t.kind;
    if (kind === 'title' || kind === 'caption') {
      if (typeof c.text !== 'string' || !c.text.trim() || c.text.length > 100 || (project.version === 3 ? c.assetId !== undefined : !!c.assetId) || c.effect || c.inFrame !== 0 || (c.role !== undefined && c.role !== 'title' && c.role !== 'caption') || (c.style !== undefined && !validTextStyle(c.style)) || (project.version !== 1 && c.sourceAudio !== undefined)) throw new Error('Invalid title');
    } else {
      const asset = project.assets.find(a => a.id === c.assetId);
      if (!asset || asset.kind !== kind || (project.version === 3 ? c.text !== undefined : !!c.text) || c.role !== undefined || c.style !== undefined || c.inFrame + c.duration > asset.durationFrames || (kind === 'audio' && c.effect)) throw new Error('Invalid media clip');
      if (project.version !== 1 && c.sourceAudio !== undefined && (kind !== 'video' || !asset.hasSourceAudio || !validSourceAudio(c.sourceAudio))) throw new Error('Invalid source audio');
    }
  }
  for (const t of tracks) {
    const clips = project.clips.filter(c => c.trackId === t.id).sort((a,b) => a.start - b.start);
    for (let i = 1; i < clips.length; i++) if (clips[i-1].start + clips[i-1].duration > clips[i].start) throw new Error('Clips overlap on ' + t.id);
  }
  return project;
}
export function apply(project: Project, command: Command): Project {
  validate(project);
  const next = structuredClone(project);
  const find = (clipId: string) => { const c = next.clips.find(c => c.id === clipId); if (!c) throw new Error('Clip not found'); return c; };
  switch (command.type) {
    case 'track.add': {
      if (next.version === 3) {
        if (command.kind !== undefined && command.kind !== 'general') throw new Error('V3 requires generic tracks; typed track requests are not supported');
        const tracks = next.tracks!;
        if (tracks.length >= 16) throw new Error('Track limit reached');
        let number = 1;
        while (tracks.some(t => t.id === `L${number}`)) number++;
        tracks.push({id:`L${number}`,kind:'general',label:`Track ${number}`});
        break;
      }
      if (command.kind !== 'video' && command.kind !== 'title' && command.kind !== 'audio') throw new Error('Invalid track kind');
      const tracks = [...projectTracks(next)];
      const number = tracks.filter(t => t.kind === command.kind).length + 1;
      if (number > TRACK_LIMITS[command.kind]) throw new Error('Track limit reached');
      const last = tracks.map(t => t.kind).lastIndexOf(command.kind);
      tracks.splice(last + 1, 0, makeTrack(command.kind, number));
      next.tracks = tracks;
      break;
    }
    case 'project.upgradeTracks': {
      if (next.version === 1) throw new Error('V1 must be explicitly migrated to V2 with host-admitted source audio metadata before V3 tracks');
      if (next.version !== 2) throw new Error('Only V2 can upgrade tracks');
      next.tracks = projectTracks(next).map(track => ({...track,kind:'general'}));
      next.version = 3;
      break;
    }
    case 'asset.add': next.assets.push(command.asset); break;
    case 'clip.add': next.clips.push(command.clip); break;
    case 'clip.remove': next.clips = next.clips.filter(c => c.id !== find(command.id).id); break;
    case 'clip.text': {
      const c = find(command.id);
      if (clipKind(next,c) !== 'title' && clipKind(next,c) !== 'caption') throw new Error('Text edit requires title clip');
      c.text = command.text;
      break;
    }
    case 'clip.style': {
      const c = find(command.id);
      if (clipKind(next,c) !== 'title' && clipKind(next,c) !== 'caption') throw new Error('Style edit requires title clip');
      if (command.style !== null && !validTextStyle(command.style)) throw new Error('Invalid title style');
      if (command.style === null) delete c.style;
      else c.style = structuredClone(command.style);
      break;
    }
    case 'clip.sourceAudio': {
      if (next.version === 1) throw new Error('Source audio requires V2; migrate explicitly');
      const c = find(command.id);
      const asset = next.assets.find(a => a.id === c.assetId);
      if (clipKind(next,c) !== 'video' || !asset?.hasSourceAudio || !validSourceAudio(command.settings)) throw new Error('Invalid source audio');
      c.sourceAudio = structuredClone(command.settings);
      break;
    }
    case 'clip.effect': find(command.id).effect = command.effect || undefined; break;
    case 'clip.move': { const c = find(command.id); c.start = command.start; c.trackId = command.trackId; break; }
    case 'clip.trim': {
      const c = find(command.id);
      if (!integer(command.frames, 1) || command.frames >= c.duration) throw new Error('Trim exceeds clip');
      if (command.edge === 'start') { c.start += command.frames; if (!c.text) c.inFrame += command.frames; c.duration -= command.frames; }
      else if (command.edge === 'end') c.duration -= command.frames;
      else throw new Error('Invalid trim edge');
      break;
    }
    case 'clip.resize': {
      const c = find(command.id);
      if (!Number.isSafeInteger(command.delta) || !command.delta || Math.abs(command.delta) > 54000) throw new Error('Invalid resize');
      if (command.edge === 'start') {
        c.start += command.delta;
        c.duration -= command.delta;
        if (!c.text) c.inFrame += command.delta;
      } else if (command.edge === 'end') c.duration += command.delta;
      else throw new Error('Invalid resize edge');
      break;
    }
    case 'clip.split': {
      const c = find(command.id);
      if (!integer(command.at, c.start + 1, c.start + c.duration - 1)) throw new Error('Split outside clip');
      const offset = command.at - c.start;
      next.clips.push({ ...c, id: command.newId, start: command.at, inFrame: c.inFrame + (c.text ? 0 : offset), duration: c.duration - offset });
      c.duration = offset;
      break;
    }
    default: throw new Error('Unknown command');
  }
  next.revision++;
  return validate(next);
}
export class EditorSession {
  project: Project;
  private history: Project[] = [];
  private future: Project[] = [];
  constructor(project: Project = emptyProject()) { this.project = structuredClone(validate(project)); }
  get canUndo() { return this.history.length > 0; }
  get canRedo() { return this.future.length > 0; }
  execute(command: Command) { const next = apply(this.project, command); this.history.push(this.project); this.future = []; this.project = next; return next; }
  undo() { const prev = this.history.pop(); if (prev) { this.future.push(this.project); this.project = prev; } return this.project; }
  redo() { const next = this.future.pop(); if (next) { this.history.push(this.project); this.project = next; } return this.project; }
}
export function duration(project: Project) { return Math.max(0, ...project.clips.map(c => c.start + c.duration)); }
