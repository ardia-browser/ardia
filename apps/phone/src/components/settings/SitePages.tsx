import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { bottomBarCollapses } from "../../lib/barCollapse";
import { permissionSummary, PERMISSION_NAMES, sortedPermissions } from "../../lib/sitePermissionNames";
import type { SitePermissionGrant } from "../../platform/pages";
import { refreshSitePermissions, revokeSiteAccess, useSitePermissions } from "../../state/settings/sitePermissions";
import { setBlockingCategory, setCollapsesBottomBar, setDefaultNightShade, setSwipeNavigation, setSearchEngine, useBlocking, useEngines } from "../../state/settings/actions";
import { usePreferences } from "../../state/settings/hooks";
import { popSettings, pushSettings, type SettingsRoute } from "../../state/settings/nav";
import { formatNumber } from "../../state/settings/settingsRules";
import { Dialog, Favicon, font, settingsLayout, settingsTint, Symbol, useDesign, useTheme, type DialogButton } from "../ui";
import { Divider, Group, NavRow, PickerRow, SettingsPage, ToggleRow } from "./SettingsKit";
import { useSyncEnabled, useSyncView } from "../../state/sync/hooks";
import { syncedEngineName } from "../../state/sync/syncRules";
import { dismissWords } from "../../lib/sharedWords";

export const SWIPE_NAVIGATION = [
  { id: "anywhere" as const, title: "From Anywhere" },
  { id: "screenEdges" as const, title: "From Screen Edges" },
  { id: "disabled" as const, title: "Off" },
];

export const NIGHT_SHADE = [
  { id: "disabled" as const, title: "Off" },
  { id: "automatic" as const, title: "Automatic" },
  { id: "always" as const, title: "Always" },
];

export function SearchEnginePage() {
  const theme = useTheme();
  const engines = useEngines((s) => s.engines);
  const selected = usePreferences((p) => p.searchEngineId);
  const syncEnabled = useSyncEnabled();
  const synced = useSyncView().search;
  if (syncEnabled && synced) {
    return (
      <SettingsPage title="Search Engine" onBack={popSettings}>
        <Group footer="Set on your Mac.">
          <View testID="engineFromMac" accessible accessibilityLabel="From Your Mac" accessibilityValue={{ text: syncedEngineName(synced, engines) }} style={[styles.row, styles.labelled]}>
            <Symbol name="laptop" size={22} color={theme.formAccent} />
            <Text style={[font.body, styles.fill, { color: theme.label }]}>From Your Mac</Text>
            <Text style={[font.body, { color: theme.secondaryLabel }]}>{syncedEngineName(synced, engines)}</Text>
          </View>
        </Group>
      </SettingsPage>
    );
  }
  return (
    <SettingsPage title="Search Engine" onBack={popSettings}>
      <Group>
        {engines.map((engine, index) => (
          <View key={engine.id}>
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: engine.id === selected }}
              onPress={() => setSearchEngine(engine.id)}
              style={({ pressed }) => [styles.row, pressed ? { backgroundColor: theme.rowHighlight } : null]}
            >
              <Text style={[font.body, styles.fill, { color: theme.label }]}>{engine.name}</Text>
              {engine.id === selected ? <Symbol name="checkmark" size={18} color={theme.formAccent} /> : null}
            </Pressable>
            {index < engines.length - 1 ? <Divider /> : null}
          </View>
        ))}
      </Group>
    </SettingsPage>
  );
}

export function SiteSettingsPage() {
  return (
    <SettingsPage title="Site Settings" onBack={popSettings}>
      <SiteSettingsGroups openRoute={pushSettings} />
      <AllowedSites />
    </SettingsPage>
  );
}

export function AllowedSites() {
  const theme = useTheme();
  const listed = useSitePermissions((s) => s.listed);
  const grants = useSitePermissions((s) => s.grants);
  useEffect(() => {
    void refreshSitePermissions();
  }, []);
  if (!listed) return null;
  return (
    <Group header="Camera, Microphone and Location" footer="Sites you allowed keep access on this phone until you revoke it. Private tabs always ask.">
      {grants.length ? (
        grants.map((grant, index) => <AllowedSite key={grant.origin} grant={grant} divider={index < grants.length - 1} />)
      ) : (
        <View style={styles.row}>
          <Text style={[font.body, { color: theme.secondaryLabel }]}>None</Text>
        </View>
      )}
    </Group>
  );
}

