import { useEffect, useState } from "react";
import { PlatformColor, View } from "react-native";
import { Button, ConfirmationDialog, Form, HStack, LabeledContent, NavigationLink, Picker, RNHostView, Section, SwipeActions, Text, Toggle, VStack } from "@expo/ui/swift-ui";
import { accessibilityElement, accessibilityHint, font, foregroundStyle, frame, navigationBarTitleDisplayMode, navigationTitle, pickerStyle, tag, tint } from "@expo/ui/swift-ui/modifiers";
import { bottomBarCollapses } from "../../lib/barCollapse";
import { permissionSummary, PERMISSION_NAMES, sortedPermissions } from "../../lib/sitePermissionNames";
import { setBlockingCategory, setCollapsesBottomBar, setDefaultNightShade, setSwipeNavigation, useBlocking, useEngines } from "../../state/settings/actions";
import { usePreferences } from "../../state/settings/hooks";
import { settingsRouteKey } from "../../state/settings/nav";
import { formatNumber } from "../../state/settings/settingsRules";
import { refreshSitePermissions, revokeSiteAccess, useSitePermissions } from "../../state/settings/sitePermissions";
import type { SitePermissionGrant } from "../../platform/pages";
import { contentMargins, Favicon, modifierList, settingsChrome, settingsLayout, settingsSwitchStyle, useDesign } from "../ui";
import { ExpoRowLabel } from "./ExpoRowLabel";
import { NIGHT_SHADE, SWIPE_NAVIGATION } from "./SitePages";

const SECONDARY = { type: "hierarchical", style: "secondary" } as const;
const FILL = Number.MAX_SAFE_INTEGER;

export function ExpoSiteSettingsPage() {
  const design = useDesign();
  const state = useBlocking((s) => s.state);
  const nightShade = useEngines((s) => s.nightShade);
  const swipe = usePreferences((p) => p.swipeNavigation);
  const collapses = bottomBarCollapses(design, usePreferences((p) => p.collapsesBottomBar));
  const enabledLists = state?.lists.filter((list) => list.isEnabled).length ?? 0;
  const trusted = state?.exemptHosts.length ?? 0;
  return (
    <Form modifiers={modifierList(navigationTitle("Site Settings"), navigationBarTitleDisplayMode("inline"), tint(PlatformColor("systemBlue")), settingsChrome(), contentMargins({ edges: "top", length: settingsLayout.expoListTop }))}>
      <Section>
        <Toggle isOn={state?.blocksAds ?? true} onIsOnChange={(on) => setBlockingCategory("ads", on)} modifiers={modifierList(settingsSwitchStyle())}>
          <ExpoRowLabel title="Block Ads" systemImage="hand.raised.fill" tint="ads" />
        </Toggle>
        <Toggle isOn={state?.blocksTrackers ?? true} onIsOnChange={(on) => setBlockingCategory("trackers", on)} modifiers={modifierList(settingsSwitchStyle())}>
          <ExpoRowLabel title="Block Trackers" systemImage="eyeglasses" tint="trackers" />
        </Toggle>
        <Toggle isOn={state?.hidesCookieBanners ?? true} onIsOnChange={(on) => setBlockingCategory("cookieBanners", on)} modifiers={modifierList(settingsSwitchStyle())}>
          <ExpoRowLabel title="Block Cookie Banners" systemImage="list.bullet.rectangle.portrait.fill" tint="cookies" />
        </Toggle>
        <NavigationLink value={settingsRouteKey({ page: "filterLists" })}>
          <LabeledContent label={<ExpoRowLabel title="Filter Lists" systemImage="line.3.horizontal.decrease" tint="neutral" />}>
            <Text>{formatNumber(enabledLists)}</Text>
          </LabeledContent>
        </NavigationLink>
        <NavigationLink value={settingsRouteKey({ page: "trustedSites" })}>
          <LabeledContent label={<ExpoRowLabel title="Trusted Sites" systemImage="checkmark.shield.fill" tint="green" />}>
            <Text>{trusted ? formatNumber(trusted) : "None"}</Text>
          </LabeledContent>
        </NavigationLink>
      </Section>
      <Section footer={<Text>Change one site from its page menu.</Text>}>
        <Picker label={<ExpoRowLabel title="Night Shade" systemImage="moon.fill" tint="nightShade" />} selection={nightShade} onSelectionChange={setDefaultNightShade} modifiers={[pickerStyle("menu"), tint("secondary")]}>
          {NIGHT_SHADE.map((option) => (
            <Text key={option.id} modifiers={[tag(option.id)]}>
              {option.title}
            </Text>
          ))}
        </Picker>
        <Picker label={<ExpoRowLabel title="Swipe to Navigate" systemImage="hand.draw.fill" tint="swipe" />} selection={swipe} onSelectionChange={setSwipeNavigation} modifiers={[pickerStyle("menu"), tint("secondary")]}>
          {SWIPE_NAVIGATION.map((option) => (
            <Text key={option.id} modifiers={[tag(option.id)]}>
              {option.title}
            </Text>
          ))}
        </Picker>
        <Toggle isOn={collapses} onIsOnChange={setCollapsesBottomBar} modifiers={modifierList(settingsSwitchStyle())}>
          <ExpoRowLabel title="Collapse Bottom Bar" systemImage="platter.filled.bottom.and.arrow.down.iphone" tint="bottomBar" />
        </Toggle>
      </Section>
      <AllowedSites />
    </Form>
  );
}

