import { create } from "zustand";
import { browseForMe, type BrowseForMeEvent, type ChatGPTAccountState } from "../../platform/browseForMe";
import { browseForMeCounts } from "../../lib/telemetrySchema";
import { settled } from "../pages/store";
import { dismissSearch } from "../search/store";
import { useTabs } from "../tabs/store";
import { countUsage } from "../telemetry/telemetry";
import { browseForMeOffered } from "./offer";

export { browseForMeOffered };

export const useBrowseForMe = create<{ connected: boolean; account: ChatGPTAccountState | null }>()(() => ({ connected: false, account: null }));

export const useChatGPTConnected = () => useBrowseForMe((state) => state.connected);

export const useChatGPTAccount = () => useBrowseForMe((state) => state.account);

const counting = () => !useTabs.getState().incognito;

export function startBrowseForMe(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed || !browseForMeOffered()) return false;
  dismissSearch("submitted");
  if (counting()) countUsage("browse_for_me_opened");
  void settled(() => browseForMe.open(trimmed), undefined);
  return true;
}

export function noteBrowseForMe(event: BrowseForMeEvent) {
  if (event.name === "account") useBrowseForMe.setState(event.account ? { connected: event.connected, account: event.account } : { connected: event.connected });
  if (event.name === "settled" && counting()) for (const field of browseForMeCounts(event.outcome, event.chatGPTFellBack)) countUsage(field);
}

export async function refreshChatGPTConnected() {
  if (!browseForMeOffered()) return;
  if (browseForMe.managesAccountInJS()) return refreshChatGPTAccount();
  useBrowseForMe.setState({ connected: await settled(() => browseForMe.isConnected(), false) });
}

export async function refreshChatGPTAccount() {
  const account = await settled(() => browseForMe.account(), null);
  if (account) useBrowseForMe.setState({ connected: account.connected, account });
}

export async function connectChatGPT(): Promise<boolean> {
  const connected = await settled(() => browseForMe.connect(), false);
  await refreshChatGPTAccount();
  return connected;
}

export async function disconnectChatGPT() {
  await settled(() => browseForMe.disconnect(), undefined);
  await refreshChatGPTAccount();
}

export async function chooseChatGPTModel(slug: string) {
  await settled(() => browseForMe.chooseModel(slug), undefined);
  await refreshChatGPTAccount();
}

export async function chooseChatGPTEffort(effort: string | null) {
  await settled(() => browseForMe.chooseEffort(effort), undefined);
  await refreshChatGPTAccount();
}

export async function clearChatGPTProblem() {
  await settled(() => browseForMe.clearProblem(), undefined);
  await refreshChatGPTAccount();
}

export const openChatGPTUsage = () => void settled(() => browseForMe.openUsage(), undefined);