function AllowedSite({ grant, divider }: { grant: SitePermissionGrant; divider: boolean }) {
  const theme = useTheme();
  const [asking, setAsking] = useState(false);
  const kinds = sortedPermissions(grant.permissions);
  const summary = permissionSummary(kinds);
  const revoke = (kind?: (typeof kinds)[number]) => {
    setAsking(false);
    void revokeSiteAccess(grant.origin, kind);
  };
  const buttons: DialogButton[] = [
    ...(kinds.length > 1 ? kinds.map((kind) => ({ title: `Revoke ${PERMISSION_NAMES[kind]}`, destructive: true, onPress: () => revoke(kind) })) : []),
    { title: kinds.length > 1 ? "Revoke All" : `Revoke ${summary}`, destructive: true, onPress: () => revoke() },
    { title: dismissWords.cancel, onPress: () => setAsking(false) },
  ];
  return (
    <View>
      <Pressable
        testID="allowedSite"
        accessibilityRole="button"
        accessibilityLabel={`${grant.host}, ${summary}`}
        accessibilityHint="Revoke access"
        onPress={() => setAsking(true)}
        style={({ pressed }) => [styles.row, styles.site, pressed ? { backgroundColor: theme.rowHighlight } : null]}
      >
        <Favicon iconUrl={null} pageUrl={grant.origin} size={SITE_FAVICON} />
        <View style={styles.fill}>
          <Text style={[font.body, { color: theme.label }]} numberOfLines={1}>
            {grant.host}
          </Text>
          <Text style={[font.footnote, { color: theme.secondaryLabel }]} numberOfLines={1}>
            {summary}
          </Text>
        </View>
      </Pressable>
      {divider ? <Divider /> : null}
      {asking ? <Dialog title={grant.host} message={`Allowed: ${summary}`} buttons={buttons} onDismiss={() => setAsking(false)} /> : null}
    </View>
  );
}

const SITE_FAVICON = 22;

export function SiteSettingsGroups({ openRoute }: { openRoute: (route: SettingsRoute) => void }) {
  const design = useDesign();
  const state = useBlocking((s) => s.state);
  const nightShade = useEngines((s) => s.nightShade);
  const enabledLists = state?.lists.filter((list) => list.isEnabled).length ?? 0;
  const trusted = state?.exemptHosts.length ?? 0;
  const swipe = usePreferences((p) => p.swipeNavigation);
  const collapses = bottomBarCollapses(design, usePreferences((p) => p.collapsesBottomBar));
  return (
    <>
      <Group>
        <ToggleRow title="Block Ads" icon="handRaised" tint={settingsTint.ads} value={state?.blocksAds ?? true} divider onChange={(on) => setBlockingCategory("ads", on)} />
        <ToggleRow title="Block Trackers" icon="eyeglasses" tint={settingsTint.trackers} value={state?.blocksTrackers ?? true} divider onChange={(on) => setBlockingCategory("trackers", on)} />
        <ToggleRow
          title="Block Cookie Banners"
          icon="listBulletFill"
          tint={settingsTint.cookies}
          value={state?.hidesCookieBanners ?? true}
          divider
          onChange={(on) => setBlockingCategory("cookieBanners", on)}
        />
        <NavRow title="Filter Lists" icon="line3HorizontalDecrease" tint={settingsTint.neutral} value={formatNumber(enabledLists)} divider onPress={() => openRoute({ page: "filterLists" })} />
        <NavRow title="Trusted Sites" icon="checkmarkShield" tint={settingsTint.green} value={trusted ? String(trusted) : "None"} onPress={() => openRoute({ page: "trustedSites" })} />
      </Group>
      <Group footer="Change one site from its page menu.">
        <PickerRow title="Night Shade" icon="moonFill" tint={settingsTint.nightShade} options={NIGHT_SHADE} selected={nightShade} divider onSelect={setDefaultNightShade} />
        <PickerRow
          title="Swipe to Navigate"
          icon="handDrawFill"
          tint={settingsTint.swipe}
          options={SWIPE_NAVIGATION}
          selected={swipe}
          divider
          onSelect={setSwipeNavigation}
        />
        <ToggleRow
          title="Collapse Bottom Bar"
          icon="platterBottomArrowDown"
          tint={settingsTint.bottomBar}
          value={collapses}
          onChange={setCollapsesBottomBar}
        />
      </Group>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", minHeight: settingsLayout.rowMinHeight, paddingHorizontal: settingsLayout.rowInset },
  fill: { flex: 1 },
  labelled: { gap: settingsLayout.labelGap },
  site: { gap: 12, paddingVertical: 8 },
});
