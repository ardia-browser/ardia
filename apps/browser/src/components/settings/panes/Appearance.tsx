import type { AppIcon } from "../../../state/app/appSettings";
import { Box, GlassFill, PopUp, radius, space, Text, Toggle, type Option } from "../../ui";
import { Image, View } from "react-native";
import { useTheme } from "../../ui/theme";
import { useSettings } from "../../../state/browser/hooks";
import { chooseAddressBar, chooseCommandBarPlacement, updateSettings } from "../../../state/settings/actions";
import { keyText } from "../../../state/commands/keyText";
import { AddressBarPreview, CommandBarPreview } from "../ChoicePreviews";
import { SwitchingTabsSection } from "./SwitchingTabs";
import type { Settings } from "../../../state/settings/settings";
import { Anchor, FormField, Group, Row, SectionHeader, SettingToggle, useHiddenSetting } from "../Form";
import { MiniWindow } from "../MiniWindow";
import { PictureChoice } from "../PictureChoice";
import { setting, type SettingId } from "../settingsIndex";
import { PAGE_FRAME } from "../../../lib/windowLayout";
import { FrameSlider, TabCornersSlider } from "./FrameSlider";
import { BookmarksBarRow } from "./BookmarksBarSection";
import { InterfaceSizeControl } from "./InterfaceSize";
import { WindowButtonsPicker } from "./WindowButtonsPicker";
import { modePreview, stylePreview } from "../tokens";
import { APP_ICON_SIZE, appIconChoices, chooseAppIcon } from "../../../state/settings/paneData";
import { useResource } from "../../../state/settings/resources";
import { useSidebarHighContrast } from "../../../state/sidebar/textLook";
import { perLook } from "../../ui/tokens";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import type { SettingsPlace } from "../../../state/settings/settingsWindows";
import { t } from "../../../lib/uiLanguage";


const ADDRESS_BAR_IN_MENU = PLATFORM_FEATURES.menuBar ? t(`Also in View › Show Address Bar in Sidebar.`) : "";

const MODES: { value: Settings["appearance"]; title: string; description: string }[] = [
  { value: "auto", title: t(`Automatic`), description: t(`Follow the system appearance setting`) },
  { value: "light", title: t(`Light`), description: t(`Use the light application appearance`) },
  { value: "dark", title: t(`Dark`), description: t(`Use the dark application appearance`) },
];

const STYLES: { value: Settings["interfaceStyle"]; title: string }[] = [
  { value: "glass", title: t(`Glass`) },
  { value: "classic", title: t(`Classic`) },
];

const GLOWS: Option<Settings["selectedTabGlow"]>[] = [
  { value: "full", title: t(`Full`) },
  { value: "soft", title: t(`Soft`) },
  { value: "off", title: t(`Off`) },
];

const SELECTED_TOP_APP: Option<Settings["selectedTopApp"]>[] = [
  { value: "ring", title: t(`Ring`) },
  { value: "fill", title: t(`Fill only`) },
  { value: "outline", title: t(`Outline only`) },
];

const SIDEBAR_TEXT_SIZES: Option<Settings["sidebarTextSize"]>[] = [
  { value: "default", title: t(`Default`) },
  { value: "large", title: t(`Large`) },
  { value: "larger", title: t(`Larger`) },
];

const ADDRESS_BAR: { value: Settings["addressBar"]; title: string; caption: string }[] = [
  { value: "toolbar", title: t(`In the toolbar`), caption: t(`Above the page, with its buttons.`) },
  { value: "sidebar", title: t(`In the sidebar`), caption: t(`Above your tabs; the page gets more room.`) },
];

type CommandBarPlace = "field" | "centred";

const COMMAND_BAR_PLACES: { value: CommandBarPlace; title: string; caption: string }[] = [
  { value: "field", title: t(`At the address`), caption: t(`Opens where the address is, like Chrome.`) },
  { value: "centred", title: t(`In the center`), caption: t(`Floats over the page, like Arc.`) },
];

const ADDRESS_BAR_BUTTONS: Option<Settings["addressBarButtons"]>[] = [
  { value: "hover", title: t(`Show on hover`) },
  { value: "always", title: t(`Always show`) },
];

