import { WorkerUpdater } from './update.mjs';

/** Shares the installed domain owners with the release updater. */
export function createInstalledWorkerUpdater({ browser, domains, ...options }) {
  return new WorkerUpdater({ ...options,
    browserRuntimeLifecycle: browser.runtime,
    drain: async signal => {
      browser.stopAdmission();
      await domains().drainForUpdate(signal);
      await browser.drain();
    },
    resume: async () => {
      try { await browser.resumeAdmission(); }
      finally { await domains().resumeAfterUpdate(); }
    },
  }).initialize();
}
