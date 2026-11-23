import type { CleanedTitle, CleanedUrl, LinkText } from "@ardia/core/src/cleanUrl.ts";
import { clipboard, pages, system as nativeSystem, type ClipboardOffer } from "@ardia/phone-native";
import { getStringAsync, hasStringAsync, setStringAsync } from "expo-clipboard";
import { requireOptionalNativeModule } from "expo-modules-core";
import { AndroidHaptics, impactAsync, ImpactFeedbackStyle, notificationAsync, NotificationFeedbackType, performAndroidHapticsAsync, selectionAsync } from "expo-haptics";
import { getLocales } from "expo-localization";
import { Image, Linking, Platform, Share } from "react-native";

export const copyText = (text: string) => setStringAsync(text);

export const copyLink = (url: CleanedUrl) => setStringAsync(url);

export const shareLink = (url: CleanedUrl, title: CleanedTitle) => Share.share({ message: url, url, title });

export const sharePageWithPrint = (pageId: string, url: CleanedUrl, title: CleanedTitle) => pages.sharePage(pageId, url, title);

export const openExternal = (url: string) => Linking.openURL(url);

export const preferredLanguage = () => getLocales()[0]?.languageCode ?? "en";

const android = Platform.OS === "android";
const ANDROID_CONFIRM = 30;
const atLeast = (version: number) => Number(Platform.Version) >= version;

export const tapHaptic = () => (android ? performAndroidHapticsAsync(AndroidHaptics.Virtual_Key) : impactAsync(ImpactFeedbackStyle.Light));

export const pressHaptic = () => (android ? performAndroidHapticsAsync(AndroidHaptics.Long_Press) : impactAsync(ImpactFeedbackStyle.Medium));

export const successHaptic = () =>
  android ? performAndroidHapticsAsync(atLeast(ANDROID_CONFIRM) ? AndroidHaptics.Confirm : AndroidHaptics.Virtual_Key) : notificationAsync(NotificationFeedbackType.Success);

export const warningHaptic = () =>
  android ? performAndroidHapticsAsync(atLeast(ANDROID_CONFIRM) ? AndroidHaptics.Reject : AndroidHaptics.Long_Press) : notificationAsync(NotificationFeedbackType.Warning);

export const errorHaptic = () =>
  android ? performAndroidHapticsAsync(atLeast(ANDROID_CONFIRM) ? AndroidHaptics.Reject : AndroidHaptics.Long_Press) : notificationAsync(NotificationFeedbackType.Error);

export const barPressHaptic = () => (android ? performAndroidHapticsAsync(AndroidHaptics.Virtual_Key) : impactAsync(ImpactFeedbackStyle.Light));

export const tabLandedHaptic = () => (android ? performAndroidHapticsAsync(AndroidHaptics.Clock_Tick) : impactAsync(ImpactFeedbackStyle.Light));

export const tickHaptic = () => (android ? performAndroidHapticsAsync(AndroidHaptics.Clock_Tick) : selectionAsync());

const ANDROID_SEGMENT_TICK = 34;

export const selectionHaptic = () =>
  android
    ? performAndroidHapticsAsync(Number(Platform.Version) >= ANDROID_SEGMENT_TICK ? AndroidHaptics.Segment_Tick : AndroidHaptics.Clock_Tick)
    : selectionAsync();

export const confirmHaptic = () => (android ? performAndroidHapticsAsync(AndroidHaptics.Confirm) : impactAsync(ImpactFeedbackStyle.Light));

export const shareLinkList = (links: LinkText, title: string) => Share.share({ message: links, title });

export const pasteText = () => getStringAsync();

export const pasteForGo = async (): Promise<string> => (clipboard.readsOnTap() ? ((await clipboard.read()) ?? "") : getStringAsync());

const readsClipOffers = requireOptionalNativeModule("ArdiaPhoneClipboard") !== null;

export async function clipboardOffer(): Promise<ClipboardOffer | null> {
  if (readsClipOffers) return clipboard.offer();
  return (await hasStringAsync()) ? "text" : null;
}

export const prefetchImage = (uri: string): Promise<boolean> => Image.prefetch(uri);

export const displayCornerRadius = (): number | null => nativeSystem.displayCornerRadius();

let syncOffer: boolean | null = null;

export const syncOffered = (): boolean => (syncOffer ??= nativeSystem.syncOffered() !== false);

export const setWidgetColorChoice = (choice: string | null) => nativeSystem.setWidgetColorChoice(choice);
