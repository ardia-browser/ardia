import { Pressable, StyleSheet, Text, View } from "react-native";
import { resetZoom, setDesktopSite, setNightShadeOn, siteSettingsInMenu, zoomIn, zoomOut } from "../../state/page/actions";
import { useMenuModel } from "../../state/page/hooks";
import type { MenuModel } from "../../state/page/pageMenu";
import { usePageUi } from "../../state/page/store";
import { usePages } from "../../state/pages/store";
import { display } from "../../state/search/omnibox";
import { useTabs } from "../../state/tabs/store";
import { useSelectedTabId } from "../../state/tabs/hooks";
import { font, MaterialIconButton, settingsLayout, settingsTint, smoothCorners, Symbol, useDesign, usePressStyle, useTheme, type PressKind } from "../ui";
import { useMaterialTheme } from "../ui/materialTheme";
import { materialShape, materialSize, materialType } from "../ui/materialTokens";
import { MaterialSettingsLeading } from "./MaterialSettingsKit";
import { Divider, Group, IconTile, ToggleRow } from "./SettingsKit";

export const THIS_SITE_FOOTER = "Desktop Site applies to this tab.";
export const THIS_SITE_FALLBACK = "This Site";

export function useThisSite(): { tabId: string; host: string; model: MenuModel } | null {
  const tabId = useSelectedTabId() ?? "";
  const model = useMenuModel(tabId);
  const url = usePages((s) => s.navigation[tabId]?.url) ?? null;
  const tabUrl = useTabs((s) => s.open.find((t) => t.id === tabId)?.url ?? s.privates.find((t) => t.id === tabId)?.url ?? null);
  const inMenu = usePageUi(siteSettingsInMenu);
  if (!inMenu || !tabId || !model.pageRows || !model.isWebPage) return null;
  const shown = url ?? tabUrl;
  return { tabId, host: (shown && display(shown).host) || THIS_SITE_FALLBACK, model };
}

export function ThisSiteGroup() {
  const site = useThisSite();
  if (!site) return null;
  const { host, model } = site;
  return (
    <Group header={host} footer={THIS_SITE_FOOTER}>
      <ToggleRow title="Night Shade" icon="moonFill" tint={settingsTint.nightShade} value={model.nightShadeOn} disabled={!model.siteSwitches} divider onChange={setNightShadeOn} />
      <ZoomRow model={model} />
      <ToggleRow title="Desktop Site" icon="desktop" tint={settingsTint.neutral} value={model.desktopSite} onChange={setDesktopSite} />
    </Group>
  );
}

function ZoomRow({ model }: { model: MenuModel }) {
  return useDesign() === "material" ? <MaterialZoomRow model={model} /> : <ClassicZoomRow model={model} />;
}

function ClassicZoomRow({ model }: { model: MenuModel }) {
  const theme = useTheme();
  const ink = (on: boolean) => (on ? theme.label : theme.tertiaryLabel);
  return (
    <View>
      <View testID="siteSettingsZoom" style={styles.row}>
        <View style={styles.label}>
          <IconTile icon="textformatSize" tint={settingsTint.blue} />
          <Text style={[font.body, styles.labelText, { color: theme.label }]}>Page Zoom</Text>
        </View>
        <View style={styles.stepper}>
          <View pointerEvents="none" style={[styles.plate, { backgroundColor: theme.tertiaryFill }]} />
          <ZoomSegment kind="icon" label="Zoom Out" enabled={model.zoomOut} onPress={zoomOut} style={styles.stepButton}>
            <Symbol name="minus" size={STEP_GLYPH} color={ink(model.zoomOut)} />
          </ZoomSegment>
          <ZoomSegment kind="text" label="Reset Zoom" value={model.zoomPercent} enabled={model.isWebPage} onPress={resetZoom} style={styles.stepReset}>
            <Text testID="siteSettingsZoomPercent" style={[font.subheadline, styles.digits, { color: ink(model.isWebPage) }]}>
              {model.zoomPercent}
            </Text>
          </ZoomSegment>
          <ZoomSegment kind="icon" label="Zoom In" enabled={model.zoomIn} onPress={zoomIn} style={styles.stepButton}>
            <Symbol name="plus" size={STEP_GLYPH} color={ink(model.zoomIn)} />
          </ZoomSegment>
        </View>
      </View>
      <Divider />
    </View>
  );
}

function ZoomSegment({ kind, label, value, enabled, onPress, style, children }: { kind: PressKind; label: string; value?: string; enabled: boolean; onPress: () => void; style: object; children: React.ReactNode }) {
  const pressStyle = usePressStyle(kind, { style });
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityValue={value ? { text: value } : undefined} accessibilityState={{ disabled: !enabled }} disabled={!enabled} onPress={onPress} style={pressStyle}>
      {children}
    </Pressable>
  );
}

function MaterialZoomRow({ model }: { model: MenuModel }) {
  const { scheme } = useMaterialTheme();
  return (
    <View testID="siteSettingsZoom" style={styles.materialRow}>
      <MaterialSettingsLeading icon="textformatSize" />
      <Text style={[materialType.bodyLarge, styles.labelText, { color: scheme.onSurface }]}>Page Zoom</Text>
      <View style={styles.materialStepper}>
        <MaterialIconButton icon="minus" label="Zoom Out" enabled={model.zoomOut} onPress={zoomOut} />
        <Pressable accessibilityRole="button" accessibilityLabel="Reset Zoom" accessibilityValue={{ text: model.zoomPercent }} disabled={!model.isWebPage} onPress={resetZoom} style={styles.materialReset}>
          <Text testID="siteSettingsZoomPercent" style={[materialType.labelLarge, styles.digits, { color: scheme.onSurface }]}>
            {model.zoomPercent}
          </Text>
        </Pressable>
        <MaterialIconButton icon="plus" label="Zoom In" enabled={model.zoomIn} onPress={zoomIn} />
      </View>
    </View>
  );
}

const STEP_GLYPH = 15;
const STEP_HEIGHT = 32;
const STEP_BUTTON = 40;
const STEP_RESET = 56;

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", minHeight: settingsLayout.rowMinHeight, paddingHorizontal: settingsLayout.rowInset, gap: settingsLayout.labelGap },
  label: { flexDirection: "row", alignItems: "center", gap: settingsLayout.labelGap, flexShrink: 1, flexGrow: 1 },
  labelText: { flexShrink: 1, flexGrow: 1 },
  stepper: { flexDirection: "row", alignItems: "center", height: STEP_HEIGHT },
  plate: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, borderRadius: STEP_HEIGHT / 2, ...smoothCorners },
  stepButton: { width: STEP_BUTTON, height: STEP_HEIGHT, alignItems: "center", justifyContent: "center" },
  stepReset: { minWidth: STEP_RESET, height: STEP_HEIGHT, alignItems: "center", justifyContent: "center" },
  digits: { fontVariant: ["tabular-nums"] },
  materialRow: { flexDirection: "row", alignItems: "center", gap: 16, minHeight: materialSize.listItemOneLine, paddingLeft: 16, paddingRight: 4, paddingVertical: 8 },
  materialStepper: { flexDirection: "row", alignItems: "center" },
  materialReset: { minWidth: materialSize.touchTarget, paddingHorizontal: 4, height: materialSize.touchTarget, alignItems: "center", justifyContent: "center", borderRadius: materialShape.full, overflow: "hidden" },
});
