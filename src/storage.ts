import type { Asset, Kind, Project } from './core';
/** Optional load envelope: the host commits response-specific state only when the editor accepts this project. */
export type AcceptedLoad = { project: Project | null; accept(): void };
export interface HostStorage {
  /** Set false to disable export even when an export function is present. */
  readonly supportsExport?: boolean;
  load(): Promise<Project | null | AcceptedLoad>;
  save(project: Project): Promise<void>;
  ingest(file: File, kind: Kind): Promise<Asset>;
  export?(project: Project): Promise<string>;
}
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || 'Host storage failed');
  return json as T;
}
export class LocalAPIStorage implements HostStorage {
  load() { return request<Project | null>('/api/projects/local'); }
  async save(project: Project) { await request('/api/projects/local', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(project) }); }
  ingest(file: File, kind: Kind) { return request<Asset>(`/api/assets?kind=${kind}&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file }); }
  async export(project: Project) { const result = await request<{url:string}>('/api/exports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(project) }); return result.url; }
}
export class BrowserProjectStorage implements HostStorage {
  constructor(private key = 'editweave-second-host') {}
  async load() { const value = localStorage.getItem(this.key); return value ? JSON.parse(value) as Project : null; }
  async save(project: Project) { localStorage.setItem(this.key, JSON.stringify(project)); }
  ingest(file: File, kind: Kind) { return new LocalAPIStorage().ingest(file, kind); }
  export(project: Project) { return new LocalAPIStorage().export(project); }
}
