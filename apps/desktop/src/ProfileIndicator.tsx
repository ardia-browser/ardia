import { useLayoutEffect, useRef } from "react";
import { Symbol } from "@ardia/shell";
import { openProfileMenu } from "../../browser/src/state/browser/actions";
import { AppMenuButton } from "./AppMenuButton";
import { profileNameColor, useTheme } from "../../browser/src/components/ui/theme";
import { useIsIncognito, useProfiles, useWindowId, useWindowProfile } from "../../browser/src/state/browser/hooks";
import { setMeasuredWidth, useMeasuredWidth } from "../../browser/src/state/windows/measuredWidths";
import { useMenuBesideWindowButtons } from "./sidebarHeaderLayout";
import { headerIndicatorLayout } from "./profileIndicatorLayout";

export { profileIndicatorX } from "../../browser/src/components/profiles/ProfileIndicator";

function useIndicator(room: number, profileShown: boolean) {
  const incognito = useIsIncognito();
  const profiles = useProfiles();
  const profile = useWindowProfile();
  const name = incognito ? "Incognito" : profile?.name ?? "Personal";
  const textWidth = useMeasuredWidth(`linux-profile-name|${name}`);
  const menuInHeader = !useMenuBesideWindowButtons();
  return { incognito, profile, name, textWidth, ...headerIndicatorLayout({ room, textWidth, named: profileShown && (incognito || profiles.length >= 2), menuInHeader }) };
}

export const useProfileIndicatorWidth = (room: number, profileShown = true) => useIndicator(room, profileShown).width;

export const useAppMenuInHeader = (): boolean => !useMenuBesideWindowButtons();

export function HeaderAppMenu({ size }: { size: number }) {
  const windowId = useWindowId();
  return useAppMenuInHeader() ? <AppMenuButton windowId={windowId} size={size} /> : null;
}

export function ProfileIndicator({ room, profileShown = true }: { room: number; profileShown?: boolean }) {
  const theme = useTheme();
  const windowId = useWindowId();
  const { incognito, profile, name, textWidth, shown, showName, nameWidth, width, menuInHeader } = useIndicator(room, profileShown);
  const measure = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (measure.current) setMeasuredWidth(`linux-profile-name|${name}`, Math.ceil(measure.current.getBoundingClientRect().width));
  }, [name]);
  const color = !incognito && profile ? profileNameColor(profile, theme.dark) : theme.textPrimary;
  return (
    <div className="ardia-profile-controls" data-ardia-profile-controls style={{ width, color }}>
      <span ref={measure} className="ardia-current-space-measure" aria-hidden>{name}</span>
      {shown ? (
        <button className="ardia-header-button ardia-current-space" data-ardia-current-space={profile?.id} aria-label={`Current space: ${name}`} title={name} style={{ width: nameWidth }} onClick={(event) => {
          const button = event.currentTarget;
          const openedByPointer = !button.matches(":focus-visible");
          void Promise.resolve(openProfileMenu(windowId)).finally(() => {
            if (openedByPointer && document.activeElement === button) button.blur();
          });
        }} disabled={incognito}>
          {showName ? <span>{name}</span> : textWidth ? <Symbol name="person.fill" size={14} weight="semibold" color={color} style={{ width: 16, height: 16 }} /> : null}
        </button>
      ) : null}
      {menuInHeader ? <AppMenuButton windowId={windowId} /> : null}
    </div>
  );
}
