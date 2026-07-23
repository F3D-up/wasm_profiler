import type { ProfileMode } from './profile';
import type { TraceModuleMeta, TraceSnapshot } from './traceConvert';
export const TRACING_PORT = 'wasm-tracing';
export const PAGE_TAG = '__wasmProfilerToExt';
export const EXT_TAG = '__wasmProfilerToPage';

export interface TracingActiveQuery {
  type: 'tracing-required';
}

export interface CommandResponse {
  ok: boolean;
  error?: string;
  confirm?: string;
  active?: ProfileMode;
}
export type ControllerCommand =
  { type: 'profiler-status'; tabId: number } |
  { type: 'profiler-start-sampling'; tabId: number; intervalMicroS?: number; force?: boolean } |
  { type: 'profiler-stop-sampling'; tabId: number } |
  { type: 'profiler-start-tracing'; tabId: number } |
  { type: 'profiler-stop-tracing'; tabId: number };

export type BridgeToBackground =
  { type: 'rewrite-begin'; requestId: number; url?: string; totalChunks: number } |
  { type: 'rewrite-chunk'; requestId: number; index: number; data: string } |
  { type: 'rewrite-end'; requestId: number } |
  { type: 'snapshot'; requestId: number; snapshot: TraceSnapshot } |
  { type: 'issue'; description: string };

export type BackgroundToBridge =
  { type: 'rewritten-begin'; requestId: number; meta: TraceModuleMeta; totalChunks: number } |
  { type: 'rewritten-chunk'; requestId: number; index: number; data: string } |
  { type: 'rewritten-end'; requestId: number } |
  { type: 'rewrite-failed'; requestId: number; error: string } |
  { type: 'collect'; requestId: number };
//locimo med kind in type za lazjo breljivost in kontekst
// kind je za page-bridge, type je za bridge-background
export type PageToBridge =
  { kind: 'query-active' } |
  { kind: 'rewrite'; requestId: number; url?: string; buffer: ArrayBuffer } |
  { kind: 'snapshot'; requestId: number; snapshot: TraceSnapshot } |
  { kind: 'issue'; description: string };

export type BridgeToPage =
  { kind: 'active'; active: boolean } |
  { kind: 'rewritten'; requestId: number; buffer: ArrayBuffer; meta: TraceModuleMeta } |
  { kind: 'rewrite-failed'; requestId: number; error: string } |
  { kind: 'collect'; requestId: number };
