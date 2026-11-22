import { appIcons, currentAppIcon, setAppIcon, type AppIcon } from "../../state/app/appSettings";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { space } from "../ui/tokens";
import { PROFILE_COLORS } from "../ui/theme";
import { useWindowProfileValue } from "../../state/profiles/hooks";
import type { Settings } from "../../state/settings/settings";
import { ChoiceList, type ChoiceOption } from "./ChoiceList";
import { ThemePicker } from "../settings/ThemeEditor";
import { MockPanel, StylePanel, useScreen } from "./Screen";
import { liquidGlass, previewColor, previewLive, previewTheme, setOnboardingExtras, useOnboarding } from "../../state/onboarding/onboarding";
import { keysOf } from "../../state/onboarding/questions";
import { change, Page, useQuestion } from "./LayoutSteps";
import { OptionCard } from "./OptionCard";
import { OptionRow, useOnboardingCard } from "./Parts";
import { Slider } from "../settings/ThemeControls";
import { Text } from "../ui";
import { noteOnboardingStyle } from "../../state/telemetry/usage";
import { PAGE_FRAME, pageFrameInset } from "../../lib/windowLayout";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import { t } from "../../lib/uiLanguage";


const LOOK_KEYS = keysOf("look");

const APPEARANCE_CHOICES: ChoiceOption<Settings["appearance"]>[] = [
  { value: "auto", preview: "appearance-auto", title: t(`Automatic`), subtitle: `Light by day, dark by night, like your ${PLATFORM_TERMS.computer}` },
  { value: "light", preview: "appearance-light", title: t(`Light`), subtitle: t(`Always light`) },
  { value: "dark", preview: "appearance-dark", title: t(`Dark`), subtitle: t(`Always dark`) },
];
const SITE_COLOR_CHOICES: ChoiceOption<boolean>[] = [
  { value: true, preview: "sitecolor-on", title: t(`Take on the site's color`), subtitle: t(`The tab bar blends into the page`) },
  { value: false, preview: "sitecolor-off", title: t(`Keep my theme color`), subtitle: t(`The same color on every site`) },
];
const STYLE_CHOICES: ChoiceOption<Settings["interfaceStyle"]>[] = [
  { value: "glass", preview: "style-glass", title: t(`Liquid Glass`), subtitle: t(`Buttons and panels catch the light, as in Tahoe`) },
  { value: "classic", preview: "style-classic", title: t(`Classic`), subtitle: t(`Flat and quiet, as in Dia`) },
];
const BOOKMARKS_BAR: { value: Settings["bookmarksBar"]; title: string }[] = [
  { value: "always", title: t(`Always`) },
  { value: "newTab", title: t(`New Tab`) },
  { value: "never", title: t(`Never`) },
];
const APPEARANCE_LABEL = { auto: "automatic", light: t(`always light`), dark: t(`always dark`) } as const;
const FRAME_CHOICES: { value: number; title: string; subtitle: string }[] = [
  { value: PAGE_FRAME.default, title: t(`Framed`), subtitle: t(`Rounded corners with a little room around the page`) },
  { value: 4, title: t(`Thin`), subtitle: t(`A slim frame and softer corners`) },
  { value: 0, title: t(`Edge to edge`), subtitle: t(`No frame: the page meets the window and the sidebar`) },
];
const FRAME_VALUE_WIDTH = 40;
const framePicked = (frame: number) => (frame === PAGE_FRAME.default ? [] : frame === 0 ? [t(`Edge-to-edge page`)] : [`Page frame ${frame} pt`]);

