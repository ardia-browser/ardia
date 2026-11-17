import { useEffect, useState } from "react";
import { AppState, Linking, View } from "react-native";
import { resolveInput } from "@ardia/core";
import { getPasskeyAccess, NO_PASSKEY_ACCESS, requestPasskeyAccess, type PasskeyAccess, type PasskeyAccessStatus } from "../../../state/engines/passkeys";
import { defaultEngine, ENGINE_NAMES, PROTECTED_VIDEO_SITES, RECOMMENDED_ENGINE, siteOf, type PageEngine } from "../../../state/engines/engines";
import { setWebsiteEngine } from "../../../state/engines/actions";
import { useSettings } from "../../../state/browser/hooks";
import { updateSettings } from "../../../state/settings/actions";
import { closeSettingsSheet, showSettingsSheet } from "../../../state/settings/sheet";
import { Button, DialogActions, DialogTitle, lineHeight, PopUp, Sheet, space, Symbol, Text, TextField } from "../../ui";
import { perLook } from "../../ui/tokens";
import { useTheme } from "../../ui/theme";
import { Favicon } from "../../favicon/Favicon";
import { FormField, Group, Row, SectionHeader } from "../Form";
import { setting } from "../settingsIndex";

const ENGINE_OPTIONS: { value: PageEngine; title: string }[] = [
  { value: "chromium", title: ENGINE_NAMES.chromium },
  { value: "webkit", title: ENGINE_NAMES.webkit },
];

const DEFAULT_ENGINE_OPTIONS = ENGINE_OPTIONS.map((o) => (o.value === RECOMMENDED_ENGINE ? { ...o, title: `${o.title} (recommended)` } : o));

const SHOWN_STREAMING_SITES = 5;

