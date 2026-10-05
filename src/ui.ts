import type { Asset, Clip, Command, Project } from './core';

/** Trusted host callbacks receive a project snapshot, never the live editor state. */
export type EditorUIContext = Readonly<{
  project: Project;
  selectedClip: Clip | null;
  frame: number;
  execute(command: Command): Project;
}>;

export type TimelineAction = Readonly<{
  id: string;
  label: string;
  title?: string;
  enabled?(context: EditorUIContext): boolean;
  run(context: EditorUIContext): void;
}>;
export type MenuAction = TimelineAction;

export type AssetActionContext = EditorUIContext & Readonly<{ asset: Asset }>;
export type AssetAction = Readonly<{
  id: string;
  label: string;
  title?: string;
  enabled?(context: AssetActionContext): boolean;
  run(context: AssetActionContext): void;
}>;

export type InspectorRow = Readonly<{ label: string; value: string }>;
export type InspectorSection = Readonly<{
  id: string;
  title: string;
  when?(context: EditorUIContext): boolean;
  rows(context: EditorUIContext): readonly InspectorRow[];
}>;

/** Per-instance, declarative UI contributions. Not an untrusted plugin sandbox. */
export type EditorUI = Readonly<{
  timelineActions?: readonly TimelineAction[];
  menuActions?: readonly MenuAction[];
  assetActions?: readonly AssetAction[];
  inspectorSections?: readonly InspectorSection[];
}>;

export function validateUI(config: EditorUI) {
  if (!config || typeof config !== 'object' || config.timelineActions !== undefined && !Array.isArray(config.timelineActions) || config.menuActions !== undefined && !Array.isArray(config.menuActions) || config.assetActions !== undefined && !Array.isArray(config.assetActions) || config.inspectorSections !== undefined && !Array.isArray(config.inspectorSections)) throw new Error('Invalid UI configuration');
  const ids = new Set<string>();
  for (const item of [...(config.timelineActions || []), ...(config.menuActions || []), ...(config.assetActions || []), ...(config.inspectorSections || [])]) {
    const name = item && typeof item === 'object' ? 'label' in item ? item.label : item.title : undefined;
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(item.id) || ids.has(item.id) || typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('Invalid or duplicate UI contribution');
    ids.add(item.id);
  }
  for (const action of [...(config.timelineActions || []), ...(config.menuActions || []), ...(config.assetActions || [])]) if (typeof action.run !== 'function' || action.enabled !== undefined && typeof action.enabled !== 'function' || action.title !== undefined && (typeof action.title !== 'string' || action.title.length > 160)) throw new Error('Invalid host action');
  for (const section of config.inspectorSections || []) if (typeof section.rows !== 'function' || section.when !== undefined && typeof section.when !== 'function') throw new Error('Invalid inspector section');
}
