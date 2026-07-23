import { chunksToBytes, bytesToChunks } from '../shared/chunk';
import { instrumentModule } from '../shared/instrument';
import {TRACING_PORT,
  type BackgroundToBridge,
  type BridgeToBackground
} from '../shared/messages';
import { assertProfilablePage, persistProfile } from '../shared/storeProfile';
import { describeWasm } from '../shared/moduleMeta';
import {assembleTraceRun,
  type TraceModuleMeta,
  type TraceSnapshot
} from '../shared/traceConvert';

const SESSIONS_KEY = 'tracingSessions';
const INSTRUMENTED_KEY = 'instrumentedTabs';
const COLLECT_TIMEOUT_MS = 10000;

interface TracingSession {
  tabId: number;
  url?: string;
  startedAt: number;
  issues: string[];
}

const openPorts = new Map<number, chrome.runtime.Port>();
const collectWaiters = new Map<number, (snapshot: TraceSnapshot) => void>();
let nextCollectId = 1;

async function getSessions(): Promise<Record<number, TracingSession>> {

  const items = await chrome.storage.session.get(SESSIONS_KEY);
  return (items[SESSIONS_KEY] as Record<number, TracingSession> | undefined) ?? {};
}

async function setSessions(sessions: Record<number, TracingSession>): Promise<void> {
  await chrome.storage.session.set({ [SESSIONS_KEY]: sessions });
}

export async function startTracing(tabId: number): Promise<void> {

  const sessions = await getSessions();

  if (sessions[tabId]) throw new Error('Tracing is already active for this tab.');

  const tab = await chrome.tabs.get(tabId);
  //preveri ce je page http, https ali file
  assertProfilablePage(tab.url);
  sessions[tabId] = { tabId, url: tab.url, startedAt: Date.now(), issues: [] };

  await setSessions(sessions);
  await chrome.tabs.reload(tabId);
}

export async function stopTracing(tabId: number): Promise<void> {

  const sessions = await getSessions();
  const session = sessions[tabId];

  if (!session) throw new Error('No tracing session is active for this tab.');

  const port = openPorts.get(tabId);

  if (!port) {
    delete sessions[tabId];
    await setSessions(sessions);
    throw new Error(
      'No instrumented page is connected. Tracing reloads the page and instruments WebAssembly as it loads — keep the page open, run the workload, then stop.'
    );
  }

  const snapshot = await new Promise<TraceSnapshot>((resolve, reject) => {

    const requestId = nextCollectId++;

    const collectionTimer = setTimeout(() => {
      collectWaiters.delete(requestId);
      reject(new Error('The traced page did not answer the collect request.'));
    }, COLLECT_TIMEOUT_MS);

    collectWaiters.set(requestId, (snapshot) => {
      clearTimeout(collectionTimer);
      resolve(snapshot);
    });

    postToBridge(port, { type: 'collect', requestId });
  });

  delete sessions[tabId];
  await setSessions(sessions);

  const traceRun = assembleTraceRun(snapshot, {
    targetUrl: session.url,
    startedAt: session.startedAt,
    endedAt: Date.now(),
    traceIssues: session.issues
  });

  await persistProfile(traceRun);
  await chrome.tabs.create({ url: chrome.runtime.getURL('viewer/index.html') });
}

export async function tracingActive(tabId: number): Promise<boolean> {
  return Boolean((await getSessions())[tabId]);
}

async function getInstrumented(): Promise<Record<number, true>> {
  const items = await chrome.storage.session.get(INSTRUMENTED_KEY);
  return (items[INSTRUMENTED_KEY] as Record<number, true> | undefined) ?? {};
}

async function markInstrumented(tabId: number): Promise<void> {

  const tabs = await getInstrumented();
  if (tabs[tabId]) return;

  tabs[tabId] = true;
  await chrome.storage.session.set({ [INSTRUMENTED_KEY]: tabs });
}

async function forgetInstrumented(tabId: number): Promise<void> {

  const tabs = await getInstrumented();
  if (!tabs[tabId]) return;

  delete tabs[tabId];
  await chrome.storage.session.set({ [INSTRUMENTED_KEY]: tabs });
}

export async function pageInstrumented(tabId: number): Promise<boolean> {
  return Boolean((await getInstrumented())[tabId]);
}

function postToBridge(port: chrome.runtime.Port, message: BackgroundToBridge): void {
  port.postMessage(message);
}

async function recordIssue(tabId: number, description: string): Promise<void> {

  const sessions = await getSessions();
  const session = sessions[tabId];

  if (!session || session.issues.includes(description)) return;

  session.issues.push(description);
  await setSessions(sessions);
}

async function rewrite(tabId: number, requestId: number, url: string | undefined, bytes: Uint8Array, port: chrome.runtime.Port): Promise<void> {

  try {

    if (!(await tracingActive(tabId))) {
      throw new Error('no tracing session is active for this tab');
    }

    const { hash, functionCount, funcNames } = await describeWasm(bytes);
    const result = await instrumentModule(bytes);

    const meta: TraceModuleMeta = {
      id: `${url ?? 'wasm'}#${hash.slice(0, 8)}`,
      hash,
      url,
      functionCount,
      funcNames
    };

    await markInstrumented(tabId);
    const chunks = bytesToChunks(result.bytes);

    postToBridge(port, { type: 'rewritten-begin', requestId, meta, totalChunks: chunks.length });
    chunks.forEach((data, index) => postToBridge(port, { type: 'rewritten-chunk', requestId, index, data }));
    postToBridge(port, { type: 'rewritten-end', requestId });

  } catch (err) {
    postToBridge(port, {
      type: 'rewrite-failed',
      requestId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

export function initTracing(): void {

  chrome.runtime.onConnect.addListener((port) => {

    if (port.name !== TRACING_PORT) return;

    const tabId = port.sender?.tab?.id;
    if (tabId === undefined) {
      port.disconnect();
      return;
    }

    openPorts.set(tabId, port);
    const buffers = new Map<number, { url?: string; chunks: string[] }>();

    port.onMessage.addListener((message: BridgeToBackground) => {

      switch (message.type) {
        case 'rewrite-begin': {
          buffers.set(message.requestId, {
            url: message.url,
            chunks: new Array<string>(message.totalChunks)
          });
          break;
        }

        case 'rewrite-chunk': {
          const entry = buffers.get(message.requestId);
          if (entry) entry.chunks[message.index] = message.data;
          break;
        }

        case 'rewrite-end': {
          const entry = buffers.get(message.requestId);
          buffers.delete(message.requestId);
          if (!entry) break;
          void rewrite(tabId, message.requestId, entry.url, chunksToBytes(entry.chunks), port);
          break;
        }

        case 'snapshot': {
          const waiter = collectWaiters.get(message.requestId);
          collectWaiters.delete(message.requestId);
          waiter?.(message.snapshot);
          break;
        }

        case 'issue': {
          void recordIssue(tabId, message.description);
          break;
        }
      }
    });

    port.onDisconnect.addListener(() => {
      if (openPorts.get(tabId) === port) openPorts.delete(tabId);
    });
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void (async () => {

      const sessions = await getSessions();

      if (sessions[tabId]) {
        delete sessions[tabId];
        await setSessions(sessions);
      }
      await forgetInstrumented(tabId);
    })();
  });

  //premik na drug tab zavrze instrumentiran modul
  // karkoli novega se ponovno instrumentira dokler je session se aktiven
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {

    if (changeInfo.status !== 'loading') return;

    void (async () => {
      if (await tracingActive(tabId)) return;
      await forgetInstrumented(tabId);
    })();
  });
}
