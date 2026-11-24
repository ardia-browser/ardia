import { create } from "zustand";

export const useConnectDraft = create<{ phrase: string }>()(() => ({ phrase: "" }));

export const setConnectPhrase = (phrase: string) => useConnectDraft.setState({ phrase });