function AllowedSites() {
  const listed = useSitePermissions((s) => s.listed);
  const grants = useSitePermissions((s) => s.grants);
  useEffect(() => {
    void refreshSitePermissions();
  }, []);
  if (!listed) return null;
  return (
    <Section title="Camera, Microphone and Location" footer={<Text>Sites you allowed keep access on this iPhone until you revoke it. Private tabs always ask.</Text>}>
      {grants.length ? grants.map((grant) => <AllowedSite key={grant.origin} grant={grant} />) : <Text modifiers={[foregroundStyle(SECONDARY)]}>None</Text>}
    </Section>
  );
}

function AllowedSite({ grant }: { grant: SitePermissionGrant }) {
  const [asking, setAsking] = useState(false);
  const kinds = sortedPermissions(grant.permissions);
  const summary = permissionSummary(kinds);
  return (
    <ConfirmationDialog title={grant.host} isPresented={asking} onIsPresentedChange={setAsking} titleVisibility="visible">
      <ConfirmationDialog.Trigger>
        <SwipeActions>
          <Button onPress={() => setAsking(true)} modifiers={[tint("primary")]}>
            <HStack spacing={SITE_ROW_GAP} modifiers={[accessibilityElement("combine"), accessibilityHint("Revoke access")]}>
              <RNHostView matchContents>
                <View style={{ width: SITE_FAVICON, height: SITE_FAVICON }}>
                  <Favicon iconUrl={null} pageUrl={grant.origin} size={SITE_FAVICON} />
                </View>
              </RNHostView>
              <VStack alignment="leading" spacing={2} modifiers={[frame({ maxWidth: FILL, alignment: "leading" })]}>
                <Text>{grant.host}</Text>
                <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(SECONDARY)]}>{summary}</Text>
              </VStack>
            </HStack>
          </Button>
          <SwipeActions.Actions edge="trailing">
            <Button role="destructive" label="Revoke" onPress={() => void revokeSiteAccess(grant.origin)} />
          </SwipeActions.Actions>
        </SwipeActions>
      </ConfirmationDialog.Trigger>
      <ConfirmationDialog.Actions>
        {kinds.length > 1 ? kinds.map((kind) => <Button key={kind} role="destructive" label={`Revoke ${PERMISSION_NAMES[kind]}`} onPress={() => void revokeSiteAccess(grant.origin, kind)} />) : null}
        <Button role="destructive" label={kinds.length > 1 ? "Revoke All" : `Revoke ${summary}`} onPress={() => void revokeSiteAccess(grant.origin)} />
      </ConfirmationDialog.Actions>
      <ConfirmationDialog.Message>
        <Text>{`Allowed: ${summary}`}</Text>
      </ConfirmationDialog.Message>
    </ConfirmationDialog>
  );
}

const SITE_FAVICON = 22;
const SITE_ROW_GAP = 12;
