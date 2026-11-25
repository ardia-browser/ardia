type SyncCore = "rust" | "native";
type SyncStatusStore = {
  getState(): { status: string };
  subscribe(listener: (state: { status: string }) => void): () => void;
};
export type WhenSyncCore = <Consent>(consent: Consent, emit: (core: SyncCore, consent: Consent) => void) => void;
export type SyncToggle = { on: true; sync_core: SyncCore } | { on: false };

export function watchSyncToggles<Consent>(store: SyncStatusStore, whenSyncCore: WhenSyncCore, consentNow: () => Consent, send: (toggle: SyncToggle, consent: Consent) => void) {
  let last = store.getState().status;
  return store.subscribe(({ status }) => {
    const was = last;
    last = status;
    if (was === status) return;
    if (was === "off" && status !== "unavailable") whenSyncCore(consentNow(), (core, consent) => send({ on: true, sync_core: core }, consent));
    else if (status === "off" && was !== "unavailable") whenSyncCore(consentNow(), (_core, consent) => send({ on: false }, consent));
  });
}