export function LookStep() {
  const { id, focus } = useQuestion("look");
  const { values, mock } = useScreen(LOOK_KEYS);
  const { compact } = useOnboardingCard();
  const windowId = useOnboarding((s) => s.windowId) ?? "";
  const appIcon = useOnboarding((s) => s.extras.appIcon);
  const color = useWindowProfileValue(windowId, (p) => p?.color);
  const customTheme = useWindowProfileValue(windowId, (p) => !!p?.theme);
  const [icons, setIcons] = useState<{ list: AppIcon[]; current: string | null }>({ list: [], current: null });
  const preview = <MockPanel settings={mock} focus={focus.focus} />;
  useEffect(() => {
    previewLive({ appearance: values.appearance, extendWebsiteColor: values.extendWebsiteColor, ...(liquidGlass ? { interfaceStyle: values.interfaceStyle } : {}) });
    void Promise.all([appIcons(56), currentAppIcon()]).then(
      ([list, current]) => setIcons({ list, current }),
      () => {},
    );
  }, []);

  if (id === "appearance")
    return (
      <Page
        id={id}
        title={t(`Light or dark?`)}
        subtitle={t(`Incognito windows are always dark.`)}
        patch={{ appearance: values.appearance }}
        picked={[`Appearance ${APPEARANCE_LABEL[values.appearance]}`]}
        preview={preview}
      >
        <ChoiceList options={APPEARANCE_CHOICES} value={values.appearance} onChange={(appearance) => change({ appearance }, true)} mock={focus} />
      </Page>
    );
  if (id === "style")
    return (
      <Page
        id={id}
        title={t(`Glass or classic?`)}
        subtitle={t(`Change it any time in Settings › Appearance.`)}
        patch={{ interfaceStyle: values.interfaceStyle, glassTintWithTheme: values.glassTintWithTheme, glassTintAmount: values.glassTintAmount }}
        picked={values.interfaceStyle === "classic" ? [t(`Classic style`)] : values.glassTintWithTheme ? [`Glass tinted ${Math.round(values.glassTintAmount * 100)} %`] : []}
        preview={<StylePanel settings={mock} focus={focus.focus} />}
        onConfirm={() => noteOnboardingStyle(values.interfaceStyle, values.glassTintWithTheme)}
      >
        <ChoiceList options={STYLE_CHOICES} value={values.interfaceStyle} onChange={(interfaceStyle) => change({ interfaceStyle }, true)} mock={focus} />
        {values.interfaceStyle === "glass" ? (
          <View style={{ gap: compact ? space.m : space.ml }}>
            <OptionCard
              control="check"
              title={t(`Tint the glass with your color`)}
              subtitle={compact ? undefined : t(`Buttons and fields take on your theme color`)}
              selected={values.glassTintWithTheme}
              onPress={() => change({ glassTintWithTheme: !values.glassTintWithTheme }, true)}
            />
            {values.glassTintWithTheme ? (
              <Slider stacked label={t(`Tint amount`)} value={values.glassTintAmount} onChange={(v) => change({ glassTintAmount: Math.round(v * 100) / 100 }, true)} />
            ) : null}
          </View>
        ) : null}
      </Page>
    );
  if (id === "frame") {
    const frame = pageFrameInset(values);
    return (
      <Page
        id={id}
        title={t(`How much frame?`)}
        subtitle={t(`The room between the page and the window. Change it any time in Settings › Appearance.`)}
        patch={{ pageFrame: values.pageFrame, borderlessMode: values.borderlessMode }}
        picked={framePicked(frame)}
        preview={preview}
      >
        <View style={{ gap: space.ml }}>
          {FRAME_CHOICES.map((c) => (
            <OptionCard key={c.value} control="radio" title={c.title} subtitle={c.subtitle} selected={frame === c.value} onPress={() => change({ pageFrame: c.value, borderlessMode: false }, true)} />
          ))}
          <View style={{ marginTop: space.m }}>
            <Slider stacked label={t(`Thickness`)} value={frame / PAGE_FRAME.max} onChange={(v) => change({ pageFrame: Math.round(v * PAGE_FRAME.max), borderlessMode: false }, true)}>
              <Text size="small" tone="textSecondary" style={{ width: FRAME_VALUE_WIDTH, textAlign: "right" }}>
                {`${frame} pt`}
              </Text>
            </Slider>
          </View>
        </View>
      </Page>
    );
  }
  if (id === "siteColor")
    return (
      <Page
        id={id}
        title={t(`Let sites tint the tab bar?`)}
        subtitle={t(`Many sites have a color of their own.`)}
        patch={{ extendWebsiteColor: values.extendWebsiteColor }}
        picked={[]}
        preview={preview}
      >
        <ChoiceList options={SITE_COLOR_CHOICES} value={values.extendWebsiteColor} onChange={(extendWebsiteColor) => change({ extendWebsiteColor }, true)} mock={focus} />
      </Page>
    );
  if (id === "lookMore")
    return (
      <Page
        id={id}
        title={t(`A few finishing touches`)}
        subtitle={t(`All of these live in Settings too.`)}
        patch={{ hideToolbarWhileScrolling: values.hideToolbarWhileScrolling, bookmarksBar: values.bookmarksBar }}
        picked={[]}
        preview={preview}
        onConfirm={() => {
          if (appIcon && appIcon !== icons.current) void setAppIcon(appIcon);
        }}
      >
        <View style={{ gap: space.m }}>
          {icons.list.length > 1 ? (
            <OptionRow
              title={t(`App icon`)}
              value={appIcon ?? icons.current ?? icons.list[0]!.id}
              options={icons.list.map((i) => ({ value: i.id, title: i.name, image: i.preview }))}
              onChange={(id) => setOnboardingExtras({ appIcon: id })}
            />
          ) : null}
          <OptionCard
            control="check"
            title={t(`Hide toolbar while scrolling`)}
            subtitle={t(`Scroll up to bring it back`)}
            selected={values.hideToolbarWhileScrolling}
            onPress={() => change({ hideToolbarWhileScrolling: !values.hideToolbarWhileScrolling })}
          />
          <OptionRow title={t(`Bookmarks bar`)} value={values.bookmarksBar} options={BOOKMARKS_BAR} onChange={(bookmarksBar) => change({ bookmarksBar })} />
        </View>
      </Page>
    );
  const name = color ? PROFILE_COLORS[color]?.name : null;
  return (
    <Page id="color" title={t(`Pick a color`)} subtitle={t(`It tints the sidebar and the window.`)} patch={{}} picked={name ? [customTheme ? `${name} theme, edited` : `${name} theme`] : []} preview={preview}>
      <ThemePicker windowId={windowId} size={32} gap={space.xs} onPreset={previewColor} onTheme={previewTheme} />
    </Page>
  );
}
