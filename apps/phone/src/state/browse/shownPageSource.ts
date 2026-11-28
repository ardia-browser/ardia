import { useLibrary } from "../library/store";
import { useOnboarding } from "../onboarding/store";
import { usePageUi } from "../page/store";
import { setShownPage } from "../pages/store";
import { useSearch } from "../search/store";
import { useSettingsNav } from "../settings/nav";
import { currentTabs, useTabs } from "../tabs/store";
import { useVoice } from "../voice/store";
import { useDuoSidebar } from "./duoSidebar";
import { followShownPage, shownPageId } from "./shownPage";
import { appIsActive, pageCovered, useBrowse } from "./store";

let follower: ReturnType<typeof followShownPage> | null = null;

const shownNow = () =>
  shownPageId({ appActive: appIsActive(), surface: useBrowse.getState().surface, covered: pageCovered(), voice: useVoice.getState().presented, sidebar: useDuoSidebar.getState().shown, selectedId: currentTabs().selectedId });

export function startShownPage() {
  follower ??= followShownPage(shownNow, setShownPage, [useBrowse, useTabs, usePageUi, useSearch, useLibrary, useSettingsNav, useOnboarding, useVoice, useDuoSidebar]);
}

export const reportShownPage = () => follower?.report();
