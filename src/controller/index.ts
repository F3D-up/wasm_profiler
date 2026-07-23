import '../app.css';
import type { CommandResponse, ControllerCommand } from '../shared/messages';
import {
  DEFAULT_SAMPLE_INTERVAL_MICRO_S,
  SAMPLE_INTERVAL_PRESETS_MICRO_S,
  loadSampleIntervalMicroS,
  saveSampleIntervalMicroS
} from '../shared/samplingRate';

const statusEl = document.getElementById('status')!;
const intervalEl = document.getElementById('sample-interval') as HTMLSelectElement;
const buttons = {
  startSampling: document.getElementById('start-sampling') as HTMLButtonElement,
  stopSampling: document.getElementById('stop-sampling') as HTMLButtonElement,
  startTracing: document.getElementById('start-tracing') as HTMLButtonElement,
  stopTracing: document.getElementById('stop-tracing') as HTMLButtonElement
};

async function send(command: ControllerCommand, retriesLeft = 2): Promise<CommandResponse> {

  try {
    return await chrome.runtime.sendMessage(command);
  } catch (err) {
    //chrome.runtime vrne samo niz kot napako, brez kode napake, zato je treba preverjat vsebino
    // malce ponesreceno
    const transient = /receiving end does not exist|message port closed/i.test(String(err));

    if (transient && retriesLeft > 0) {

      //chrome ubije background workerje po par deset sekundah, in ga nazaj zazene on-demand
      await new Promise((r) => setTimeout(r, 150));
      return send(command, retriesLeft - 1);
    }
    throw err;
  }
}

async function activeTabId(): Promise<number> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]?.id) throw new Error('No active tab.');
  return tabs[0].id;
}

function intervalLabel(microS: number): string {
  let label: string;

  if (microS >= 1000) label = `${microS / 1000} ms`;
  else label = `${microS} µs`;

  if (microS === DEFAULT_SAMPLE_INTERVAL_MICRO_S) {
    return `${label} (default)`;
  }
  return label;
}

//selected upostevamo ker je mogoce uporabnik sam spremenil vrednost v natavitvah
function buildIntervalOptions(selected: number): void {

  //javascript nima deduplication funkcije... noro. zato spremenimo v set in nazaj
  const values = [...new Set([...SAMPLE_INTERVAL_PRESETS_MICRO_S, selected])].sort((a, b) => a - b);
  intervalEl.replaceChildren(
    ...values.map((value) => {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = intervalLabel(value);
      option.selected = value === selected;
      return option;
    })
  );
}

function renderUpdate(active: CommandResponse['active'], message: string): void {
  statusEl.textContent = message;
  intervalEl.disabled = active !== undefined;
  buttons.startSampling.disabled = active !== undefined;
  buttons.stopSampling.disabled = active !== 'sampling';
  buttons.startTracing.disabled = active !== undefined;
  buttons.stopTracing.disabled = active !== 'tracing';
}

const activeMessage = (active: CommandResponse['active']): string => {
  if (active === 'sampling') return 'Sampling: run your workload, then stop.';
  if (active === 'tracing') {
    return 'Tracing: the page reloaded with instrumentation. Run your workload, then stop.';
  }
  return 'Ready to profile.';
};

async function refresh(message?: string): Promise<void> {
  try {

    const tabId = await activeTabId();
    const result = await send({ type: 'profiler-status', tabId });
    if (!result.ok) throw new Error(result.error ?? 'status failed');

    renderUpdate(result.active, message ?? activeMessage(result.active));

  } catch (err) {
    statusEl.textContent = err instanceof Error ? err.message : String(err);
  }
}

function addButtonListener(
  button: HTMLButtonElement, type: ControllerCommand['type'], busy: string, extra?: () => Record<string, unknown>
): void {

  button.addEventListener('click', async () => {

    statusEl.textContent = busy;

    try {
      const tabId = await activeTabId();
      //js magic : ...extra?.() poklice lambdo in intepretira kot locene elemente
      const result = await send({ type, tabId, ...extra?.() } as ControllerCommand);

      if (result.confirm !== undefined) {
        pendingConfirm = true;
        buttons.startSampling.textContent = 'Sample anyway';
        statusEl.textContent = result.confirm;
        return;

      } else {
        pendingConfirm = false;
        buttons.startSampling.textContent = 'Start sampling';
        if (!result.ok) throw new Error(result.error ?? `${type} failed`);
        await refresh();
      }

    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
      void refresh(statusEl.textContent ?? undefined);
    }
  });
}

let pendingConfirm = false;



addButtonListener(buttons.startSampling, 'profiler-start-sampling', 'Attaching debugger…', () => ({
  intervalMicroS: Number(intervalEl.value),
  force: pendingConfirm
}));
addButtonListener(buttons.stopSampling, 'profiler-stop-sampling', 'Collecting profile…');
addButtonListener(buttons.startTracing, 'profiler-start-tracing', 'Reloading page with instrumentation…');
addButtonListener(buttons.stopTracing, 'profiler-stop-tracing', 'Collecting trace…');

intervalEl.addEventListener('change', () => {
  void saveSampleIntervalMicroS(Number(intervalEl.value));
});

document.getElementById('open-viewer')!.addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('viewer/index.html') });
});

void loadSampleIntervalMicroS().then(buildIntervalOptions);
void refresh();
