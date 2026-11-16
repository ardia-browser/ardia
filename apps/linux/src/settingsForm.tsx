import { Children, createContext, isValidElement, useContext, useEffect, type ComponentProps } from "react";
import * as shared from "../../browser/src/components/settings/Form.tsx";
import { sectionUnavailable, setting, settingUnavailable } from "./settingsIndex.ts";

export * from "../../browser/src/components/settings/Form.tsx";

export function Group(props: ComponentProps<typeof shared.Group>) {
  if (settingUnavailable(props.of)) return null;
  const rows = Children.toArray(props.children).filter(
    (child) => !(isValidElement<{ anchor?: unknown }>(child) && typeof child.props.anchor === "string" && settingUnavailable(child.props.anchor)),
  );
  return rows.length ? <shared.Group {...props}>{rows}</shared.Group> : null;
}

export function Anchor(props: ComponentProps<typeof shared.Anchor>) {
  return settingUnavailable(props.id) ? null : <shared.Anchor {...props} />;
}

export const LINKS_FROM_OTHER_APPS_NOTE = " Links from other apps follow Settings › General › Open links from other apps in Little Ardia.";
export const POPUPS_AS_TABS_SWITCH_NOTE = "pop-ups stay windows unless Open pop-up windows as tabs is on";
export const POPUPS_OPEN_AS_TABS_NOTE = "pop-ups open as tabs";

function linuxNewTabLinksDescription(description: string) {
  let text = description;
  if (settingUnavailable("general.openLinksInLittleArdia")) text = text.replace(LINKS_FROM_OTHER_APPS_NOTE, "");
  if (settingUnavailable("tabs.popupsOpenAsTabs")) text = text.replace(POPUPS_AS_TABS_SWITCH_NOTE, POPUPS_OPEN_AS_TABS_NOTE);
  return text;
}

export function Row(props: ComponentProps<typeof shared.Row>) {
  if (settingUnavailable(props.anchor)) return null;
  if (props.anchor !== "tabs.newTabLinksOpenIn" || props.description !== undefined) return <shared.Row {...props} />;
  const description = setting(props.anchor).description;
  if (!description) return <shared.Row {...props} />;
  const linux = linuxNewTabLinksDescription(description);
  return linux === description ? <shared.Row {...props} /> : <shared.Row {...props} description={linux} />;
}

export function SectionHeader(props: ComponentProps<typeof shared.SectionHeader>) {
  const pane = useContext(shared.SettingsPaneContext);
  const entry = props.anchor ? setting(props.anchor) : undefined;
  if (settingUnavailable(props.anchor) || sectionUnavailable(entry?.pane ?? pane, entry?.section ?? props.title)) return null;
  return <shared.SectionHeader {...props} />;
}

export const SettingsProfileWatch = createContext<((profileId: string) => void) | null>(null);

export function useSettingsProfile(initial?: string | null) {
  const chosen = shared.useSettingsProfile(initial);
  const watch = useContext(SettingsProfileWatch);
  const [profileId] = chosen;
  useEffect(() => watch?.(profileId), [watch, profileId]);
  return chosen;
}
