import { useLayoutEffect, useRef } from "react";
import { Symbol } from "@ardia/shell";
import { openSpaceMenu } from "../../browser/src/state/browser/actions";
import { AppMenuButton } from "./AppMenuButton";
import { spaceNameColor, useTheme } from "../../browser/src/components/ui/theme";
import { useIsIncognito, useSpaces, useWindowId, useWindowSpace } from "../../browser/src/state/browser/hooks";
import { setMeasuredWidth, useMeasuredWidth } from "../../browser/src/state/windows/measuredWidths";
import { useMenuBesideWindowButtons } from "./sidebarHeaderLayout";
import { headerIndicatorLayout } from "./profileIndicatorLayout";

export { PROFILE_INDICATOR_X } from "../../browser/src/components/spaces/SpaceIndicator";

function useIndicator(room: number) {
  const incognito = useIsIncognito();
  const profiles = useSpaces();
  const profile = useWindowSpace();
  const name = incognito ? "Incognito" : profile?.name ?? "Personal";
  const textWidth = useMeasuredWidth(`linux-profile-name|${name}`);
  const menuInHeader = !useMenuBesideWindowButtons();
  return { incognito, profile, name, textWidth, ...headerIndicatorLayout({ room, textWidth, named: incognito || profiles.length >= 2, menuInHeader }) };
}

export const useSpaceIndicatorWidth = (room: number) => useIndicator(room).width;

export function SpaceIndicator({ room }: { room: number }) {
  const theme = useTheme();
  const windowId = useWindowId();
  const { incognito, profile, name, textWidth, shown, showName, nameWidth, width, menuInHeader } = useIndicator(room);
  const measure = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (measure.current) setMeasuredWidth(`linux-profile-name|${name}`, Math.ceil(measure.current.getBoundingClientRect().width));
  }, [name]);
  const color = !incognito && profile ? spaceNameColor(profile, theme.dark) : theme.textPrimary;
  return (
    <div className="ardia-profile-controls" data-ardia-profile-controls style={{ width, color }}>
      <span ref={measure} className="ardia-current-space-measure" aria-hidden>{name}</span>
      {shown ? (
        <button className="ardia-header-button ardia-current-space" data-ardia-current-space={profile?.id} aria-label={`Current space: ${name}`} title={name} style={{ width: nameWidth }} onClick={(event) => {
          const button = event.currentTarget;
          const openedByPointer = !button.matches(":focus-visible");
          void Promise.resolve(openSpaceMenu(windowId)).finally(() => {
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
