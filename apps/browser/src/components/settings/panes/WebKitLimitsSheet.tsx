import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { getPasskeyAccess, NO_PASSKEY_ACCESS } from "../../../state/engines/passkeys";
import { closeSettingsSheet, showSettingsSheet } from "../../../state/settings/sheet";
import { noteWebKitLimits } from "../../../state/telemetry/usage";
import { Button, DialogActions, DialogTitle, lineHeight, proseLineHeight, Sheet, space, Text } from "../../ui";
import { aboutEngines } from "../tokens";
import { useContentBlocker } from "./FilterListsSheet";
import { webKitRunsExtensions } from "../../../state/engines/webKitSupport";

export const ABOUT_ENGINES_TITLE = "About Engines";

const AUTOMATIC = "Automatic opens most sites in Chromium, where every extension and the full ad blocker run. Netflix and other sites whose video needs FairPlay (Apple's DRM) open in WebKit.";

type Limit = { label: string; detail: string };
type LimitGroup = { title: string; limits: Limit[]; onlyWhileBlocking?: true };

const PASSKEYS: Limit = { label: "Passkeys", detail: "No passkeys or security keys" };

const NO_EXTENSIONS: LimitGroup = { title: "WebKit Extensions", limits: [{ label: "Extensions", detail: "Need macOS 15.4 or later" }] };

const WEBKIT_LIMITS: LimitGroup[] = [
  {
    title: "WebKit Pages",
    limits: [
      { label: "Picture in Picture", detail: "Videos only" },
      PASSKEYS,
      { label: "Client Hints", detail: "Sites see Safari's browser details" },
      { label: "Web MIDI and Casting", detail: "Not supported" },
      { label: "Offline Data", detail: "Kept per engine, so some apps sign out" },
    ],
  },
  {
    title: "WebKit Extensions",
    limits: [
      { label: "chrome.debugger", detail: "Not supported" },
      { label: "webRequest", detail: "Can watch but not block or change" },
      { label: "Extension State", detail: "Storage, alarms, permissions kept apart" },
    ],
  },
  {
    title: "WebKit Ad Blocking",
    onlyWhileBlocking: true,
    limits: [{ label: "uBlock Filters", detail: "No stand-ins, removeparam, headers" }],
  },
];

export function showWebKitLimits(from: "engineRow" | "enginesPane") {
  noteWebKitLimits(from);
  showSettingsSheet(<WebKitLimitsSheet />);
}

function WebKitLimitsSheet() {
  const [passkeysWork, setPasskeysWork] = useState(false);
  const [blocker] = useContentBlocker();
  const blockingOff = blocker?.enabled === false;
  useEffect(() => {
    let live = true;
    void getPasskeyAccess()
      .catch(() => NO_PASSKEY_ACCESS)
      .then((access) => live && setPasskeysWork(access.entitled));
    return () => {
      live = false;
    };
  }, []);
  return (
    <Sheet size="l" onClose={closeSettingsSheet}>
      <DialogTitle>{ABOUT_ENGINES_TITLE}</DialogTitle>
      <ScrollView style={LIST} contentContainerStyle={SECTIONS}>
        <Text style={PROSE}>{AUTOMATIC}</Text>
        {WEBKIT_LIMITS.filter((group) => !(group.onlyWhileBlocking && blockingOff)).map((group) => (group.title === NO_EXTENSIONS.title && !webKitRunsExtensions() ? NO_EXTENSIONS : group)).map((group) => (
          <Section key={group.title} title={group.title} limits={passkeysWork ? group.limits.filter((limit) => limit !== PASSKEYS) : group.limits} />
        ))}
      </ScrollView>
      <DialogActions>
        <Button title="Done" kind="primary" onPress={closeSettingsSheet} />
      </DialogActions>
    </Sheet>
  );
}

function Section({ title, limits }: { title: string; limits: Limit[] }) {
  return (
    <View>
      <Text size="small" weight="semibold" tone="textSecondary" style={HEADER}>
        {title}
      </Text>
      {limits.map((limit) => (
        <View key={limit.label} accessible accessibilityLabel={`${limit.label}. ${limit.detail}.`} style={ROW}>
          <Text style={LABEL}>
            {limit.label}
          </Text>
          <Text tone="textSecondary" style={DETAIL}>
            {limit.detail}
          </Text>
        </View>
      ))}
    </View>
  );
}

const LIST = { flexShrink: 1, marginTop: space.l } as const;
const SECTIONS = { gap: space.xxl, paddingBottom: space.xs } as const;
const PROSE = { lineHeight: proseLineHeight.body } as const;
const HEADER = { lineHeight: lineHeight.small, marginBottom: space.s } as const;
const ROW = { flexDirection: "row", paddingVertical: space.xs } as const;
const LABEL = { width: aboutEngines.labelWidth, lineHeight: lineHeight.body } as const;
const DETAIL = { flex: 1, lineHeight: lineHeight.body } as const;
