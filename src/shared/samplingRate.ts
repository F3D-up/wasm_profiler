export const DEFAULT_SAMPLE_INTERVAL_MICRO_S = 1000;
export const MIN_SAMPLE_INTERVAL_MICRO_S = 50;
export const MAX_SAMPLE_INTERVAL_MICRO_S = 100000;
export const SAMPLE_INTERVAL_PRESETS_MICRO_S = [50, 100, 250, 500, 1000, 2000, 5000, 10000];
export const SETTINGS_KEY = 'samplingSettings';

//preverimo da uporabnik ni vnesel nesmiselne vrednosti in jo pretrvorimo
export function checkSampleIntervalMicroS(value: unknown): number {
  const n = (typeof value === 'number' ? value : Number(value));
  if (!Number.isFinite(n)) return DEFAULT_SAMPLE_INTERVAL_MICRO_S;

  return Math.min(MAX_SAMPLE_INTERVAL_MICRO_S, Math.max(MIN_SAMPLE_INTERVAL_MICRO_S, Math.round(n)));
}

export async function loadSampleIntervalMicroS(): Promise<number> {
  const items = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = items[SETTINGS_KEY] as { sampleIntervalMicroS?: unknown } | undefined;

  return checkSampleIntervalMicroS(settings?.sampleIntervalMicroS);
}

export async function saveSampleIntervalMicroS(intervalMicroS: number): Promise<void> {
  await chrome.storage.local.set({
    [SETTINGS_KEY]: { sampleIntervalMicroS: checkSampleIntervalMicroS(intervalMicroS) }
  });
}
