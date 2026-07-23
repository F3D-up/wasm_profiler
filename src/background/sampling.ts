import { chunksToBytes } from '../shared/chunk';
import { convertCdpProfile, type CdpProfile } from '../shared/cdpConvert';
import { describeWasm, type WasmModuleMeta } from '../shared/moduleMeta';
import { pageInstrumented, tracingActive } from './tracing';
import { loadSampleIntervalMicroS, checkSampleIntervalMicroS } from '../shared/samplingRate';
import { assertProfilablePage, persistProfile } from '../shared/storeProfile';


const SESSIONS_KEY = 'samplingSessions';

interface SamplingSession {
  tabId: number;
  url?: string;
  startedAt: number;
  sampleIntervalMicroS: number;
}


//helperji za chrome.*
//
async function getSessions(): Promise<Record<number, SamplingSession>> {
  const items = await chrome.storage.session.get(SESSIONS_KEY);
  return (items[SESSIONS_KEY] as Record<number, SamplingSession> | undefined) ?? {};
}

async function setSessions(sessions: Record<number, SamplingSession>) {
  return chrome.storage.session.set({ [SESSIONS_KEY]: sessions });
}

async function cmd(tabId: number, method: string, params?: Record<string, unknown>) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

export async function startSampling(tabId: number, intervalMicroS?: number, force = false): Promise<{ confirm?: string }> {

  const sessions = await getSessions();
  if (sessions[tabId]) throw new Error('Sampling is already active for this tab.');

  if (!force) {

    const active = await tracingActive(tabId);
    const instrumented = await pageInstrumented(tabId);
    const confirmMessage =
      ' Sampling it measures the rewritten module: hook overhead included, each function split ' +
      'into a wrapper and its __profiler_orig body. Start sampling again to do it anyway.';


    if (active || instrumented) {

      const reason = active
        ? 'Tracing is active on this tab, so its WebAssembly is instrumented.'
        : 'This tab still runs the instrumented WebAssembly from a tracing run — reload page to undo instrumentation.';

      return { confirm: reason + confirmMessage };
    }
  }

  const sampleIntervalMicroS = (intervalMicroS === undefined) ? await loadSampleIntervalMicroS() : checkSampleIntervalMicroS(intervalMicroS);

  const tab = await chrome.tabs.get(tabId);
  assertProfilablePage(tab.url);
  await chrome.debugger.attach({ tabId }, '1.3').catch((err) => {
    const text = err instanceof Error ? err.message : String(err);
    if (/already attached/i.test(text)) {
      throw new Error(
        'Another debugger is already attached to this tab — usually DevTools. Close DevTools and start sampling again.'
      );
    }
    throw new Error(`Chrome refused the debugger attach: ${text}`);
  });

  try {

    await cmd(tabId, 'Profiler.enable');
    await cmd(tabId, 'Profiler.setSamplingInterval', { interval: sampleIntervalMicroS });
    await cmd(tabId, 'Profiler.start');

  } catch (err) {

    await chrome.debugger.detach({ tabId }).catch(() => undefined);
    throw err;
  }

  sessions[tabId] = {
    tabId,
    url: tab.url,
    startedAt: Date.now(),
    sampleIntervalMicroS
  };
  await setSessions(sessions);
  return {};
}

interface ParsedScript {
  scriptId: string;
  url: string;
  scriptLanguage?: string;
}

//identiteto modulov poberemo sele po Profiler.stop da debugger ne vpliva na meritve
async function collectWasmModules(tabId: number): Promise<Map<string, WasmModuleMeta>> {

  const foundModules = new Map<string, WasmModuleMeta>();
  const scripts: ParsedScript[] = [];

  const listener = (source: chrome.debugger.Debuggee, method: string, params?: object): void => {

    if (source.tabId !== tabId || method !== 'Debugger.scriptParsed') return;

    const script = params as ParsedScript;
    if (script.scriptLanguage === 'WebAssembly') scripts.push(script);
  };

  chrome.debugger.onEvent.addListener(listener);

  try {
    await cmd(tabId, 'Debugger.enable');

    //replay scriptParsed navadno pride se pred odgovorom na enable, a se ne zanasamo na to
    if (scripts.length === 0) await new Promise((resolve) => setTimeout(resolve, 250));

    for (const script of scripts) {

      const source = (
        await cmd(tabId, 'Debugger.getScriptSource', { scriptId: script.scriptId })
      ) as { bytecode?: string } | undefined;

      if (!source?.bytecode) continue;

      foundModules.set(script.url, await describeWasm(chunksToBytes([source.bytecode])));
    }

    await cmd(tabId, 'Debugger.disable').catch(() => undefined);

  } catch {
  } finally {
    chrome.debugger.onEvent.removeListener(listener);
  }

  return foundModules;
}

export async function stopSampling(tabId: number): Promise<void> {

  const sessions = await getSessions();
  const session = sessions[tabId];
  if (!session) throw new Error('No sampling session is active for this tab.');

  const { profile } = (await cmd(tabId, 'Profiler.stop')) as { profile: CdpProfile };

  await cmd(tabId, 'Profiler.disable').catch(() => undefined);

  const wasmModules = await collectWasmModules(tabId);

  await chrome.debugger.detach({ tabId }).catch(() => undefined);

  delete sessions[tabId];
  await setSessions(sessions);

  const run = convertCdpProfile(profile, {
    targetUrl: session.url,
    startedAt: session.startedAt,
    endedAt: Date.now(),
    sampleIntervalMicroS: session.sampleIntervalMicroS,
    wasmModules
  });

  await persistProfile(run);
  await chrome.tabs.create({ url: chrome.runtime.getURL('viewer/index.html') });
}

export async function samplingActive(tabId: number): Promise<boolean> {
  return Boolean((await getSessions())[tabId]);
}

//listener ki preveri da se debugger ni ustavil na nepricakovan nacin
export function initSamplingCleanup(): void {

  chrome.debugger.onDetach.addListener(async (source) => {

    const tabId = source.tabId;
    if (tabId === undefined) return;

    const sessions = await getSessions();

    if (sessions[tabId]) {

      delete sessions[tabId];
      await setSessions(sessions);
    }
  });
}
