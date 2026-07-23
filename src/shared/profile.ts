export type ProfileMode = 'sampling' | 'tracing';

export type SymbolQuality = 'debug' | 'name' | 'export-import' | 'fallback' | 'stripped';

export const QUALITY_RANK: Record<SymbolQuality, number> = {
  debug: 4,
  name: 3,
  "export-import": 2,
  fallback: 1,
  stripped: 0
}

export interface ProfileRun {
  version: 3;
  mode: ProfileMode;
  targetUrl?: string;
  startedAt: number;
  endedAt: number;
  modules: Record<string, CapturedModule>;
  roots: number[];
  nodes: Record<number, CallTreeNode>;
  sampleIntervalMicroS?: number;
  sampleCount?: number;
  eventCount?: number;
  unbalancedEvents?: number;
  traceIssues?: string[];
}
export interface CapturedModule {
  id: string;
  hash: string;
  url?: string;
  functionCount: number;
  symbolQuality: SymbolQuality;
  funcNames: string[];
}

export interface CallTreeNode {
  id: number;
  parentId: number | null;
  children: number[];
  label: string;
  moduleId?: string;
  funcIndex?: number;
  source?: string;
  quality: SymbolQuality;
  calls?: number;
  samples?: number;
  selfSamples?: number;
  totalMs: number;
  selfMs: number;
}

export interface FunctionSymbol {
  name: string;
  mangled?: string;
  source?: string;
  line?: number;
  quality: SymbolQuality;
}

export interface ArtifactSymbols {
  hash: string;
  filename: string;
  uploadName?: string;
  aliases?: string[];
  functionCount?: number;
  symbolQuality: SymbolQuality;
  symbols: Record<number, FunctionSymbol>;
  sources?: string[];
  createdAt: number;
}