const siteLabel = (site: string) => site.replace(/^https:\/\//, "");

export function WebEngineSection() {
  const engine = useSettings((settings) => defaultEngine({ settings }));
  const rules = useSettings((s) => s.websiteEngines);
  const protectedVideo = useSettings((s) => s.protectedVideoInWebKit);
  const sites = Object.keys(rules).sort((a, b) => siteLabel(a).localeCompare(siteLabel(b)));
  return (
    <>
      <SectionHeader title="Web engine" />
      <Group>
        <Row
          anchor="advanced.pageEngine"
          description={
            <View>
              <Text size="caption" tone="textSecondary" style={DETAIL()}>
                {setting("advanced.pageEngine").description}
              </Text>
              <View style={HELP_LINK}>
                <Button variant="text" look="link" pad="none" title="How engines differ" onPress={() => showSettingsSheet(<EnginesDifferSheet />)} />
              </View>
            </View>
          }
        >
          <PopUp value={engine} options={DEFAULT_ENGINE_OPTIONS} onChange={(value) => updateSettings({ pageEngine: value })} minWidth={190} />
        </Row>
        <Row anchor="advanced.websiteEngines">
          {!protectedVideo && <Button title="Add Streaming Sites" onPress={() => updateSettings({ protectedVideoInWebKit: true })} />}
          <Button title="Add Rule…" icon="plus" onPress={() => showSettingsSheet(<RuleSheet />)} />
        </Row>
        {protectedVideo && <StreamingSitesRow />}
        {sites.map((site) => (
          <RuleRow key={site} site={site} engine={rules[site]!} />
        ))}
      </Group>
    </>
  );
}

function StreamingSitesRow() {
  const theme = useTheme();
  const shown = PROTECTED_VIDEO_SITES.slice(0, SHOWN_STREAMING_SITES).join(", ");
  const more = PROTECTED_VIDEO_SITES.length - SHOWN_STREAMING_SITES;
  return (
    <Row
      icon={<Symbol name="play.tv" size={14} color={theme.icon} style={STREAMING_ICON} />}
      title="Streaming sites"
      description={`${shown}${more > 0 ? ` and ${more} more` : ""} open in WebKit, which plays their protected video.`}
    >
      <Text tone="textSecondary">{ENGINE_NAMES.webkit}</Text>
      <Button variant="icon" icon="trash" size="m" onPress={() => updateSettings({ protectedVideoInWebKit: false })} tooltip="Remove" />
    </Row>
  );
}

function RuleRow({ site, engine }: { site: string; engine: PageEngine }) {
  return (
    <Row icon={<Favicon url={site} />} title={siteLabel(site)}>
      <PopUp value={engine} options={ENGINE_OPTIONS} onChange={(value) => setWebsiteEngine(site, value)} minWidth={110} />
      <Button variant="icon" icon="pencil" size="m" onPress={() => showSettingsSheet(<RuleSheet site={site} engine={engine} />)} tooltip="Edit" />
      <Button variant="icon" icon="trash" size="m" onPress={() => setWebsiteEngine(site, null)} tooltip="Remove" />
    </Row>
  );
}

function RuleSheet({ site, engine: initial }: { site?: string; engine?: PageEngine }) {
  const [address, setAddress] = useState(site ? siteLabel(site) : "");
  const [engine, setEngine] = useState<PageEngine>(initial ?? "webkit");
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const typed = address.trim();
    const target = siteOf(/^[a-z][\w+.-]*:\/\//i.test(typed) ? typed : resolveInput(typed, ""));
    if (!target) return setError("Enter a website address, like netflix.com.");
    if (site && site !== target) setWebsiteEngine(site, null);
    setWebsiteEngine(target, engine);
    closeSettingsSheet();
  };
  return (
    <Sheet onClose={closeSettingsSheet}>
      <DialogTitle subtitle="A rule matches the site's address exactly: its scheme, host and port. Subdomains need their own rule.">{site ? "Edit Rule" : "Add Rule"}</DialogTitle>
      <FormField label="Website">
        <TextField value={address} onChangeText={setAddress} placeholder="netflix.com" onSubmit={save} onEscape={closeSettingsSheet} />
      </FormField>
      <FormField label="Opens in" inline>
        <PopUp value={engine} options={ENGINE_OPTIONS} onChange={setEngine} />
      </FormField>
      {error && (
        <Text size="caption" tone="destructive" style={ERROR}>
          {error}
        </Text>
      )}
      <DialogActions
        leading={
          site ? (
            <Button
              title="Remove"
              kind="destructive"
              onPress={() => {
                setWebsiteEngine(site, null);
                closeSettingsSheet();
              }}
            />
          ) : null
        }
      >
        <Button title="Cancel" onPress={closeSettingsSheet} />
        <Button title={site ? "Save" : "Add"} kind="primary" onPress={save} />
      </DialogActions>
    </Sheet>
  );
}

const PASSKEYS_WAITING = "WebKit pages can't use passkeys until Apple grants Ardia its browser passkey entitlement. Sign in with a passkey in Chromium meanwhile.";

const PASSKEY_STATUS: Record<Exclude<PasskeyAccessStatus, "entitlementRequired">, string> = {
  deviceNotConfigured: "Passkeys aren't set up on this Mac. Set up iCloud Keychain or another passkey app in System Settings, then reopen Ardia.",
  notDetermined: "Allow Ardia to use the passkeys saved on this Mac, from the Passwords app and other passkey apps, in WebKit and Chromium pages.",
  authorized: "Websites can use the passkeys saved on this Mac, in WebKit and Chromium pages.",
  denied: "Off. Turn Ardia on in System Settings › Privacy & Security › Passkeys Access for Web Browsers.",
};

function EnginesDifferSheet() {
  return (
    <Sheet size="l" onClose={closeSettingsSheet}>
      <DialogTitle subtitle="Every page opens in Chromium or WebKit. Here's what changes between them.">How engines differ</DialogTitle>
      <View style={DIFFER_LIST}>
        <Group>
          <Row title="Separate sign-ins" description="Each engine keeps its own cookies and site data." />
          <Row title="Extensions and ad blocking are Chromium only" description="WebKit pages run without extensions or the ad blocker for now." />
          <PasskeysRow />
        </Group>
      </View>
      <DialogActions>
        <Button title="Done" kind="primary" onPress={closeSettingsSheet} />
      </DialogActions>
    </Sheet>
  );
}

function PasskeysRow() {
  const [access, setAccess] = useState<PasskeyAccess | null>(null);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    let live = true;
    const refresh = () => void getPasskeyAccess().catch(() => NO_PASSKEY_ACCESS).then((next) => live && setAccess(next));
    refresh();
    const watch = AppState.addEventListener("change", (state) => state === "active" && refresh());
    return () => {
      live = false;
      watch.remove();
    };
  }, []);
  if (!access?.entitled) return <Row title="Passkeys" description={PASSKEYS_WAITING} />;
  const ask = async () => {
    setAsking(true);
    setAccess(await requestPasskeyAccess().catch(() => NO_PASSKEY_ACCESS));
    setAsking(false);
  };
  return (
    <Row title="Passkeys" description={PASSKEY_STATUS[access.status as keyof typeof PASSKEY_STATUS]}>
      {access.status === "notDetermined" && <Button title="Allow Passkeys…" disabled={asking} onPress={() => void ask()} />}
      {access.status === "denied" && <Button title="Open System Settings" onPress={() => void Linking.openURL("x-apple.systempreferences:com.apple.preference.security")} />}
    </Row>
  );
}

const DETAIL = perLook(() => ({ marginTop: space.xxs, lineHeight: lineHeight.caption }) as const);
const HELP_LINK = { flexDirection: "row", marginTop: space.xs } as const;
const STREAMING_ICON = { width: 20, height: 20 } as const;
const DIFFER_LIST = { marginTop: space.m } as const;
const ERROR = { marginTop: space.ml } as const;
