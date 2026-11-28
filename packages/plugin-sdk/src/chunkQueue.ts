import { PluginError } from "./rpc";

type Waiting = { resolve: (result: IteratorResult<string>) => void; reject: (error: unknown) => void };

export const MAX_BUFFERED_CHUNKS = 4096;

export function chunkQueue(onDone: () => void, onFail: (error: unknown, fromHost: boolean) => void) {
  const buffered: string[] = [];
  const readers: Waiting[] = [];
  let ended = false;
  let failure: unknown = null;
  const close = () => {
    ended = true;
    onDone();
  };
  const queue = {
    push(data: string) {
      if (ended) return;
      const reader = readers.shift();
      if (reader) reader.resolve({ value: data, done: false });
      else if (buffered.length < MAX_BUFFERED_CHUNKS) buffered.push(data);
      else queue.fail(new PluginError("overflow", "The stream sent more than the plugin read; it was cut off."), false);
    },
    end() {
      if (ended) return;
      close();
      if (!buffered.length) for (const reader of readers.splice(0)) reader.resolve({ value: undefined, done: true });
    },
    fail(error: unknown, fromHost = true) {
      if (ended) return;
      failure = error;
      buffered.length = 0;
      close();
      for (const reader of readers.splice(0)) reader.reject(error);
      onFail(error, fromHost);
    },
    next(): Promise<IteratorResult<string>> {
      const value = buffered.shift();
      if (value !== undefined) return Promise.resolve({ value, done: false });
      if (failure) return Promise.reject(failure);
      if (ended) return Promise.resolve({ value: undefined, done: true });
      return new Promise<IteratorResult<string>>((resolve, reject) => readers.push({ resolve, reject }));
    },
    get ended() {
      return ended;
    },
  };
  return queue;
}