type FullScreenFrame = "keep" | "remove" | "tabsHidden";

const FULL_SCREEN_FRAME: Option<FullScreenFrame>[] = [
  { value: "keep", title: t(`Keep frame`) },
  { value: "remove", title: t(`Remove`) },
  { value: "tabsHidden", title: t(`Remove when tabs are hidden`) },
];

const FULL_SCREEN_PATCH: Record<FullScreenFrame, Pick<Settings, "pageFrameZeroInFullScreen" | "pageFrameZeroWhenTabsHidden">> = {
  keep: { pageFrameZeroInFullScreen: false, pageFrameZeroWhenTabsHidden: false },
  remove: { pageFrameZeroInFullScreen: true, pageFrameZeroWhenTabsHidden: true },
  tabsHidden: { pageFrameZeroInFullScreen: false, pageFrameZeroWhenTabsHidden: true },
};

export function AppearancePane(_place: SettingsPlace) {
  return (
    <View>
      <LookSection />
      <WindowButtonsPicker />
      <SizeAndTextSection />
      <SwitchingTabsSection />
      <ToolbarSection />
      <PageFrameSection />
    </View>
  );
}

function LookSection() {
  const appearance = useSettings((s) => s.appearance);
  const style = useSettings((s) => s.interfaceStyle);
  const glow = useSettings((s) => s.selectedTabGlow);
  const topApp = useSettings((s) => s.selectedTopApp);
  return (
    <>
      <SectionHeader title={t(`Look`)} />
      <Box gap="xl">
        <Anchor id="appearance.theme" shape="card">
          <FormField label={setting("appearance.theme").title}>
            <Box row gap="xl">
              {MODES.map((m) => (
                <ModeChoice key={m.value} mode={m.value} title={m.title} description={m.description} selected={appearance === m.value} onPress={() => updateSettings({ appearance: m.value })} />
              ))}
            </Box>
          </FormField>
        </Anchor>
        <Anchor id="appearance.interfaceStyle" shape="card">
          <FormField label={setting("appearance.interfaceStyle").title}>
            <Box row gap="xl">
              {STYLES.map((s) => (
                <StyleChoice key={s.value} value={s.value} title={s.title} selected={style === s.value} onPress={() => updateSettings({ interfaceStyle: s.value })} />
              ))}
            </Box>
          </FormField>
        </Anchor>
        <Group>
          <GlassTintRow anchor="appearance.glassTint" />
          <SettingToggle anchor="appearance.elementOutlines" />
          <SettingToggle anchor="appearance.extendWebsiteColor" />
          <Row anchor="appearance.selectedTabGlow">
            <PopUp value={glow} options={GLOWS} onChange={(v) => updateSettings({ selectedTabGlow: v })} minWidth={120} />
          </Row>
          <Row anchor="appearance.selectedTopApp">
            <PopUp value={topApp} options={SELECTED_TOP_APP} onChange={(v) => updateSettings({ selectedTopApp: v })} minWidth={120} />
          </Row>
        </Group>
        <AppIconPicker />
      </Box>
    </>
  );
}

function GlassTintRow({ anchor }: { anchor: SettingId }) {
  const tinted = useSettings((s) => s.glassTintWithTheme);
  const amount = useSettings((s) => s.glassTintAmount);
  const shown = tinted ? amount : 0;
  const percent = Math.round(shown * 100);
  return (
    <Row anchor={anchor}>
      <FrameSlider
        position={shown}
        tooltip={`${percent} %`}
        label={percent === 0 ? t(`Off`) : `${percent} %`}
        onChange={(v) => {
          const next = Math.round(v * 100) / 100;
          updateSettings(next === 0 ? { glassTintWithTheme: false } : { glassTintWithTheme: true, glassTintAmount: next });
        }}
      />
    </Row>
  );
}

