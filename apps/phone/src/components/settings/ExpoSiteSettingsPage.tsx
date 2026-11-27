import { useEffect, useState } from "react";
import { PlatformColor, View } from "react-native";
import { Button, ConfirmationDialog, Form, HStack, LabeledContent, NavigationLink, Picker, RNHostView, Section, SwipeActions, Text, Toggle, VStack } from "@expo/ui/swift-ui";
import { accessibilityElement, accessibilityHint, accessibilityLabel, accessibilityValue, buttonStyle, disabled, font, foregroundStyle, frame, labelStyle, monospacedDigit, navigationBarTitleDisplayMode, navigationTitle, pickerStyle, tag, tint } from "@expo/ui/swift-ui/modifiers";
import { bottomBarCollapses } from "../../lib/barCollapse";
import { permissionSummary, PERMISSION_NAMES, sortedPermissions } from "../../lib/sitePermissionNames";
import { setBlockingCategory, setCollapsesBottomBar, setDefaultNightShade, setSwipeNavigation, useBlocking, useEngines } from "../../state/settings/actions";
import { usePreferences } from "../../state/settings/hooks";
import { settingsRouteKey } from "../../state/settings/nav";
import { formatNumber } from "../../state/settings/settingsRules";
import { refreshSitePermissions, revokeSiteAccess, useSitePermissions } from "../../state/settings/sitePermissions";
import type { SitePermissionGrant } from "../../platform/pages";
import { contentMargins, Favicon, modifierList, neverBounces, settingsChrome, settingsLayout, settingsSwitchStyle, useDesign } from "../ui";
import { ExpoRowText } from "./ExpoRowLabel";
import { NIGHT_SHADE, SITE_DEFAULTS_FOOTER, SWIPE_NAVIGATION } from "./SitePages";
import { THIS_SITE_FOOTER, useThisSite } from "./ThisSite";
import { resetZoom, setDesktopSite, setNightShadeOn, zoomIn, zoomOut } from "../../state/page/actions";

const SECONDARY = { type: "hierarchical", style: "secondary" } as const;
const ZOOM_GAP = 16;
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
    <Form modifiers={modifierList(navigationTitle("Site settings"), navigationBarTitleDisplayMode("inline"), tint(PlatformColor("systemBlue")), settingsChrome(), neverBounces(), contentMargins({ edges: "top", length: settingsLayout.expoListTop }))}>
      <ExpoThisSite />
      <Section title="Content blocking">
        <Toggle isOn={state?.blocksAds ?? true} onIsOnChange={(on) => setBlockingCategory("ads", on)} modifiers={modifierList(settingsSwitchStyle())}>
          <ExpoRowText title="Block ads" />
        </Toggle>
        <Toggle isOn={state?.blocksTrackers ?? true} onIsOnChange={(on) => setBlockingCategory("trackers", on)} modifiers={modifierList(settingsSwitchStyle())}>
          <ExpoRowText title="Block trackers" />
        </Toggle>
        <Toggle isOn={state?.hidesCookieBanners ?? true} onIsOnChange={(on) => setBlockingCategory("cookieBanners", on)} modifiers={modifierList(settingsSwitchStyle())}>
          <ExpoRowText title="Block cookie banners" />
        </Toggle>
        <NavigationLink value={settingsRouteKey({ page: "filterLists" })}>
          <LabeledContent label={<ExpoRowText title="Filter lists" description="Extra filter lists for the blocker." />}>
            <Text>{formatNumber(enabledLists)}</Text>
          </LabeledContent>
        </NavigationLink>
        <NavigationLink value={settingsRouteKey({ page: "trustedSites" })}>
          <LabeledContent label={<ExpoRowText title="Trusted sites" description="Sites that load without blocking." />}>
            <Text>{trusted ? formatNumber(trusted) : "None"}</Text>
          </LabeledContent>
        </NavigationLink>
      </Section>
      <Section title="Browsing" footer={<Text>{SITE_DEFAULTS_FOOTER}</Text>}>
        <Picker label={<ExpoRowText title="Night Shade" description="Darkens light pages." />} selection={nightShade} onSelectionChange={setDefaultNightShade} modifiers={[pickerStyle("menu"), tint("secondary")]}>
          {NIGHT_SHADE.map((option) => (
            <Text key={option.id} modifiers={[tag(option.id)]}>
              {option.title}
            </Text>
          ))}
        </Picker>
        <Picker label={<ExpoRowText title="Swipe to navigate" />} selection={swipe} onSelectionChange={setSwipeNavigation} modifiers={[pickerStyle("menu"), tint("secondary")]}>
          {SWIPE_NAVIGATION.map((option) => (
            <Text key={option.id} modifiers={[tag(option.id)]}>
              {option.title}
            </Text>
          ))}
        </Picker>
        <Toggle isOn={collapses} onIsOnChange={setCollapsesBottomBar} modifiers={modifierList(settingsSwitchStyle())}>
          <ExpoRowText title="Collapse bottom bar" description="Shrinks the bar while you scroll down a page." />
        </Toggle>
      </Section>
      <AllowedSites />
    </Form>
  );
}

function ExpoThisSite() {
  const site = useThisSite();
  if (!site) return null;
  const { host, model } = site;
  return (
    <Section title={host} footer={<Text>{THIS_SITE_FOOTER}</Text>}>
      <Toggle isOn={model.nightShadeOn} onIsOnChange={setNightShadeOn} modifiers={modifierList(settingsSwitchStyle(), disabled(!model.siteSwitches))}>
        <ExpoRowText title="Night Shade" />
      </Toggle>
      <LabeledContent label={<ExpoRowText title="Page zoom" />}>
        <HStack spacing={ZOOM_GAP}>
          <Button systemImage="minus" label="Zoom Out" onPress={zoomOut} modifiers={[buttonStyle("borderless"), labelStyle("iconOnly"), disabled(!model.zoomOut)]} />
          <Button onPress={resetZoom} modifiers={[buttonStyle("borderless"), accessibilityLabel("Reset Zoom"), accessibilityValue(model.zoomPercent), disabled(!model.isWebPage)]}>
            <Text modifiers={[font({ textStyle: "body" }), monospacedDigit(), foregroundStyle(SECONDARY)]}>{model.zoomPercent}</Text>
          </Button>
          <Button systemImage="plus" label="Zoom In" onPress={zoomIn} modifiers={[buttonStyle("borderless"), labelStyle("iconOnly"), disabled(!model.zoomIn)]} />
        </HStack>
      </LabeledContent>
      <Toggle isOn={model.desktopSite} onIsOnChange={setDesktopSite} modifiers={modifierList(settingsSwitchStyle())}>
        <ExpoRowText title="Desktop site" />
      </Toggle>
    </Section>
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
    <Section title="Camera, microphone and location" footer={<Text>Sites you allowed keep access on this iPhone until you revoke it. Private tabs always ask.</Text>}>
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
