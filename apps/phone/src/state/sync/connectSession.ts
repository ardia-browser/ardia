export type FolderPick = { folder: string; name: string };

export type ConnectOutcome = { result: string };

export type ConnectApi<R extends ConnectOutcome = ConnectOutcome> = {
  pickFolder(): Promise<FolderPick | null>;
  connect(phrase: string, folder: FolderPick): Promise<R>;
  forgetFolder(folder: FolderPick): Promise<void>;
};

export type ConnectState<R extends ConnectOutcome = ConnectOutcome> = { folder: FolderPick | null; connecting: boolean; failure: R | null };

export const IDLE_CONNECT: ConnectState<never> = { folder: null, connecting: false, failure: null };

export function createConnectSession<R extends ConnectOutcome>(api: ConnectApi<R>, phraseIsValid: (phrase: string) => boolean) {
  let state: ConnectState<R> = IDLE_CONNECT;
  const listeners = new Set<() => void>();
  const set = (next: Partial<ConnectState<R>>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const forget = (folder: FolderPick | null) => {
    if (folder) void api.forgetFolder(folder).catch(() => undefined);
  };

  async function connectIfReady(phrase: string): Promise<R | null> {
    const folder = state.folder;
    if (!folder || state.connecting || !phraseIsValid(phrase)) return null;
    set({ connecting: true, failure: null });
    let outcome: R;
    try {
      outcome = await api.connect(phrase, folder);
    } catch {
      outcome = { result: "folderUnavailable" } as R;
    }
    if (outcome.result === "connected") set({ connecting: false, folder: null, failure: null });
    else set({ connecting: false, failure: outcome });
    return outcome;
  }

  async function pickFolder(phrase: string): Promise<R | null> {
    if (state.connecting) return null;
    let picked: FolderPick | null = null;
    try {
      picked = await api.pickFolder();
    } catch {
      picked = null;
    }
    if (!picked) return null;
    if (state.folder && state.folder.folder !== picked.folder) forget(state.folder);
    set({ folder: picked, failure: null });
    return connectIfReady(phrase);
  }

  function abandon() {
    if (state.connecting) return;
    forget(state.folder);
    set({ folder: null });
  }

  return {
    state: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    pickFolder,
    connectIfReady,
    abandon,
    clearFailure: () => set({ failure: null }),
  };
}