function SizeAndTextSection() {
  const size = useSettings((s) => s.sidebarTextSize);
  const highContrast = useSidebarHighContrast();
  return (
    <>
      <SectionHeader title={t(`Size and text`)} />
      <Group>
        <Row anchor="appearance.interfaceScale">
          <InterfaceSizeControl />
        </Row>
        <Row anchor="appearance.sidebarTextSize">
          <PopUp value={size} options={SIDEBAR_TEXT_SIZES} onChange={(v) => updateSettings({ sidebarTextSize: v })} minWidth={120} />
        </Row>
        <Row anchor="appearance.sidebarTextContrast">
          <Toggle value={highContrast} accessibilityLabel={t(`Higher contrast sidebar text`)} onChange={(on) => updateSettings({ sidebarTextContrast: on ? "high" : "standard" })} />
        </Row>
      </Group>
    </>
  );
}

function ToolbarSection() {
  const addressBar = useSettings((s) => s.addressBar);
  const compactToolbar = useSettings((s) => s.compactToolbar);
  const placement = useSettings((s) => s.commandBarPlacement);
  const buttons = useSettings((s) => s.addressBarButtons);
  const minimal = useSettings((s) => s.minimalismMode);
  const place: CommandBarPlace = placement === "field" ? "field" : "centred";
  const addressBarFixed = useHiddenSetting()(setting("appearance.addressBar"));
  const fieldIn = addressBar === "sidebar" && !addressBarFixed ? "sidebar" : "toolbar";
  return (
    <>
      <SectionHeader title={t(`Toolbar`)} />
      <Box gap="xl">
        <Anchor id="appearance.addressBar" shape="card">
          <FormField label={setting("appearance.addressBar").title}>
            <Box row gap="xl" accessibilityRole="radiogroup">
              {ADDRESS_BAR.map((a) => (
                <PictureChoice key={a.value} title={a.title} caption={a.caption} selected={fieldIn === a.value} onPress={() => chooseAddressBar(a.value)} size="l">
                  <AddressBarPreview addressBar={a.value} />
                </PictureChoice>
              ))}
            </Box>
            {ADDRESS_BAR_IN_MENU ? (
              <Text size="caption" tone="textTertiary" style={MENU_NOTE}>
                {ADDRESS_BAR_IN_MENU}
              </Text>
            ) : null}
          </FormField>
        </Anchor>
        <Anchor id="appearance.commandBarPlacement" shape="card">
          <FormField label={setting("appearance.commandBarPlacement").title}>
            <Box row gap="xl" accessibilityRole="radiogroup">
              {COMMAND_BAR_PLACES.map((c) => (
                <PictureChoice key={c.value} title={c.title} caption={c.caption} selected={place === c.value} onPress={() => place !== c.value && chooseCommandBarPlacement(c.value)} size="l">
                  <CommandBarPreview placement={c.value} addressBar={fieldIn} />
                </PictureChoice>
              ))}
            </Box>
            {minimal ? (
              <Text size="caption" tone="textTertiary" style={MENU_NOTE}>
                {`Minimalism mode hides the address, so ${keyText("⌘L")} opens in the center while it’s on.`}
              </Text>
            ) : null}
          </FormField>
        </Anchor>
        <Group>
          <Row anchor="appearance.commandBarOnClick">
            <Toggle value={placement === "centredOnClick"} accessibilityLabel={setting("appearance.commandBarOnClick").title} onChange={(on) => updateSettings({ commandBarPlacement: on ? "centredOnClick" : "centred" })} />
          </Row>
          <Row anchor="appearance.compactToolbar">
            <Toggle value={compactToolbar} onChange={(v) => updateSettings({ compactToolbar: v })} />
          </Row>
          <Row anchor="appearance.addressBarButtons">
            <PopUp value={buttons} options={ADDRESS_BAR_BUTTONS} onChange={(v) => updateSettings({ addressBarButtons: v })} minWidth={160} />
          </Row>
          <SettingToggle anchor="appearance.minimalismMode" />
          <BookmarksBarRow />
        </Group>
      </Box>
    </>
  );
}

const MENU_NOTE = { marginTop: space.m, textAlign: "center" } as const;

const fullScreenFrameOf = (zeroInFullScreen: boolean, zeroWhenTabsHidden: boolean): FullScreenFrame => (zeroInFullScreen ? "remove" : zeroWhenTabsHidden ? "tabsHidden" : "keep");

