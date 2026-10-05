import css from './editor.css?inline';
import { EditorSession, apply, clipKind, projectTracks, textLaneRank, titleNeedsCaptionClearance, FPS, duration, getEffect, listEffects, textStyle, TEXT_PALETTES, TEXT_SIZES, DEFAULT_TEXT_STYLE, DEFAULT_SOURCE_AUDIO, type Asset, type Clip, type Command, type Kind, type Project, type TrackKind, type TextStyle } from './core';
import type { HostStorage } from './storage';
import { validateUI, type EditorUI, type EditorUIContext, type TimelineAction, type AssetAction, type AssetActionContext } from './ui';

const escapeHTML = (value: string) => value.replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]!);
const stamp = () => crypto.randomUUID();
const clock = (frames: number) => `${String(Math.floor(frames / FPS / 60)).padStart(2,'0')}:${String(Math.floor(frames / FPS) % 60).padStart(2,'0')}:${String(frames % FPS).padStart(2,'0')}`;
const DEFAULT_PX = 4;
const MIN_PX = 0.004;
const MAX_PX = 12;
const TRACK_LABEL_WIDTH = 100;
const DEFAULT_LAYOUT = { bin: 258, inspector: 270, timeline: 346 };
export class EditWeave extends HTMLElement {
  storage!: HostStorage;
  /** Optional per-instance layout preference key; set before mounting. */
  layoutStorageKey = 'editweave-layout-v1';
  session = new EditorSession();
  ready: Promise<void> = Promise.resolve();
  private position = 0;
  private selected: string | null = null;
  private selectedLane: string | null = null;
  private targetLane() { const tracks = projectTracks(this.session.project); return tracks.find(t => t.id === this.selectedLane)?.id || tracks[0].id; }
  private revealLane(id: string) {
    const lane = [...this.root.querySelectorAll<HTMLElement>('.track-lane')].find(el => el.dataset.track === id);
    lane?.closest('.track-row')?.scrollIntoView({block:'nearest',inline:'nearest'});
  }
  private titleComposerOpen = false;
  private composerRole: 'title' | 'caption' = 'title';
  private mediaOpen = false;
  private hasUnsavedChanges = false;
  private editRevision = 0;
  private ui: EditorUI = { timelineActions: [], inspectorSections: [] };
  private playing = false;
  private started = 0;
  private frameAtStart = 0;
  private stageKey = '';
  private audio = new Map<string, HTMLAudioElement>();
  private message = 'Ready · import local media to begin';
  private error = false;
  private busy = false;
  private booted = false;
  private layout = { ...DEFAULT_LAYOUT };
  private resizeObserver?: ResizeObserver;
  private timelineObserver?: ResizeObserver;
  private trimming = false;
  private px = DEFAULT_PX;
  private fitTimeline = false;
  private root: ShadowRoot;
  constructor() { super(); this.root = this.attachShadow({ mode: 'open' }); }
  connectedCallback() { if (!this.booted) { this.booted = true; this.ready = this.boot(); } else { this.resizeObserver?.observe(this); this.timelineObserver?.observe(this.root.querySelector('.timeline-scroll')!); } }
  disconnectedCallback() { this.pause(); this.resizeObserver?.disconnect(); this.timelineObserver?.disconnect(); }
  getProject(): Project { return structuredClone(this.session.project); }
  /** Replace this instance's trusted UI contributions; usable before or after mounting. */
  setUI(config: EditorUI) {
    validateUI(config);
    this.ui = { timelineActions: (config.timelineActions || []).map(action => ({ ...action })), menuActions: (config.menuActions || []).map(action => ({ ...action })), assetActions: (config.assetActions || []).map(action => ({ ...action })), inspectorSections: (config.inspectorSections || []).map(section => ({ ...section })) };
    if (this.root.querySelector('#host-actions')) {
      this.renderUIActions();
      this.renderAssets();
      const pane = this.root.querySelector('#inspector');
      pane?.querySelector('.host-sections')?.remove();
      if (pane) this.renderUISections(pane);
    }
  }
  private uiContext(): EditorUIContext {
    const project = this.getProject();
    return { project, selectedClip: project.clips.find(c => c.id === this.selected) || null, frame: this.position, execute: command => this.execute(command) };
  }
  private actionEnabled(action: TimelineAction) {
    try { return action.enabled ? !!action.enabled(this.uiContext()) : true; }
    catch (error) { this.fail(error); return false; }
  }
  private assetContext(id: string): AssetActionContext {
    const context = this.uiContext();
    const asset = context.project.assets.find(item => item.id === id);
    if (!asset) throw new Error('Asset not found');
    return { ...context, asset };
  }
  private assetActionEnabled(action: AssetAction, id: string) {
    try { return action.enabled ? !!action.enabled(this.assetContext(id)) : true; }
    catch (error) { this.fail(error); return false; }
  }
  execute(command: Command) { this.session.execute(command); this.changed(); return this.getProject(); }
  undo() { this.session.undo(); this.changed(); return this.getProject(); }
  redo() { this.session.redo(); this.changed(); return this.getProject(); }
  seek(frame: number) { this.position = Math.max(0, Math.min(duration(this.session.project), Math.round(frame))); this.frameAtStart = this.position; this.started = performance.now(); this.updateStage(); this.updatePlayhead(); }
  private setSaveState(value: 'new' | 'saved' | 'unsaved') {
    this.hasUnsavedChanges = value === 'unsaved';
    const indicator = this.root.querySelector<HTMLElement>('#save-state');
    if (indicator) { indicator.textContent = value === 'unsaved' ? 'UNSAVED ●' : value === 'saved' ? 'SAVED ✓' : 'NEW PROJECT'; indicator.classList.toggle('unsaved', value === 'unsaved'); }
  }
  async save() {
    const snapshot = this.getProject();
    const fingerprint = JSON.stringify(snapshot);
    await this.storage.save(snapshot);
    if (JSON.stringify(this.getProject()) === fingerprint) { this.setSaveState('saved'); this.setStatus('Project saved to host storage'); }
    else { this.setSaveState('unsaved'); this.setStatus('Newer edits remain unsaved'); }
  }
  /** Reload from host storage; explicit opt-in is required to discard local edits. */
  async load(options: { discardUnsaved?: boolean } = {}) {
    if (this.hasUnsavedChanges && !options.discardUnsaved) throw new Error('Unsaved changes · save first or explicitly discard them');
    const revision = this.editRevision;
    const loaded = await this.storage.load();
    if (this.editRevision !== revision) throw new Error('Project changed while loading · newer edits were kept');
    const pending = loaded && typeof loaded === 'object' && 'accept' in loaded && typeof loaded.accept === 'function' && 'project' in loaded ? loaded : null;
    const project = pending ? pending.project : loaded as Project | null;
    const nextSession = new EditorSession(project || undefined); // validate before committing host state
    pending?.accept(); // synchronous, response-specific; never called for rejected loads
    this.pause(); this.session = nextSession;
    this.position = 0; this.stageKey = ''; this.selected = null; this.selectedLane = null; this.titleComposerOpen = false;
    this.editRevision++; this.render(); this.setSaveState(project ? 'saved' : 'new');
    this.setStatus(project ? 'Project loaded from host storage' : 'No saved project yet');
    this.dispatchEvent(new CustomEvent('editweave-change', { detail: this.getProject() }));
  }
  async exportVideo() { if (this.storage.supportsExport === false || !this.storage.export) throw new Error('Export requires a host renderer'); const url = await this.storage.export(this.getProject()); this.setStatus('MP4 ready · open export'); const link = this.root.querySelector<HTMLAnchorElement>('#export-link')!; link.href = url; link.hidden = false; return url; }
  async importFiles(files: File[]) {
    for (const file of files) {
      const kind: Kind = file.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac)$/i.test(file.name) ? 'audio' : 'video';
      const asset = await this.storage.ingest(file, kind);
      this.execute({ type: 'asset.add', asset });
      this.setStatus(`Imported ${file.name} · select it in Media to place it`);
    }
  }
  private async boot() {
    this.root.innerHTML = `<style>${css}</style><div class="shell">
      <header class="top"><div class="brand"><span class="logo">≋</span><strong>Editdock</strong><small>LOCAL EDITOR</small></div><div class="project-name" id="project-name"></div><div class="top-actions"><details class="tools-menu" id="tools-menu" hidden><summary>Tools</summary><div class="tools-menu-list" role="group" aria-label="Host tools"></div></details><button class="button subtle" data-action="reset-layout" title="Reset panel sizes">Reset layout</button><button class="button" data-action="load">Reload</button><button class="button" data-action="save">Save project</button><button class="button primary" data-action="export">Export MP4 ↗</button></div></header>
      <div class="workspace"><aside class="side media-panel"><div class="panel-head"><strong>Media</strong><span>LOCAL FILES</span><button class="media-toggle" data-action="media" aria-expanded="false" aria-controls="media-library">Open media</button></div><div class="library" id="media-library"><label class="dropzone" for="media-input"><b>＋</b><strong>Import media</strong><small>Video or audio · files stay local</small></label><input id="media-input" type="file" accept="video/*,audio/*" multiple hidden><p class="mini-title">Project assets</p><div id="assets"></div><p class="hint">Click an asset to add it to the timeline.</p></div></aside><div class="splitter" data-resize="bin" role="separator" aria-label="Resize media bin" aria-orientation="vertical" tabindex="0"></div>
      <main class="monitor"><div class="monitor-bar"><strong>Player</strong><span>16:9 · 30 FPS</span></div><div class="preview-wrap"><div class="screen" id="screen"><div class="empty-preview">Import media to start an edit</div></div></div><div class="transport"><span class="time current" id="current">00:00:00</span><button aria-label="Back one second" data-action="back">↶</button><button aria-label="Play or pause" id="play" data-action="play">▶</button><button aria-label="Forward one second" data-action="forward">↷</button><span class="time" id="total">00:00:00</span></div></main>
      <div class="splitter" data-resize="inspector" role="separator" aria-label="Resize inspector" aria-orientation="vertical" tabindex="0"></div><aside class="side inspector"><div class="panel-head">Inspector <span>SELECTION</span></div><div class="inspector-body" id="inspector"></div></aside></div>
     <div class="splitter horizontal" data-resize="timeline" role="separator" aria-label="Resize timeline" aria-orientation="horizontal" tabindex="0"></div><section class="timeline"><div class="timeline-head"><strong>Timeline <small id="track-count"></small></strong><span class="trim-feedback" id="trim-feedback" hidden></span><div class="edit-tools" aria-label="Timeline editing"><button data-action="undo" title="Undo last edit">Undo</button><button data-action="redo" title="Redo last edit">Redo</button><span class="timeline-zoom" role="group" aria-label="Timeline zoom"><button data-action="zoom-out" aria-label="Zoom out timeline" title="Zoom out timeline">−</button><button data-action="zoom-fit" aria-label="Fit timeline" title="Fit the whole edit">Fit</button><button data-action="zoom-in" aria-label="Zoom in timeline" title="Zoom in timeline">＋</button></span><span class="tool-divider"></span><button data-action="split" title="Split selected clip at playhead">Split</button><button data-action="remove" title="Remove selected clip">Remove</button><button data-action="show-caption" title="Create a manual caption at the playhead">＋ Caption</button><button class="mobile-title" data-action="show-title" title="Create a title at the playhead">＋ Title</button><div class="host-actions" id="host-actions" aria-label="Host edit actions"></div></div><details class="more-edit"><summary aria-label="More edit actions">More</summary><div role="group" aria-label="Additional timeline actions"><button data-action="split">Split selected clip</button><button data-action="remove">Remove selected clip</button><button data-action="show-caption">Create caption</button><button data-action="show-title">Create title</button><div class="more-host-actions" id="more-host-actions"></div></div></details><button class="upgrade-tracks" data-action="upgrade-tracks" hidden>Enable flexible tracks</button><button class="add-general-track" data-add-track="general" hidden>＋ Track</button><details class="track-menu"><summary aria-label="Add track">＋ Track</summary><div role="group" aria-label="Track types"><button data-add-track="video">Video</button><button data-add-track="title">Title</button><button data-add-track="audio">Audio</button></div></details></div><div class="timeline-scroll"><div class="timeline-inner" id="timeline-inner"><div class="ruler" id="ruler" tabindex="0" role="slider" aria-label="Timeline playhead" aria-valuemin="0" aria-valuenow="0" aria-valuemax="0"></div><div id="tracks"></div><div class="playhead" id="playhead"></div></div></div></section><footer class="status"><span id="status" role="status" aria-live="polite"></span><span class="save-summary"><span id="save-state">NEW PROJECT</span> <a id="export-link" hidden target="_blank" rel="noopener">OPEN MP4 ↗</a></span></footer>
    </div>`;
    if (this.storage?.supportsExport === false || !this.storage?.export) {
      const button = this.root.querySelector<HTMLButtonElement>('[data-action="export"]')!;
      button.disabled = true;
      button.textContent = 'Export needs renderer';
      button.title = 'This host must provide an MP4 render service';
    }
    this.restoreLayout();
    this.installSplitters();
    this.resizeObserver = new ResizeObserver(() => this.applyLayout());
    this.resizeObserver.observe(this);
    this.timelineObserver = new ResizeObserver(() => { if (this.fitTimeline && !this.trimming) { this.renderTimeline(); this.updatePlayhead(); } });
    this.timelineObserver.observe(this.root.querySelector('.timeline-scroll')!);
    this.root.addEventListener('click', e => this.handleClick(e));
    this.root.querySelector<HTMLElement>('#ruler')!.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      this.seek(this.position + (event.key === 'ArrowRight' ? 1 : -1));
    });
    this.root.addEventListener('change', e => this.change(e));
    this.root.addEventListener('dragstart', e => { const target = (e.target as HTMLElement).closest<HTMLElement>('[data-clip]'); if (target && e instanceof DragEvent) { e.dataTransfer?.setData('text/plain', target.dataset.clip!); e.dataTransfer?.setData('application/x-editweave-offset', String(Math.round((e.clientX-target.getBoundingClientRect().left)/this.px))); } });
    this.root.addEventListener('dragover', e => { if ((e.target as HTMLElement).closest('.track-lane')) e.preventDefault(); });
    this.root.addEventListener('drop', e => this.drop(e as DragEvent));
    this.root.addEventListener('pointerdown', e => this.resizeClip(e as PointerEvent));
    try { if (!this.storage) throw new Error('Host must set storage before mounting'); await this.load(); } catch (e) { this.fail(e); throw e; }
  }
  private restoreLayout() {
    try {
      const value = JSON.parse(localStorage.getItem(this.layoutStorageKey) || 'null');
      if (value && typeof value === 'object') for (const key of ['bin', 'inspector', 'timeline'] as const) {
        if (Number.isFinite(value[key])) this.layout[key] = value[key];
      }
    } catch { /* Layout is optional; project storage remains host-owned. */ }
    this.applyLayout();
  }
  private applyLayout(persist = false) {
    const workspace = this.root.querySelector<HTMLElement>('.workspace');
    const shell = this.root.querySelector<HTMLElement>('.shell');
    if (!workspace || !shell) return;
    const width = workspace.clientWidth;
    const height = shell.clientHeight;
    this.layout.bin = Math.max(190, Math.min(this.layout.bin, 420, width - this.layout.inspector - 332));
    this.layout.inspector = Math.max(220, Math.min(this.layout.inspector, 480, width - this.layout.bin - 332));
    this.layout.timeline = Math.max(220, Math.min(this.layout.timeline, 460, height - 450));
    workspace.style.setProperty('--ew-bin', `${this.layout.bin}px`);
    workspace.style.setProperty('--ew-inspector', `${this.layout.inspector}px`);
    shell.style.setProperty('--ew-timeline', `${this.layout.timeline}px`);
    for (const handle of this.root.querySelectorAll<HTMLElement>('[data-resize]')) {
      handle.setAttribute('aria-valuenow', String(Math.round(this.layout[handle.dataset.resize as keyof typeof DEFAULT_LAYOUT])));
    }
    if (persist) try { localStorage.setItem(this.layoutStorageKey, JSON.stringify(this.layout)); } catch { /* UI preference only. */ }
  }
  private installSplitters() {
    for (const handle of this.root.querySelectorAll<HTMLElement>('[data-resize]')) {
      const axis = handle.dataset.resize as keyof typeof DEFAULT_LAYOUT;
      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        const original = { ...this.layout };
        const start = axis === 'timeline' ? event.clientY : event.clientX;
        const direction = axis === 'bin' ? 1 : -1;
        handle.setPointerCapture(event.pointerId);
        const move = (e: PointerEvent) => {
          this.layout[axis] = original[axis] + direction * ((axis === 'timeline' ? e.clientY : e.clientX) - start);
          this.applyLayout();
        };
        const finish = (e: PointerEvent) => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', finish);
          handle.removeEventListener('pointercancel', finish);
          if (e.type === 'pointercancel') this.layout = original;
          this.applyLayout(e.type === 'pointerup');
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', finish);
        handle.addEventListener('pointercancel', finish);
      });
      handle.addEventListener('keydown', event => {
        const delta = axis === 'timeline' ? (event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0)
          : event.key === 'ArrowRight' ? (axis === 'bin' ? 1 : -1) : event.key === 'ArrowLeft' ? (axis === 'bin' ? -1 : 1) : 0;
        if (!delta) return;
        event.preventDefault();
        this.layout[axis] += delta * 16;
        this.applyLayout(true);
      });
    }
  }
  private setStatus(text: string, error = false) { this.message = text; this.error = error; const status = this.root.querySelector<HTMLElement>('#status'); if (status) { status.textContent = text; status.classList.toggle('error', error); } }
  private fail(e: unknown) { this.setStatus(e instanceof Error ? e.message : String(e), true); }
  private changed() { this.editRevision++; this.position = Math.min(this.position, duration(this.session.project)); if (this.selected && !this.session.project.clips.some(c => c.id === this.selected)) this.selected = null; this.render(); this.setSaveState('unsaved'); this.setStatus('Unsaved changes · save to keep this edit'); this.dispatchEvent(new CustomEvent('editweave-change', { detail: this.getProject() })); }
  private render() { this.root.querySelector('#project-name')!.textContent = `${this.session.project.name}  /  ${FPS} FPS`; this.renderAssets(); this.renderTimeline(); this.renderInspector(); this.updateStage(); this.updatePlayhead(); }
  private renderAssets() {
    const toggle = this.root.querySelector<HTMLButtonElement>('.media-toggle');
    if (toggle) toggle.textContent = `${this.mediaOpen ? 'Close' : 'Open'} media · ${this.session.project.assets.length}`;
    this.root.querySelector('#assets')!.innerHTML = this.session.project.assets.map(a => `<div class="asset-item" data-asset="${a.id}"><button class="asset ${a.kind}" data-add="${a.id}" title="Add to timeline" aria-label="Add ${escapeHTML(a.name)} to timeline"><span class="asset-poster">${a.posterUrl ? `<img src="${escapeHTML(a.posterUrl)}" alt="" draggable="false">` : a.kind === 'audio' ? '♫' : '▣'}</span><span class="detail"><strong>${escapeHTML(a.name)}</strong><small>${a.kind.toUpperCase()} · ${clock(a.durationFrames)}</small></span><span class="plus" aria-hidden="true">＋</span></button><div class="asset-actions" role="group" aria-label="More ways to use ${escapeHTML(a.name)}"></div></div>`).join('') || '<p class="hint">No media yet. Import a video or audio file to start.</p>';
    for (const card of this.root.querySelectorAll<HTMLElement>('.asset-item')) {
      const id = card.dataset.asset!;
      const slot = card.querySelector<HTMLElement>('.asset-actions')!;
      for (const action of this.ui.assetActions || []) {
        const button = document.createElement('button');
        button.type = 'button'; button.dataset.assetAction = action.id; button.dataset.assetId = id;
        button.textContent = action.label; button.title = action.title || action.label;
        button.disabled = !this.assetActionEnabled(action, id);
        slot.append(button);
      }
    }
  }
  private renderTimeline() {
    const p = this.session.project;
    const viewport = this.root.querySelector<HTMLElement>('.timeline-scroll')!;
    // A short empty edit retains a working area; a long fit uses only a one-second tail.
    const frames = Math.max(300, duration(p) + FPS);
    if (this.fitTimeline && viewport.clientWidth > TRACK_LABEL_WIDTH) {
      this.px = Math.max(MIN_PX, Math.min(MAX_PX, (viewport.clientWidth - TRACK_LABEL_WIDTH - 40) / frames));
    }
    this.root.querySelector('#track-count')!.textContent = projectTracks(p).length > 4 ? `· ${projectTracks(p).length} tracks · scroll lanes` : '';
    const inner = this.root.querySelector<HTMLElement>('#timeline-inner')!; inner.style.width = `${TRACK_LABEL_WIDTH + frames * this.px}px`;
    const seconds = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 86400];
    const step = seconds.find(s => s * FPS * this.px >= 76) ?? seconds.at(-1)!;
    inner.style.setProperty('--ew-tick-width', `${step * FPS * this.px}px`);
    this.root.querySelector('#ruler')!.innerHTML = Array.from({length: Math.floor(frames / (step * FPS)) + 1}, (_, i) => {
      const n = i * step;
      return `<span class="tick" style="left:${n * FPS * this.px}px">${String(Math.floor(n / 60)).padStart(2,'0')}:${String(n % 60).padStart(2,'0')}</span>`;
    }).join('');
    const displayTracks = p.version === 3 ? [...projectTracks(p)].reverse() : projectTracks(p);
    this.root.querySelector('#tracks')!.innerHTML = displayTracks.map(t => `<div class="track-row ${this.targetLane() === t.id ? 'target-lane' : ''}"><button type="button" class="track-label ${t.kind}" data-select-track="${t.id}" aria-pressed="${this.targetLane() === t.id}" title="Select ${escapeHTML(t.label)} as insertion track"><i class="dot"></i><span>${escapeHTML(t.label)}</span></button><div class="track-lane" data-track="${t.id}" aria-label="${escapeHTML(t.label)} lane" style="width:${frames * this.px}px">${p.clips.filter(c => c.trackId === t.id).map(c => { const asset = p.assets.find(a => a.id === c.assetId); const kind = clipKind(p,c)!; return `<button draggable="true" class="clip ${kind} ${this.selected === c.id ? 'selected' : ''}" data-clip="${c.id}" style="left:${c.start*this.px}px;width:${c.duration*this.px}px" title="${kind.toUpperCase()} · ${escapeHTML(asset?.name || c.text || '')}${kind === 'title' || kind === 'caption' ? '' : ` · source ${clock(c.inFrame)} → ${clock(c.inFrame+c.duration)}`}">${asset?.posterUrl && c.inFrame === 0 ? `<img class="clip-poster" src="${escapeHTML(asset.posterUrl)}" alt="" draggable="false">` : ''}<span class="resize-edge start" data-edge="start" aria-hidden="true"></span><span class="clip-caption"><b class="kind-badge">${kind === 'caption' ? 'CC' : kind}</b> ${escapeHTML(asset?.name || c.text || '')}<small>${clock(c.duration)}</small></span><span class="resize-edge end" data-edge="end" aria-hidden="true"></span></button>`; }).join('')}</div></div>`).join('');
    const fit = this.root.querySelector<HTMLButtonElement>('[data-action="zoom-fit"]')!;
    fit.setAttribute('aria-pressed', String(this.fitTimeline));
    this.root.querySelector<HTMLButtonElement>('[data-action="zoom-out"]')!.disabled = !this.fitTimeline && this.px <= MIN_PX;
    this.root.querySelector<HTMLButtonElement>('[data-action="zoom-in"]')!.disabled = !this.fitTimeline && this.px >= MAX_PX;
    this.root.querySelector<HTMLElement>('.track-menu')!.hidden = p.version === 3;
    const general = this.root.querySelector<HTMLButtonElement>('.add-general-track')!;
    general.hidden = p.version !== 3; general.disabled = projectTracks(p).length >= 16;
    const upgrade = this.root.querySelector<HTMLButtonElement>('.upgrade-tracks')!;
    upgrade.hidden = p.version === 3;
    upgrade.textContent = p.version === 1 ? 'Flexible tracks need V2' : 'Enable flexible tracks';
    upgrade.title = p.version === 1 ? 'Migrate to V2 using host-admitted source-audio metadata first' : 'Convert to generic tracks (undoable)';
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('.track-menu [data-add-track]')) button.disabled = projectTracks(p).filter(t => t.kind === button.dataset.addTrack).length >= (button.dataset.addTrack === 'video' ? 8 : 4);
    const selected = p.clips.find(c => c.id === this.selected);
    for (const [action, disabled] of [['undo', !this.session.canUndo], ['redo', !this.session.canRedo], ['split', !selected || this.position <= selected.start || this.position >= selected.start + selected.duration], ['remove', !selected]] as const) {
      for (const control of this.root.querySelectorAll<HTMLButtonElement>(`.edit-tools [data-action="${action}"], .more-edit [data-action="${action}"]`)) control.disabled = disabled;
    }
    this.renderUIActions();
  }
  private renderUIActions() {
    const menu = this.root.querySelector<HTMLDetailsElement>('#tools-menu');
    if (menu) {
      const actions = this.ui.menuActions || [];
      menu.hidden = !actions.length;
      if (!actions.length) menu.open = false;
      const list = menu.querySelector<HTMLElement>('.tools-menu-list')!;
      list.replaceChildren();
      for (const action of actions) {
        const button = document.createElement('button');
        button.type = 'button'; button.dataset.menuAction = action.id;
        button.textContent = action.label; button.title = action.title || action.label;
        button.disabled = !this.actionEnabled(action);
        list.append(button);
      }
    }
    const host = this.root.querySelector<HTMLElement>('#host-actions');
    if (!host) return;
    host.replaceChildren();
    const moreHost = this.root.querySelector<HTMLElement>('#more-host-actions')!;
    moreHost.replaceChildren();
    if (!this.ui.timelineActions?.length) return;
    const divider = document.createElement('span'); divider.className = 'tool-divider'; divider.setAttribute('aria-hidden', 'true'); host.append(divider);
    for (const action of this.ui.timelineActions) {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.uiAction = action.id; button.textContent = action.label;
      button.title = action.title || action.label;
      button.disabled = !this.actionEnabled(action);
      host.append(button);
      const compact = button.cloneNode(true) as HTMLButtonElement;
      moreHost.append(compact);
    }
  }
  private updateUIActions() {
    for (const action of this.ui.menuActions || []) {
      const button = [...this.root.querySelectorAll<HTMLButtonElement>('[data-menu-action]')].find(b => b.dataset.menuAction === action.id);
      if (button) button.disabled = !this.actionEnabled(action);
    }
    for (const action of this.ui.timelineActions || []) {
      for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-ui-action]')) if (button.dataset.uiAction === action.id) button.disabled = !this.actionEnabled(action);
    }
    if (this.ui.assetActions?.length) for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-asset-action]')) {
      const action = this.ui.assetActions.find(item => item.id === button.dataset.assetAction);
      if (action && button.dataset.assetId) button.disabled = !this.assetActionEnabled(action, button.dataset.assetId);
    }
  }
  private renderUISections(pane: Element) {
    const host = document.createElement('div'); host.className = 'host-sections';
    for (const section of this.ui.inspectorSections || []) {
      try {
        const context = this.uiContext();
        if (section.when && !section.when(context)) continue;
        const rows = section.rows(context);
        if (!Array.isArray(rows) || !rows.length) continue;
        const element = document.createElement('section'); element.className = 'host-section'; element.dataset.uiSection = section.id;
        const heading = document.createElement('h3'); heading.textContent = section.title; element.append(heading);
        for (const row of rows) {
          const line = document.createElement('div'); line.className = 'host-row';
          const label = document.createElement('span'); label.textContent = row.label;
          const value = document.createElement('strong'); value.textContent = row.value;
          line.append(label, value); element.append(line);
        }
        host.append(element);
      } catch (error) { this.fail(error); }
    }
    pane.append(host);
  }
  private styleControls(c: Clip) {
    const style = c.style ?? DEFAULT_TEXT_STYLE;
    return `<div class="inspector-fields text-style-fields"><div class="field"><label for="clip-palette">Text look</label><select id="clip-palette" data-field="palette">${Object.entries(TEXT_PALETTES).map(([key, value]) => `<option value="${key}" ${style.palette === key ? 'selected' : ''}>${value.label}</option>`).join('')}</select></div><div class="field"><label for="clip-size">Text size</label><select id="clip-size" data-field="size">${Object.entries(TEXT_SIZES).map(([key, value]) => `<option value="${key}" ${style.size === key ? 'selected' : ''}>${value.label}</option>`).join('')}</select></div></div><div class="field-hint">Fixed high-contrast looks · save to keep changes. Undo restores the prior look.</div>`;
  }
  private sourceAudioControls(c: Clip, asset: Asset | undefined, kind: Kind | 'title' | 'caption') {
    if (kind !== 'video') return '';
    if (this.session.project.version === 1) return '<div class="field-hint">Source audio muted in V1 · enabling requires an explicit V2 migration.</div>';
    if (!asset?.hasSourceAudio) return '<div class="field-hint">This video has no admitted AAC source audio.</div>';
    const settings = c.sourceAudio ?? DEFAULT_SOURCE_AUDIO;
    return `<div class="divider"></div><div class="field"><label for="clip-source-mute">Source audio</label><select id="clip-source-mute" data-field="source-mute"><option value="off" ${settings.muted ? '' : 'selected'}>On</option><option value="on" ${settings.muted ? 'selected' : ''}>Muted</option></select></div><div class="field"><label for="clip-source-gain">Source gain · linear (0–1)</label><input id="clip-source-gain" data-field="source-gain" type="number" min="0" max="1" step="0.05" value="${settings.gain}"></div><div class="field-hint">Video sound mixes with music. Undo restores the previous setting.</div>`;
  }
  private renderInspector() {
    const c = this.session.project.clips.find(c => c.id === this.selected);
    if (c) this.titleComposerOpen = false;
    const pane = this.root.querySelector('#inspector')!;
    const wrapper = this.root.querySelector('.inspector')!;
    wrapper.classList.toggle('composing-title', !c && this.titleComposerOpen);
    wrapper.classList.toggle('has-selection', !!c);
    wrapper.classList.toggle('has-text-selection', !!c && ['title','caption'].includes(clipKind(this.session.project,c)!));
    if (!c) { pane.innerHTML = `<div class="inspector-empty"><div class="selection-mark">⌁</div><strong>No clip selected</strong><p>Choose a clip on the timeline to adjust its timing, track or effect.</p></div><div class="divider"></div><div class="composer-options"><button class="button title-trigger" data-action="show-title" aria-expanded="${this.titleComposerOpen && this.composerRole === 'title'}">＋ Create a title</button><button class="button caption-trigger" data-action="show-caption" aria-expanded="${this.titleComposerOpen && this.composerRole === 'caption'}">＋ Create a caption</button></div>${this.titleComposerOpen ? `<div class="title-composer"><div class="field"><label for="title-text">${this.composerRole === 'caption' ? 'Caption text' : 'Text on screen'}</label><input id="title-text" maxlength="100" placeholder="${this.composerRole === 'caption' ? 'What is said here?' : 'A moment worth keeping'}"></div><div class="field"><label for="title-duration">Duration · frames</label><input type="number" min="1" max="300" value="${this.composerRole === 'caption' ? 45 : 60}" id="title-duration"></div><button class="button" data-action="title">Add ${this.composerRole} at playhead</button></div>` : ''}`; this.renderUISections(pane); return; }
    const tracks = projectTracks(this.session.project);
    const t = tracks.find(t => t.id === c.trackId)!;
    const asset = this.session.project.assets.find(a => a.id === c.assetId);
    const kind = clipKind(this.session.project,c)!;
    pane.innerHTML = `<div class="section-label">Selected ${kind}</div><div class="selected-name">${escapeHTML(asset?.name || c.text || '')}</div><div class="clip-meta">${escapeHTML(t.label)} · ${clock(c.duration)} duration</div><div class="divider"></div>${(kind === 'title' || kind === 'caption') ? `<div class="field"><label for="clip-text">${c.role === 'caption' ? 'Caption text' : 'Text on screen'}</label><input id="clip-text" data-field="text" type="text" maxlength="100" value="${escapeHTML(c.text || '')}" aria-describedby="clip-text-hint"><div class="field-hint" id="clip-text-hint">Press Enter or leave the field to apply. Undo restores the previous text.</div></div>${this.styleControls(c)}` : ''}<div class="inspector-fields"><div class="field"><label for="clip-start">Start · frames</label><input id="clip-start" data-field="start" type="number" min="0" max="54000" value="${c.start}"></div><div class="field"><label for="clip-track">Track</label>${(this.session.project.version === 3 ? tracks : tracks.filter(tr => tr.kind === t.kind)).length > 1 ? `<select id="clip-track" data-field="track">${(this.session.project.version === 3 ? tracks : tracks.filter(tr => tr.kind === t.kind)).map(tr => `<option value="${tr.id}" ${tr.id === c.trackId ? 'selected' : ''}>${escapeHTML(tr.label)}</option>`).join('')}</select>` : `<div class="field-value" id="clip-track">${escapeHTML(t.label)}</div>`}</div></div>${(kind === 'title' || kind === 'caption') ? `<div class="field"><label for="clip-duration">Duration · frames</label><input id="clip-duration" data-field="duration" type="number" min="1" max="54000" value="${c.duration}"><div class="field-hint">Start and duration are frame counts at 30 FPS. Gaps show no caption.</div></div>` : ''}<div class="row trim-actions"><button class="button" data-action="trim-start">Trim in +15f</button><button class="button" data-action="trim-end">Trim out −15f</button></div><div class="field"><label>Source range</label><div class="field-value">${clock(c.inFrame)} → ${clock(c.inFrame+c.duration)} · ${c.duration} frames</div></div>${kind === 'video' ? `<div class="divider"></div><div class="field"><label for="clip-effect">Video effect</label><select id="clip-effect" data-field="effect"><option value="">None</option>${listEffects().map(e => `<option value="${e.id}" ${c.effect === e.id ? 'selected' : ''}>${escapeHTML(e.name)}</option>`).join('')}</select></div>` : ''}${this.sourceAudioControls(c,asset,kind)}`;
    this.renderUISections(pane);
  }
  private handleClick(e: Event) {
    const target = e.target as HTMLElement;
    const clip = target.closest<HTMLElement>('[data-clip]');
    if (clip) { this.selected = clip.dataset.clip!; this.selectedLane = this.session.project.clips.find(c => c.id === this.selected)!.trackId; this.renderTimeline(); this.renderInspector(); return; }
    const trackButton = target.closest<HTMLButtonElement>('[data-add-track]');
    if (trackButton && !trackButton.disabled) {
      try {
        const kind=trackButton.dataset.addTrack as TrackKind;
        this.execute({type:'track.add',...(this.session.project.version === 3 ? {} : {kind})});
        const id=projectTracks(this.session.project).filter(t=>t.kind === kind).at(-1)!.id;
        this.selectedLane = id; this.renderTimeline(); this.revealLane(id);
        this.root.querySelector<HTMLDetailsElement>('.track-menu')!.open = false;
        this.setStatus(`Added ${this.session.project.version === 3 ? 'generic' : kind} track · save to keep it`);
      }
      catch (error) { this.fail(error); }
      return;
    }
    const label = target.closest<HTMLElement>('[data-select-track]');
    if (label) { this.selectedLane = label.dataset.selectTrack!; this.selected = null; this.renderTimeline(); this.renderInspector(); return; }
    const assetButton = target.closest<HTMLButtonElement>('[data-asset-action]');
    if (assetButton) {
      const action = this.ui.assetActions?.find(item => item.id === assetButton.dataset.assetAction);
      const id = assetButton.dataset.assetId;
      if (action && id && this.assetActionEnabled(action, id)) {
        try { void Promise.resolve(action.run(this.assetContext(id))).catch(error => this.fail(error)); }
        catch (error) { this.fail(error); }
      }
      return;
    }
    const add = target.closest<HTMLElement>('[data-add]');
    if (add) { const asset = this.session.project.assets.find(a => a.id === add.dataset.add)!; const trackId = this.session.project.version === 3 ? this.targetLane() : asset.kind === 'audio' ? 'A1' : 'V1'; const occupied = this.session.project.clips.filter(c => c.trackId === trackId); const start = Math.max(0, ...occupied.map(c => c.start + c.duration)); const newClip: Clip = { id: stamp(), trackId, assetId: asset.id, start, inFrame: 0, duration: asset.durationFrames }; try { this.execute({type:'clip.add', clip:newClip}); this.selected = newClip.id; this.mediaOpen = false; this.root.querySelector('.media-panel')?.classList.remove('media-open'); this.root.querySelector('.media-toggle')?.setAttribute('aria-expanded','false'); this.renderAssets(); this.renderInspector(); this.renderTimeline(); } catch (err) { this.fail(err); } return; }
    const ruler = target.closest<HTMLElement>('#ruler'); if (ruler) { this.seek(Math.round(((e as MouseEvent).clientX - ruler.getBoundingClientRect().left)/this.px)); return; }
    if (target.closest('.track-lane')) { this.selectedLane = target.closest<HTMLElement>('.track-lane')!.dataset.track!; this.selected = null; this.renderTimeline(); this.renderInspector(); return; }
    const menuButton = target.closest<HTMLButtonElement>('[data-menu-action]');
    if (menuButton) {
      const action = this.ui.menuActions?.find(item => item.id === menuButton.dataset.menuAction);
      if (action && this.actionEnabled(action)) {
        const menu = this.root.querySelector<HTMLDetailsElement>('#tools-menu');
        if (menu) menu.open = false;
        try { void Promise.resolve(action.run(this.uiContext())).catch(error => this.fail(error)); }
        catch (error) { this.fail(error); }
      }
      return;
    }
    const hostButton = target.closest<HTMLButtonElement>('[data-ui-action]');
    if (hostButton) {
      const more = hostButton.closest<HTMLDetailsElement>('.more-edit'); if (more) more.open = false;
      const action = this.ui.timelineActions?.find(item => item.id === hostButton.dataset.uiAction);
      if (action && this.actionEnabled(action)) {
        try { void Promise.resolve(action.run(this.uiContext())).catch(error => this.fail(error)); }
        catch (error) { this.fail(error); }
      }
      return;
    }
    const button = target.closest<HTMLElement>('[data-action]'); if (!button) return;
    const more = button.closest<HTMLDetailsElement>('.more-edit'); if (more) more.open = false;
    const action = button.dataset.action; const c = this.session.project.clips.find(c => c.id === this.selected);
    try {
      switch(action) {
        case 'play': this.playing ? this.pause() : this.play(); break;
        case 'back': this.seek(this.position-FPS); break;
        case 'forward': this.seek(this.position+FPS); break;
        case 'zoom-fit': this.fitTimeline = true; this.renderTimeline(); this.updatePlayhead(); this.root.querySelector('.timeline-scroll')!.scrollLeft = 0; break;
        case 'zoom-in': case 'zoom-out': {
          this.fitTimeline = false;
          this.px = Math.max(MIN_PX, Math.min(MAX_PX, this.px * (action === 'zoom-in' ? 1.5 : 1 / 1.5)));
          this.renderTimeline(); this.updatePlayhead(); this.scrollPlayheadIntoView();
          break;
        }
        case 'upgrade-tracks': { if (this.session.project.version === 1) throw new Error('V1 needs explicit host-admitted source-audio migration to V2 before flexible tracks'); this.execute({type:'project.upgradeTracks'}); this.setStatus('Flexible tracks enabled · save to keep this edit'); break; }
        case 'save': case 'load': case 'export': void this.asyncAction(action, button); break;
        case 'reset-layout': this.layout = { ...DEFAULT_LAYOUT }; this.applyLayout(true); break;
        case 'media': this.mediaOpen = !this.mediaOpen; this.root.querySelector('.media-panel')?.classList.toggle('media-open', this.mediaOpen); button.setAttribute('aria-expanded',String(this.mediaOpen)); this.renderAssets(); break;
        case 'jump': { const frame = Number(button.dataset.frame); if (Number.isSafeInteger(frame)) this.seek(frame); break; }
        case 'undo': this.undo(); break;
        case 'redo': this.redo(); break;
        case 'show-title': case 'show-caption': { const role = action === 'show-caption' ? 'caption' : 'title'; this.titleComposerOpen = c || this.composerRole !== role ? true : !this.titleComposerOpen; this.composerRole = role; this.selected = null; this.renderTimeline(); this.renderInspector(); break; }
        case 'title': { const text = (this.root.querySelector<HTMLInputElement>('#title-text')?.value || '').trim(); const len = Number(this.root.querySelector<HTMLInputElement>('#title-duration')?.value); const track = this.session.project.version === 3 ? projectTracks(this.session.project).find(t => t.id === this.targetLane()) : projectTracks(this.session.project).filter(t => t.kind === 'title').find(t => !this.session.project.clips.some(c => c.trackId === t.id && c.start < this.position + len && c.start + c.duration > this.position)); if (!track) throw new Error('No free title track · add another track'); if (this.session.project.version === 3 && this.session.project.clips.some(c => c.trackId === track.id && c.start < this.position + len && c.start + c.duration > this.position)) throw new Error('This time is occupied; move to another track or add a track'); const title: Clip = { id:stamp(), trackId:track.id, ...(this.composerRole === 'caption' ? {role:'caption' as const} : {}), text, start:this.position, inFrame:0, duration:len }; this.execute({type:'clip.add',clip:title}); this.selected=title.id; this.titleComposerOpen=false; this.renderInspector(); this.renderTimeline(); break; }
        case 'trim-start': case 'trim-end': if (c) this.execute({type:'clip.trim',id:c.id,edge:action === 'trim-start' ? 'start':'end',frames:15}); break;
        case 'split': if (c) this.execute({type:'clip.split',id:c.id,at:this.position,newId:stamp()}); break;
        case 'remove': if (c) { this.execute({type:'clip.remove',id:c.id}); this.selected=null; this.renderInspector(); } break;
      }
    } catch (err) { this.fail(err); }
  }
  private async asyncAction(action: string, button: HTMLElement) {
    if (this.busy) return;
    this.busy=true; (button as HTMLButtonElement).disabled=true;
    try { if (action === 'save') await this.save(); if (action === 'load') await this.load(); if (action === 'export') await this.exportVideo(); }
    catch (e) { this.fail(e); } finally { this.busy=false; (button as HTMLButtonElement).disabled=false; }
  }
  private change(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.id === 'media-input') { void this.importFiles(Array.from(input.files || [])).catch(err => this.fail(err)); input.value = ''; return; }
    const c = this.session.project.clips.find(c => c.id === this.selected); if (!c) return;
    try {
      if (input.dataset.field === 'start') this.execute({type:'clip.move',id:c.id,start:Number(input.value),trackId:c.trackId});
      if (input.dataset.field === 'duration' && Number(input.value) !== c.duration) this.execute({type:'clip.resize',id:c.id,edge:'end',delta:Number(input.value)-c.duration});
      if (input.dataset.field === 'track') this.execute({type:'clip.move',id:c.id,start:c.start,trackId:input.value});
      if (input.dataset.field === 'effect') this.execute({type:'clip.effect',id:c.id,effect:input.value || null});
      if (input.dataset.field === 'text' && input.value !== c.text) this.execute({type:'clip.text',id:c.id,text:input.value});
      if (input.dataset.field === 'source-mute' || input.dataset.field === 'source-gain') {
        const current = c.sourceAudio ?? DEFAULT_SOURCE_AUDIO;
        this.execute({type:'clip.sourceAudio',id:c.id,settings:{muted: input.dataset.field === 'source-mute' ? input.value === 'on' : current.muted, gain: input.dataset.field === 'source-gain' ? Number(input.value) : current.gain}});
      }
      if (input.dataset.field === 'palette' || input.dataset.field === 'size') {
        const current = c.style ?? DEFAULT_TEXT_STYLE;
        const style: TextStyle = {palette: (input.dataset.field === 'palette' ? input.value : current.palette) as TextStyle['palette'], size: (input.dataset.field === 'size' ? input.value : current.size) as TextStyle['size']};
        this.execute({type:'clip.style',id:c.id,style});
      }
    }
    catch (err) { this.fail(err); this.renderInspector(); }
  }
  private drop(e: DragEvent) {
    const lane = (e.target as HTMLElement).closest<HTMLElement>('.track-lane'); if (!lane) return;
    e.preventDefault(); const id = e.dataTransfer?.getData('text/plain'); if (!id) return;
    try { const offset = Number(e.dataTransfer?.getData('application/x-editweave-offset') || 0); const start = Math.max(0, Math.round((e.clientX - lane.getBoundingClientRect().left)/this.px)-offset); this.execute({type:'clip.move',id,start,trackId:lane.dataset.track!}); this.selected=id; this.selectedLane=lane.dataset.track!; this.renderInspector(); this.renderTimeline(); } catch (err) { this.fail(err); }
  }
  private resizeClip(event: PointerEvent) {
    const edge = (event.target as HTMLElement).closest<HTMLElement>('.resize-edge');
    const clipElement = edge?.closest<HTMLElement>('[data-clip]');
    if (!edge || !clipElement || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const clip = this.session.project.clips.find(c => c.id === clipElement.dataset.clip);
    if (!clip) return;
    const side = edge.dataset.edge as 'start' | 'end';
    const x = event.clientX;
    const feedback = this.root.querySelector<HTMLElement>('#trim-feedback')!;
    let acceptedDelta = 0;
    const candidateAt = (delta: number) => {
      if (!delta) return clip;
      try { return apply(this.session.project, {type:'clip.resize',id:clip.id,edge:side,delta}).clips.find(c => c.id === clip.id)!; }
      catch { return null; }
    };
    feedback.hidden = false;
    feedback.classList.remove('limit');
    feedback.textContent = `Source ${clock(clip.inFrame)} → ${clock(clip.inFrame + clip.duration)} · ${clip.duration}f`;
    this.trimming = true;
    edge.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      const delta = Math.round((e.clientX - x) / this.px);
      const candidate = candidateAt(delta);
      if (!candidate) { feedback.classList.add('limit'); feedback.textContent = 'Trim limit · source or adjacent clip'; return; }
      feedback.classList.remove('limit');
      acceptedDelta = delta;
      clipElement.style.width = `${candidate.duration * this.px}px`;
      clipElement.style.left = `${candidate.start * this.px}px`;
      feedback.textContent = `Source ${clock(candidate.inFrame)} → ${clock(candidate.inFrame + candidate.duration)} · ${candidate.duration}f`;
    };
    const finish = (e: PointerEvent) => {
      edge.removeEventListener('pointermove', move);
      edge.removeEventListener('pointerup', finish);
      edge.removeEventListener('pointercancel', finish);
      this.trimming = false;
      feedback.hidden = true;
      feedback.textContent = '';
      if (e.type === 'pointerup' && acceptedDelta) {
        try { this.execute({type:'clip.resize',id:clip.id,edge:side,delta:acceptedDelta}); this.selected=clip.id; this.renderTimeline(); this.renderInspector(); }
        catch (error) { this.renderTimeline(); this.fail(error); }
      } else this.renderTimeline();
    };
    edge.addEventListener('pointermove', move);
    edge.addEventListener('pointerup', finish);
    edge.addEventListener('pointercancel', finish);
  }
  private scrollPlayheadIntoView() {
    const viewport = this.root.querySelector<HTMLElement>('.timeline-scroll')!;
    const x = TRACK_LABEL_WIDTH + this.position * this.px;
    const visible = viewport.clientWidth - TRACK_LABEL_WIDTH;
    if (visible <= 0) return;
    if (x < viewport.scrollLeft + TRACK_LABEL_WIDTH || x > viewport.scrollLeft + viewport.clientWidth - 12) {
      viewport.scrollLeft = Math.max(0, x - TRACK_LABEL_WIDTH - visible / 2);
    }
  }
  private updatePlayhead() { const head = this.root.querySelector<HTMLElement>('#playhead'); if (head) head.style.left = `${TRACK_LABEL_WIDTH+this.position*this.px}px`; const ruler = this.root.querySelector<HTMLElement>('#ruler'); if (ruler) { ruler.setAttribute('aria-valuenow', String(this.position)); ruler.setAttribute('aria-valuemax', String(duration(this.session.project))); ruler.setAttribute('aria-valuetext', clock(this.position)); } const current = this.root.querySelector('#current'); if (current) current.textContent=clock(this.position); const total = this.root.querySelector('#total'); if (total) total.textContent=clock(duration(this.session.project)); const c=this.session.project.clips.find(c=>c.id===this.selected); const split=this.root.querySelector<HTMLButtonElement>('.edit-tools [data-action="split"]'); if(split) split.disabled=!c || this.position<=c.start || this.position>=c.start+c.duration; this.updateUIActions(); }
  private updateStage() {
    const p = this.session.project;
    const active = p.clips.filter(c => c.start <= this.position && c.start+c.duration > this.position);
    const tracks = projectTracks(p);
    const rank = (c: Clip) => tracks.findIndex(t => t.id === c.trackId);
    const videos = active.filter(c => p.version === 3 ? clipKind(p,c) === 'video' : c.trackId.startsWith('V')).sort((a,b) => p.version === 3 ? rank(a)-rank(b) : a.trackId.localeCompare(b.trackId));
    const music = active.filter(c => p.version === 3 ? clipKind(p,c) === 'audio' : c.trackId.startsWith('A'));
    const titles = active.filter(c => p.version === 3 ? ['title','caption'].includes(clipKind(p,c)!) : c.trackId.startsWith('T')).sort((a,b) => p.version === 3 ? rank(a)-rank(b) : a.trackId.localeCompare(b.trackId));
    const titleLaneRank = (c: Clip) => p.version === 3 ? textLaneRank(p,c.trackId) : tracks.filter(t=>t.kind === 'title').findIndex(t=>t.id === c.trackId);
    const nextVideo = p.clips.filter(c => (p.version === 3 ? clipKind(p,c) === 'video' : c.trackId.startsWith('V')) && c.start > this.position).sort((a, b) => a.start - b.start)[0];
    // V3 visual precedence interleaves video/text by lane, not by media kind.
    // An active clip can cross another kind without changing either grouped list.
    const visualKey = p.version === 3
      ? [...videos,...titles].sort((a,b)=>rank(a)-rank(b)).map(c=>`${c.id}:${c.trackId}:${rank(c)}:${c.effect || ''}`)
      : [...videos.map(c=>`${c.id}:${c.effect || ''}`), ...titles.map(c=>c.id)];
    const key = [...visualKey, ...music.map(c=>c.id),nextVideo?.start ?? ''].join('|');
    if (key !== this.stageKey) {
      this.stageKey = key; for (const audio of this.audio.values()) audio.pause(); this.audio.clear();
      const screen = this.root.querySelector<HTMLElement>('#screen'); if (!screen) return;
      screen.replaceChildren();
      if (!videos.length) {
        const empty = document.createElement('div'); empty.className = 'empty-preview';
        const heading = document.createElement('strong'); heading.textContent = p.assets.length ? 'No video at this frame' : 'Import media to start an edit'; empty.append(heading);
        if (nextVideo) { const jump = document.createElement('button'); jump.type = 'button'; jump.dataset.action = 'jump'; jump.dataset.frame = String(nextVideo.start); jump.textContent = `Jump to next clip · ${clock(nextVideo.start)}`; empty.append(jump); }
        screen.append(empty);
      }
      for (const c of (p.version === 3 ? [...videos,...titles].sort((a,b)=>rank(a)-rank(b)) : videos)) {
        if (p.version === 3 && clipKind(p,c) !== 'video') {
          const overlay = document.createElement('div'); overlay.className = c.role === 'caption' ? 'caption-overlay' : 'title-overlay'; overlay.dataset.clip=c.id;
          const index=textLaneRank(p,c.trackId);
          if (c.role !== 'caption') overlay.style.bottom=`${9 + index * 20 + (index === 0 && titleNeedsCaptionClearance(p,c) ? 21 : 0)}%`;
          const look=textStyle(c); overlay.style.color=look.color.css; overlay.style.fontSize=`${look.pixels / 9.6}cqw`; overlay.textContent=c.text || ''; screen.append(overlay);
          continue;
        }
        const asset = p.assets.find(a => a.id === c.assetId)!;
        const cover = document.createElement('div'); cover.className = 'frame-cover'; cover.dataset.clip = c.id;
        if (asset.posterUrl && c.inFrame === 0 && this.position === c.start) {
          const poster = document.createElement('img'); poster.src = asset.posterUrl; poster.alt = ''; poster.addEventListener('error', () => { cover.textContent = 'Loading video frame'; }, {once:true}); cover.append(poster);
        } else cover.textContent = 'Loading video frame';
        screen.append(cover);
        const v = document.createElement('video'); v.src = asset.url; v.muted = p.version === 1 || !asset.hasSourceAudio || !!c.sourceAudio?.muted || c.sourceAudio?.gain === 0; v.volume = c.sourceAudio?.gain ?? 1; v.playsInline=true; v.preload='auto'; v.dataset.clip=c.id;
        v.classList.add('pending'); v.style.filter=c.effect ? getEffect(c.effect)!.previewCSS : ''; screen.append(v);
        const reveal = () => {
          if (v.seeking || v.readyState < 2) return;
          requestAnimationFrame(() => requestAnimationFrame(() => {
            if (v.isConnected && !v.seeking && v.readyState >= 2) { v.classList.remove('pending'); cover.hidden = true; }
          }));
        };
        v.addEventListener('loadeddata', reveal);
        v.addEventListener('seeked', () => {
          if (!v.isConnected) return;
          // Reconcile a coalesced seek with the latest playhead before revealing.
          // Writing currentTime during an in-flight seek can stall Chromium.
          this.updateStage();
          reveal();
        });
        v.addEventListener('loadedmetadata', () => { v.currentTime = (c.inFrame+this.position-c.start)/FPS; if(this.playing) void v.play().catch(()=>{}); }, {once:true});
      }
      for (const title of p.version === 3 ? [] : [...titles.filter(c => c.role !== 'caption'), ...titles.filter(c => c.role === 'caption')]) {
        const overlay=document.createElement('div'); overlay.className=title.role === 'caption' ? 'caption-overlay' : 'title-overlay'; overlay.dataset.clip=title.id;
        const index=titleLaneRank(title);
        if (title.role !== 'caption') overlay.style.bottom=`${9 + index * 20 + (index === 0 && titleNeedsCaptionClearance(p, title) ? 21 : 0)}%`;
        const look = textStyle(title);
        overlay.style.color = look.color.css;
        overlay.style.fontSize = `${look.pixels / 9.6}cqw`;
        overlay.textContent=title.text || ''; screen.append(overlay);
      }
      for (const clip of music) {
        const audio = new Audio(p.assets.find(a=>a.id===clip.assetId)!.url);
        audio.preload='auto'; this.audio.set(clip.id,audio);
        audio.addEventListener('loadedmetadata',()=>{ if(this.audio.get(clip.id) === audio) { audio.currentTime=(clip.inFrame+this.position-clip.start)/FPS; if(this.playing) void audio.play().catch(()=>{}); } },{once:true});
      }
    }
    // Editing an active title should not recreate or interrupt playing video/audio elements.
    for (const title of titles) {
      const overlay = [...this.root.querySelectorAll<HTMLElement>('#screen .title-overlay, #screen .caption-overlay')].find(el => el.dataset.clip === title.id);
      if (overlay) {
        const look = textStyle(title);
        if (title.role !== 'caption') {
          const index = titleLaneRank(title);
          overlay.style.bottom = `${9 + index * 20 + (index === 0 && titleNeedsCaptionClearance(p, title) ? 21 : 0)}%`;
        }
        overlay.style.color = look.color.css;
        overlay.style.fontSize = `${look.pixels / 9.6}cqw`;
        if (overlay.textContent !== title.text) overlay.textContent = title.text || '';
      }
    }
    for (const v of this.root.querySelectorAll<HTMLVideoElement>('#screen video')) {
      const c = videos.find(c => c.id === v.dataset.clip)!;
      const asset = p.assets.find(a => a.id === c.assetId)!;
      v.muted = p.version === 1 || !asset.hasSourceAudio || !!c.sourceAudio?.muted || c.sourceAudio?.gain === 0;
      v.volume = c.sourceAudio?.gain ?? 1;
      const time = (c.inFrame + this.position - c.start) / FPS;
      if (v.readyState && !v.seeking && Math.abs(v.currentTime - time) > (this.playing ? .14 : .015)) {
        if (!this.playing) {
          v.classList.add('pending');
          const cover = [...this.root.querySelectorAll<HTMLElement>('#screen .frame-cover')].find(el => el.dataset.clip === c.id);
          if (cover) { cover.textContent = 'Seeking video frame'; cover.hidden = false; }
        }
        v.currentTime = time;
      }
      if (this.playing && v.paused) void v.play().catch(()=>{});
    }
    for (const clip of music) { const audio=this.audio.get(clip.id); if (!audio) continue; const time=(clip.inFrame+this.position-clip.start)/FPS; if(audio.readyState && Math.abs(audio.currentTime-time) > (this.playing ? .14 : .015)) audio.currentTime=time; if(this.playing && audio.paused) void audio.play().catch(()=>{}); }
  }
  private play() { if (!duration(this.session.project)) return; if(this.position>=duration(this.session.project)) this.seek(0); this.playing=true; this.started=performance.now(); this.frameAtStart=this.position; this.root.querySelector('#play')!.textContent='Ⅱ'; this.updateStage(); requestAnimationFrame(()=>this.tick()); }
  private pause() { this.playing=false; const play=this.root.querySelector('#play'); if(play) play.textContent='▶'; this.root.querySelectorAll<HTMLVideoElement>('#screen video').forEach(v=>v.pause()); for(const audio of this.audio.values()) audio.pause(); }
  private tick() { if(!this.playing) return; const frame=this.frameAtStart + Math.floor((performance.now()-this.started)*FPS/1000); if(frame>=duration(this.session.project)) { this.seek(duration(this.session.project)); this.pause(); return; } this.position=frame; this.updateStage(); this.updatePlayhead(); requestAnimationFrame(()=>this.tick()); }
}
customElements.define('edit-weave',EditWeave);
