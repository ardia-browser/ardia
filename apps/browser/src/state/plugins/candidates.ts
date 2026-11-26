import type { PluginRecord } from "./store";

const wanted = new Map<string, string>();

export const wantCandidate = (name: string, folderId: string) => void wanted.set(name, folderId);

export const dropCandidate = (name: string) => void wanted.delete(name);

export const chosenCandidate = (name: string, record: PluginRecord | undefined): string | null => wanted.get(name) ?? record?.pendingUpdate?.folderId ?? null;

export const resetCandidatesForTests = () => wanted.clear();