function PageFrameSection() {
  const frame = useSettings((s) => s.pageFrame);
  const borderless = useSettings((s) => s.borderlessMode);
  const zeroInFullScreen = useSettings((s) => s.pageFrameZeroInFullScreen);
  const zeroWhenTabsHidden = useSettings((s) => s.pageFrameZeroWhenTabsHidden);
  const shown = borderless ? 0 : frame;
  return (
    <>
      <SectionHeader title={t(`Page frame`)} />
      <Group>
        <Row anchor="appearance.pageFrame">
          <FrameSlider
            position={shown / PAGE_FRAME.max}
            tooltip={`${shown} pt`}
            label={shown === 0 ? t(`None`) : `${shown} pt`}
            onChange={(v) => {
              const next = Math.round(v * PAGE_FRAME.max);
              updateSettings(next === 0 ? { borderlessMode: true } : { borderlessMode: false, pageFrame: next });
            }}
          />
        </Row>
        <Row anchor="appearance.fullScreenFrame">
          <PopUp value={fullScreenFrameOf(zeroInFullScreen, zeroWhenTabsHidden)} options={FULL_SCREEN_FRAME} onChange={(v) => updateSettings(FULL_SCREEN_PATCH[v])} minWidth={220} />
        </Row>
        <Row anchor="appearance.tabCornerRadius">
          <TabCornersSlider />
        </Row>
      </Group>
    </>
  );
}

function StyleChoice({ value, title, selected, onPress }: { value: Settings["interfaceStyle"]; title: string; selected: boolean; onPress: () => void }) {
  const theme = useTheme();
  const look = stylePreview[theme.dark ? "dark" : "light"];
  const glass = value === "glass";
  return (
    <PictureChoice title={title} selected={selected} onPress={onPress} size="m">
      <MiniWindow layout="none" look={{ window: look.backdrop, bar: look.tile, page: look.tile }}>
        <Box row gap="m" pad="xs" style={STYLE_TILES}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={[STYLE_TILE(), glass ? null : { backgroundColor: look.tile, borderWidth: 1, borderColor: look.tileStroke }]}>
              {glass ? <GlassFill radius={radius.tile} state={i === 0 ? "active" : "rest"} /> : null}
            </View>
          ))}
        </Box>
      </MiniWindow>
    </PictureChoice>
  );
}

const STYLE_TILES = { flex: 1 } as const;
const STYLE_TILE = perLook(() => ({ flex: 1, alignSelf: "flex-start", height: 30, borderRadius: radius.tile }) as const);

function AppIconPicker() {
  const [choices] = useResource(appIconChoices);
  const icons = choices?.icons ?? [];
  const current = choices?.current ?? null;
  if (icons.length < 2) return null;
  return (
    <Anchor id="appearance.appIcon" shape="card">
      <FormField label={setting("appearance.appIcon").title}>
        <View style={ICON_GRID}>
          {icons.map((icon) => (
            <IconChoice key={icon.id} icon={icon} selected={icon.id === current} onPress={() => chooseAppIcon(icon.id)} />
          ))}
        </View>
      </FormField>
    </Anchor>
  );
}

const ICON_GRID = { flexDirection: "row", flexWrap: "wrap", columnGap: space.s, rowGap: space.ml } as const;
const ICON_IMAGE = { width: APP_ICON_SIZE, height: APP_ICON_SIZE } as const;

function IconChoice({ icon, selected, onPress }: { icon: AppIcon; selected: boolean; onPress: () => void }) {
  return (
    <PictureChoice title={icon.name} selected={selected} onPress={onPress} tooltip={icon.name} size="icon">
      {icon.preview ? <Image source={{ uri: icon.preview }} style={ICON_IMAGE} /> : null}
    </PictureChoice>
  );
}

function ModeChoice({ mode, title, description, selected, onPress }: { mode: Settings["appearance"]; title: string; description: string; selected: boolean; onPress: () => void }) {
  const window = (dark: boolean) => {
    const look = modePreview[dark ? "dark" : "light"];
    return <MiniWindow layout="side" look={{ window: look.window, bar: look.line, page: look.page }} />;
  };
  return (
    <PictureChoice title={title} selected={selected} onPress={onPress} tooltip={description} size="m">
      {mode === "auto" ? (
        <>
          {window(false)}
          {window(true)}
        </>
      ) : (
        window(mode === "dark")
      )}
    </PictureChoice>
  );
}
