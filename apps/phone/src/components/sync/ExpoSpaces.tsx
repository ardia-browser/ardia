import { useMemo, useState } from "react";
import { PlatformColor, StyleSheet, useWindowDimensions, View } from "react-native";
import { BottomSheet, Button, ContentUnavailableView, ContextMenu, DisclosureGroup, HStack, Host, Image, Label, List, Menu, Picker, RNHostView, Section, ShareLink, Spacer, TabView, Text, VStack, ZStack } from "@expo/ui/swift-ui";
import {
  accessibilityAddTraits,
  accessibilityElement,
  accessibilityHint,
  accessibilityLabel,
  backgroundOverlay,
  buttonBorderShape,
  buttonStyle,
  cornerRadius,
  dynamicTypeSize,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  listRowBackground,
  listRowInsets,
  listRowSeparator,
  listStyle,
  padding,
  presentationBackground,
  presentationCornerRadius,
  presentationDragIndicator,
  refreshable,
  scrollContentBackground,
  tabViewStyle,
  tag,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import type { PinnedSection, PinnedTile, SyncedProfile } from "../../platform/sync";
import { spaceTone } from "../../lib/profileLook";
import { haptics } from "../../state/app/haptics";
import { closeArchive, openArchive, useBrowse } from "../../state/browse/store";
import { copyLink } from "../../state/browse/tabMenus";
import { openSettings } from "../../state/settings/nav";
import { openRemote, selectProfile, syncNow } from "../../state/sync/actions";
import { useSelectedProfile, useSyncStatus, useSyncView } from "../../state/sync/hooks";
import { COLLAPSED_LIMIT, pinnedKeyAt, remoteTitle } from "../../state/sync/spaces";
import { showAllDeviceTabs, toggleSpaceRow, useSpaceOpenFor } from "../../state/sync/spaceOpen";
import { syncBanner, type BannerIcon } from "../../state/sync/syncRules";
import { countUsage } from "../../state/telemetry/telemetry";
import { DEFAULT_PROFILE_COLOR, expoSpacesLayout as L, Favicon, chromeSurface, contentMargins, GlassCircleButton, minListRowHeight, modifierList, PinnedTiles, PROFILE_PRESETS, settingsUIAvailable, spaceBackdrop, spaceColor, spaceMenuSymbol, SpacePageDots, spaceSymbol, SpaceTitle, useIncreasedContrast, useReduceMotion, useTheme } from "../ui";

const SECONDARY = { type: "hierarchical", style: "secondary" } as const;
const FILL = Number.MAX_SAFE_INTEGER;
const LARGE_TEXT = 1.35;
const BANNER_SYMBOLS: Record<BannerIcon, string> = { folder: "folder.badge.questionmark", lock: "lock.fill", reset: "exclamationmark.arrow.triangle.2.circlepath", warning: "exclamationmark.icloud", offline: "wifi.slash" };
const deviceSymbol = (kind: string, name: string) => (kind === "phone" ? "iphone" : /book/i.test(name) ? "laptopcomputer" : "desktopcomputer");
const SPACE_ROW = [listRowBackground("transparent"), listRowSeparator("hidden"), listRowInsets({ top: 0, leading: L.rowInset, bottom: 0, trailing: L.rowInset })];

const shareable = (url: string) => /^https?:\/\//i.test(url);
const lookOf = (profile: SyncedProfile | null) => ({ color: profile?.color ?? null, icon: profile?.icon ?? null, themeColors: profile?.theme?.colors ?? [], themeDarkColors: profile?.theme?.darkColors ?? null });
const shownColor = (color: { light: string; dark: string } | null, dark: boolean) => (color ? (dark ? color.dark : color.light) : null);

export function ExpoSpacesSheet() {
  const open = useBrowse((s) => s.sheet === "spaces");
  return (
    <Host testID="expoSpacesSheet" style={styles.anchor} pointerEvents="none">
      <BottomSheet isPresented={open} onIsPresentedChange={(presented) => (presented ? undefined : closeArchive())}>
        <SpacesSheetContent />
      </BottomSheet>
    </Host>
  );
}

function SpacesSheetContent() {
  const theme = useTheme();
  const contrast = useIncreasedContrast();
  const status = useSyncStatus();
  const view = useSyncView();
  const shown = useSelectedProfile();
  const [selection, setSelection] = useState(() => shown?.syncId ?? view.profiles[0]?.syncId ?? "");
  const profile = view.profiles.find((p) => p.syncId === selection) ?? view.profiles[0] ?? null;
  const tones = useMemo(() => spaceTone(profile, theme.dark, contrast, PROFILE_PRESETS, DEFAULT_PROFILE_COLOR), [profile, theme.dark, contrast]);
  const banner = syncBanner(status);
  const reduceMotion = useReduceMotion();
  const switchTo = (id: string, swiped: boolean) => {
    if (!id || id === profile?.syncId) return;
    setSelection(id);
    haptics.selection();
    if (swiped) countUsage("spaces_swiped");
    selectProfile(id);
  };
  const sheet = modifierList(
    settingsUIAvailable() ? spaceBackdrop({ ...lookOf(profile), animated: !reduceMotion }) : presentationBackground({ type: "linearGradient", colors: tones.length > 1 ? tones : [...tones, ...tones], startPoint: { x: 0.5, y: 0 }, endPoint: { x: 0.5, y: 1 } }),
    presentationCornerRadius(L.sheetRadius),
    presentationDragIndicator("hidden"),
  );
  return (
    <VStack spacing={0} modifiers={sheet}>
      <SpacesHeader profiles={view.profiles} current={profile} onSelect={(id) => switchTo(id, false)} />
      {banner ? (
        <HStack alignment="firstTextBaseline" spacing={L.bannerGap} modifiers={[padding({ all: L.bannerPadding }), backgroundOverlay({ color: theme.tertiaryFill }), cornerRadius(L.bannerRadius), padding({ horizontal: L.page, bottom: L.tight })]}>
          <Image systemName={BANNER_SYMBOLS[banner.icon] as never} color={PlatformColor("systemOrange")} />
          <Text modifiers={[font({ textStyle: "subheadline" })]}>{banner.text}</Text>
          <Spacer minLength={8} />
          {banner.needsAction ? <Button label="Fix" onPress={() => openSettings({ page: "sync" })} modifiers={[font({ textStyle: "subheadline", weight: "semibold" }), buttonStyle("bordered")]} /> : null}
        </HStack>
      ) : null}
      {profile ? (
        <ZStack alignment="bottom">
          <TabView selection={profile.syncId} onSelectionChange={(id) => switchTo(id, true)} modifiers={[tabViewStyle({ type: "page", indexDisplayMode: "never" })]}>
            {view.profiles.map((page) => (
              <TabView.Tab key={page.syncId} value={page.syncId}>
                <SpacePage profile={page} dotsBelow={view.profiles.length > 1} />
              </TabView.Tab>
            ))}
          </TabView>
          {view.profiles.length > 1 ? <SpacePageDots count={view.profiles.length} index={view.profiles.indexOf(profile)} modifiers={modifierList(padding({ horizontal: L.dotsPadding }), frame({ height: L.dotsHeight }), chromeSurface({ shape: "capsule", interactive: false }), padding({ top: L.tight }))} /> : null}
        </ZStack>
      ) : (
        <ContentUnavailableView
          title="Your Mac’s Spaces"
          systemImage="macbook.and.iphone"
          description={status.phase === "off" ? "Every tab, anywhere." : "Waiting for your Mac."}
          modifiers={[frame({ maxHeight: FILL })]}
          actions={<Button label={status.phase === "off" ? "Sync With Mac" : "Sync Settings"} onPress={() => openSettings({ page: status.phase === "off" ? "syncConnect" : "sync" })} modifiers={[buttonStyle("borderedProminent"), buttonBorderShape("roundedRectangle", 12)]} />}
        />
      )}
    </VStack>
  );
}

function SpacesHeader({ profiles, current, onSelect }: { profiles: SyncedProfile[]; current: SyncedProfile | null; onSelect: (id: string) => void }) {
  const title = current?.name ?? "Spaces";
  return (
    <HStack spacing={L.headerGap} modifiers={[padding({ leading: L.headerLeading, trailing: L.page, top: L.small, bottom: L.tight })]}>
      {current && profiles.length > 1 ? (
        <Menu label={<SpaceTitle name={title} showsChevron {...lookOf(current)} />} modifiers={[buttonStyle("plain"), accessibilityLabel(`Space, ${title}`), accessibilityHint("Shows your Mac’s spaces.")]}>
          <Picker label="Space" selection={current.syncId} onSelectionChange={(id: string) => onSelect(id)}>
            {profiles.map((space) => (
              <Label key={space.syncId} title={space.name} systemImage={(spaceMenuSymbol(space.name, space.icon) ?? "square.stack") as never} modifiers={[tag(space.syncId)]} />
            ))}
          </Picker>
        </Menu>
      ) : current ? (
        <SpaceTitle name={title} showsChevron={false} {...lookOf(current)} modifiers={[accessibilityElement("combine"), accessibilityAddTraits(["isHeader"])]} />
      ) : (
        <Text modifiers={[font({ textStyle: "headline" }), accessibilityAddTraits(["isHeader"])]}>{title}</Text>
      )}
      <Spacer />
      <HStack spacing={L.headerGap} modifiers={[dynamicTypeSize({ max: "xxxLarge" })]}>
        <GlassCircleButton symbol="archivebox" label="Archive" diameter={L.headerCircle} onPress={openArchive} />
        <GlassCircleButton symbol="xmark" label="Close" diameter={L.headerCircle} onPress={closeArchive} />
      </HStack>
    </HStack>
  );
}

function SpacePage({ profile, dotsBelow }: { profile: SyncedProfile; dotsBelow: boolean }) {
  const remembered = useSpaceOpenFor(profile.syncId);
  const open = useMemo(() => new Set(remembered.open), [remembered.open]);
  const expanded = useMemo(() => new Set(remembered.expanded), [remembered.expanded]);
  const devices = profile.deviceTabs.filter((device) => device.tabs.length > 0);
  const pinnedEmpty = profile.pinned.tiles.length === 0 && profile.pinned.sections.length === 0;
  const go = (url: string, title: string, pinnedKey: string | null = null) => openRemote(url, title, profile.syncId, pinnedKey);
  return (
    <List modifiers={modifierList(listStyle("plain"), scrollContentBackground("hidden"), minListRowHeight(L.rowHeight), refreshable(() => syncNow().then(() => undefined)), dotsBelow ? contentMargins({ edges: "bottom", length: L.dotsHeight + L.tight }) : null)}>
      {profile.pinned.tiles.length ? <PinnedTileRows tiles={profile.pinned.tiles} open={go} /> : null}
      {profile.pinned.sections.map((section) => (
        <PinnedSectionRow key={section.tab?.key ?? section.group?.key} profileId={profile.syncId} section={section} openGroups={open} open={go} />
      ))}
      {devices.map((device) => {
        const all = expanded.has(device.deviceId) || device.tabs.length <= COLLAPSED_LIMIT + 1;
        return (
          <Section
            key={device.deviceId}
            header={<Label title={device.deviceName} systemImage={deviceSymbol(device.kind, device.deviceName) as never} modifiers={[font({ textStyle: "footnote", weight: "semibold" }), foregroundStyle(SECONDARY), padding({ top: L.small })]} />}
          >
            {(all ? device.tabs : device.tabs.slice(0, COLLAPSED_LIMIT)).map((tab, index) => (
              <RemoteRow key={`${device.deviceId}:${index}`} title={tab.title} url={tab.url} symbol={null} open={go} />
            ))}
            {all ? null : (
              <Button onPress={() => showAllDeviceTabs(profile.syncId, device.deviceId)} modifiers={[buttonStyle("plain"), ...SPACE_ROW]}>
                <Text modifiers={[font({ textStyle: "subheadline", weight: "semibold" }), foregroundStyle(SECONDARY), frame({ maxWidth: FILL, minHeight: L.showAllHeight, alignment: "leading" })]}>Show All</Text>
              </Button>
            )}
          </Section>
        );
      })}
      {pinnedEmpty && devices.length === 0 ? (
        <ContentUnavailableView title="Nothing Here Yet" systemImage="square.stack" description={`Pinned and open tabs from ${profile.name} show up here.`} modifiers={[...SPACE_ROW, padding({ top: L.section })]} />
      ) : null}
    </List>
  );
}

function PinnedTileRows({ tiles, open }: { tiles: PinnedTile[]; open: (url: string, title: string, pinnedKey: string | null) => void }) {
  return (
    <PinnedTiles
      tiles={tiles.map((tile) => ({ key: tile.key, title: tile.title, url: tile.url, icon: tile.icon, folder: tile.folder?.map((tab) => ({ key: tab.key, title: tab.title, url: tab.url })) ?? null }))}
      onOpen={({ url, title }) => open(url, title, pinnedKeyAt(tiles, url))}
      modifiers={[listRowBackground("transparent"), listRowSeparator("hidden"), listRowInsets({ top: L.tight, leading: L.rowInset, bottom: L.small, trailing: L.rowInset })]}
    />
  );
}

function PinnedSectionRow({ profileId, section, openGroups, open }: { profileId: string; section: PinnedSection; openGroups: ReadonlySet<string>; open: (url: string, title: string, pinnedKey: string | null) => void }) {
  const dark = useTheme().dark;
  if (section.tab) return <RemoteRow title={section.tab.title} url={section.tab.url} symbol={section.tab.icon} pinnedKey={section.tab.key} open={open} />;
  const group = section.group;
  if (!group) return null;
  const key = `group:${group.key}`;
  return (
    <DisclosureGroup isExpanded={openGroups.has(key)} onIsExpandedChange={() => toggleSpaceRow(profileId, key)} modifiers={[tint(PlatformColor("secondaryLabel")), ...SPACE_ROW]}>
      <DisclosureGroup.Label>
        <HStack spacing={L.small} modifiers={[frame({ minHeight: L.rowHeight })]}>
          <Image systemName={(spaceSymbol(group.icon) ?? "folder.fill") as never} color={shownColor(spaceColor(group.color), dark) ?? PlatformColor("secondaryLabel")} modifiers={[font({ textStyle: "body" }), frame({ minWidth: L.icon })]} />
          <Text modifiers={[font({ textStyle: "body", weight: "medium" }), lineLimit(2)]}>{group.name}</Text>
        </HStack>
      </DisclosureGroup.Label>
      {group.items.map((item) => (
        <PinnedSectionRow key={item.tab?.key ?? item.group?.key} profileId={profileId} section={item} openGroups={openGroups} open={open} />
      ))}
    </DisclosureGroup>
  );
}

function RemoteRow({ title, url, symbol, pinnedKey = null, open }: { title: string; url: string; symbol: string | null; pinnedKey?: string | null; open: (url: string, title: string, pinnedKey: string | null) => void }) {
  const { fontScale } = useWindowDimensions();
  const iconSide = L.icon * fontScale;
  const shownTitle = remoteTitle(title, url);
  const go = () => open(url, title, pinnedKey);
  return (
    <ContextMenu modifiers={SPACE_ROW}>
      <ContextMenu.Trigger>
        <Button onPress={go} modifiers={[buttonStyle("plain")]}>
          <HStack spacing={L.small} modifiers={[frame({ minHeight: L.rowHeight })]}>
            {spaceSymbol(symbol) ? (
              <Image systemName={spaceSymbol(symbol) as never} color={PlatformColor("secondaryLabel")} modifiers={[font({ textStyle: "body" }), frame({ width: iconSide, height: iconSide })]} />
            ) : (
              <RNHostView matchContents>
                <View style={{ width: iconSide, height: iconSide, alignItems: "center", justifyContent: "center" }}>
                  <Favicon iconUrl={null} pageUrl={url} size={Math.min(iconSide, L.iconMax) - 2} />
                </View>
              </RNHostView>
            )}
            <Text modifiers={[font({ textStyle: "body", weight: "medium" }), lineLimit(fontScale >= LARGE_TEXT ? 3 : 1), frame({ maxWidth: FILL, alignment: "leading" })]}>{shownTitle}</Text>
          </HStack>
        </Button>
      </ContextMenu.Trigger>
      <ContextMenu.Items>
        <Button label="Open" systemImage="arrow.up.forward.square" onPress={go} />
        {shareable(url) ? <Button label="Copy Link" systemImage="link" onPress={() => copyLink(url)} /> : null}
        {shareable(url) ? (
          <ShareLink item={url}>
            <Label title="Share" systemImage="square.and.arrow.up" />
          </ShareLink>
        ) : null}
      </ContextMenu.Items>
    </ContextMenu>
  );
}

const styles = StyleSheet.create({
  anchor: { position: "absolute", width: 0, height: 0 },
});
