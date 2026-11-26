import { createSuggestStore, type SuggestStore } from "@ardia/core";

const stores = new Map<string, SuggestStore>();

export function suggestStoreFor(profile: string): SuggestStore {
  let store = stores.get(profile);
  if (!store) stores.set(profile, (store = createSuggestStore()));
  return store;
}

export function resetSuggestStores() {
  stores.clear();
}
