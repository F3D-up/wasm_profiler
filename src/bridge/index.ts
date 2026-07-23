import { bytesToChunks, chunksToBytes } from '../shared/chunk';
import {
  EXT_TAG,
  PAGE_TAG,
  TRACING_PORT,
  type BackgroundToBridge,
  type BridgeToBackground,
  type BridgeToPage,
  type PageToBridge,
  type TracingActiveQuery
} from '../shared/messages';

let port: chrome.runtime.Port | undefined;

//prihajajoca sporocila dajemo v map saj prepisani modul prispe v vec delih
const incomingMessages = new Map<number, { meta: unknown; chunks: string[]; total: number }>();

const postToPage = (message: BridgeToPage): void => {
  window.postMessage({ [EXT_TAG]: message }, '*');
};

const getPort = (): chrome.runtime.Port => {

  if (port) return port;

  port = chrome.runtime.connect({ name: TRACING_PORT });

  port.onDisconnect.addListener(() => { port = undefined; });

  //sporocila iz Background-a
  port.onMessage.addListener((message: BackgroundToBridge) => {

    switch (message.type) {

      case 'rewritten-begin': {
        incomingMessages.set(message.requestId, {
          meta: message.meta,
          chunks: new Array<string>(message.totalChunks),
          total: message.totalChunks
        });
        break;
      }

      case 'rewritten-chunk': {
        const entry = incomingMessages.get(message.requestId);
        if (entry) entry.chunks[message.index] = message.data;
        break;
      }

      case 'rewritten-end': {
        const entry = incomingMessages.get(message.requestId);
        incomingMessages.delete(message.requestId);
        if (!entry) break;

        const assembledBytes = chunksToBytes(entry.chunks);

        postToPage({
          kind: 'rewritten',
          requestId: message.requestId,
          buffer: assembledBytes.buffer as ArrayBuffer,
          meta: entry.meta as never
        });
        break;
      }

      case 'rewrite-failed': {
        incomingMessages.delete(message.requestId);
        postToPage({ kind: 'rewrite-failed', requestId: message.requestId, error: message.error });
        break;
      }

      case 'collect': {
        postToPage({ kind: 'collect', requestId: message.requestId });
        break;
      }
    }
  });

  return port;
};

const sendToBackground = (message: BridgeToBackground): void => {
  getPort().postMessage(message);
};

//sporocila iz Page-a
window.addEventListener('message', (event: MessageEvent) => {

  if (event.source !== window) return;
  const message = (event.data as Record<string, unknown> | null)?.[PAGE_TAG] as PageToBridge | undefined;

  if (!message) return;

  switch (message.kind) {

    case 'query-active': {
      const query: TracingActiveQuery = { type: 'tracing-required' };

      //tukej uporabim sendMessage saj ta takoj vrne reply
      chrome.runtime.sendMessage(query)
        .then((response: { active?: boolean } | undefined) => {

          const active = Boolean(response?.active);
          if (active) getPort();
          postToPage({ kind: 'active', active });
        }).
        catch(() => postToPage({ kind: 'active', active: false }));

      break;
    }

    case 'rewrite': {

      const dissasembledChunks = bytesToChunks(new Uint8Array(message.buffer));

      sendToBackground({
        type: 'rewrite-begin',
        requestId: message.requestId,
        url: message.url,
        totalChunks: dissasembledChunks.length
      });
      dissasembledChunks.forEach((data, index) =>
        sendToBackground({ type: 'rewrite-chunk', requestId: message.requestId, index, data })
      );

      sendToBackground({ type: 'rewrite-end', requestId: message.requestId });
      break;
    }

    case 'snapshot': {
      sendToBackground({ type: 'snapshot', requestId: message.requestId, snapshot: message.snapshot });
      break;
    }

    case 'issue': {
      sendToBackground({ type: 'issue', description: message.description });
      break;
    }
  }
});
