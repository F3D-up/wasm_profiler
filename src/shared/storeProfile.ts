import type { ProfileRun } from './profile';

export async function persistProfile(run: ProfileRun): Promise<void> {
  try {

    await chrome.storage.local.set({ profileData: run });

  } catch (err) {

    //test for storage quota exceeded warning
    const text = err instanceof Error ? err.message : String(err);
    if (/quota/i.test(text)) {
      throw new Error(
        'This profile is too large for extension storage. Capture a shorter run, or export the current one before retrying.'
      );
    }
    throw err;
  }
}

export function assertProfilablePage(url: string | undefined): void {

  //dovolimo samo na http, https in file straneh
  if (url && /^(https?|file):/.test(url)) return;

  throw new Error(
    'Chrome does not allow profiling this page (chrome://, Web Store, and extension pages are restricted). Open the target site in a regular tab and try again.'
  );
}
