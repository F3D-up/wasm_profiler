import type { CommandResponse, ControllerCommand, TracingActiveQuery } from '../shared/messages';
import { initSamplingCleanup, samplingActive, startSampling, stopSampling } from './sampling';
import { initTracing, startTracing, stopTracing, tracingActive } from './tracing';



initSamplingCleanup();
initTracing();

chrome.runtime.onMessage.addListener(
  (message: ControllerCommand | TracingActiveQuery, sender, responseCallback) => {

    //za preverit ce je WASM potrebno instrumentirati (po page refreshu)
    if (message?.type === 'tracing-required') {

      const tabId = sender.tab?.id;
      if (tabId === undefined) {
        responseCallback({ active: false });
        return false;
      }

      void tracingActive(tabId).then((active) => responseCallback({ active }));
      return true;
    }

    void handle(message).then(responseCallback);
    return true;
  }
);

async function handle(message: ControllerCommand): Promise<CommandResponse> {
  try {

    switch (message?.type) {

      case 'profiler-status': {
        if (await samplingActive(message.tabId)) {
          return { ok: true, active: 'sampling' };
        }
        if (await tracingActive(message.tabId)) {
          return { ok: true, active: 'tracing' };
        }
        return { ok: true };
      }

      case 'profiler-start-sampling': {
        const { confirm } = await startSampling(
          message.tabId,
          message.intervalMicroS,
          message.force
        );
        return confirm ? { ok: false, confirm } : { ok: true };
      }

      case 'profiler-stop-sampling': {
        await stopSampling(message.tabId);
        return { ok: true };
      }

      case 'profiler-start-tracing': {
        await startTracing(message.tabId);
        return { ok: true };
      }

      case 'profiler-stop-tracing': {
        await stopTracing(message.tabId);
        return { ok: true };
      }

      default: {
        //spet TypeScript magic. prevajalniku povemo: mogoce message ima type, ce ga ima potem ga vzamemo
        return { ok: false, error: `Unknown message type: ${String( (message as { type?: unknown })?.type )}` };
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
