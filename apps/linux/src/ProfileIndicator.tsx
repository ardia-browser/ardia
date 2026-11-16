import { useLayoutEffect, useRef } from "react";
import { Symbol } from "@ardia/shell";
import { openProfileMenu } from "../../browser/src/state/browser/actions";
import { AppMenuButton } from "./AppMenuButton";
import { profileNameColor, useTheme } from "../../browser/src/components/ui/theme";
import { useIsIncognito, useProfiles, useWindowId, useWindowProfile } from "../../browser/src/state/browser/hooks";
import { setMeasuredWidth, useMeasuredWidth } from "../../browser/src/state/windows/measuredWidths";

export { PROFILE_INDICATOR_X } from "../../browser/src/components/profiles/ProfileIndicator";

const PAD = 5;
const MIN_CUT_NAME = 52;
const ICON_WIDTH = 32;
const MENU_WIDTH = 32;
const GAP = 2;

export function profileIndicatorLayout({ room, textWidth, named }: { room: number; textWidth: number | undefined; named: boolean }) {
  const nameRoom = room - MENU_WIDTH - GAP;
  const shown = named && nameRoom >= ICON_WIDTH;
  const textRoom = nameRoom - 2 * PAD;
  const showName = shown && !!textWidth && (textWidth <= textRoom || textRoom >= MIN_CUT_NAME);
  const nameWidth = !shown ? 0 : showName ? Math.min(nameRoom, textWidth + 2 * PAD) : ICON_WIDTH;
  return { shown, showName, nameWidth, width: Math.max(0, Math.min(room, nameWidth + (shown ? GAP : 0) + MENU_WIDTH)) };
}

function useIndicator(room: number) {
  const incognito = useIsIncognito();
  const profiles = useProfiles();
  const profile = useWindowProfile();
  const name = incognito ? "Incognito" : profile?.name ?? "Personal";
  const textWidth = useMeasuredWidth(`linux-profile-name|${name}`);
  return { incognito, profile, name, textWidth, ...profileIndicatorLayout({ room, textWidth, named: incognito || profiles.length >= 2 }) };
}

export const useProfileIndicatorWidth = (room: number) => useIndicator(room).width;

export function ProfileIndicator({ room }: { room: number }) {
  const theme = useTheme();
  const windowId = useWindowId();
  const { incognito, profile, name, textWidth, shown, showName, nameWidth, width } = useIndicator(room);
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
      <AppMenuButton windowId={windowId} />
    </div>
  );
}
