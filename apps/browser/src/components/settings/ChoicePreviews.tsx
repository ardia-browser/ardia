import { StyleSheet, View, type DimensionValue } from "react-native";
import { capsule, ink, radius, Symbol, useTheme } from "../ui";
import { MiniWindow, type MiniWindowLook } from "./MiniWindow";
import { choicePreview as P } from "./tokens";
import { useSettingsColors } from "./useSettingsColors";
import type { CtrlTabPreset } from "../../state/commands/ctrlTabKeys";
import type { Settings } from "../../state/settings/settings";

type FieldPlace = "side" | "toolbar";

function useLook(): MiniWindowLook & { accent: string } {
  const theme = useTheme();
  const look = useSettingsColors();
  return { window: look.miniWindow, bar: look.miniBar, page: look.miniPage, accent: theme.formAccent, closed: look.dashedBorder };
}

const fieldPlaceOf = (addressBar: Settings["addressBar"]): FieldPlace => (addressBar === "sidebar" ? "side" : "toolbar");

export function AfterClosingTabPreview({ mode, top, side }: { mode: Settings["afterClosingTab"]; top: boolean; side: Settings["sidebarSide"] }) {
  const look = useLook();
  return (
    <MiniWindow
      size="l"
      layout={top ? "top" : "side"}
      side={side}
      bars={top ? P.topTabRows : P.tabRows}
      accentBar={mode === "tabAbove" ? 1 : 0}
      closedBar={2}
      look={look}
    />
  );
}

export function CtrlTabPreview({ preset }: { preset: CtrlTabPreset }) {
  const look = useLook();
  if (preset === "step") return <MiniWindow size="l" layout="side" bars={P.tabRows} faintBar={1} accentBar={2} look={look} />;
  return (
    <MiniWindow
      size="l"
      layout="side"
      bars={P.tabRows}
      look={{ ...look, accent: undefined }}
      overlay={
        <View style={[SWITCHER, { backgroundColor: look.window }]}>
          {P.switcherCards.map((focused, i) => (
            <View key={i} style={[SWITCHER_CARD, focused ? { borderColor: look.accent, backgroundColor: `${look.accent}${P.litAlpha}` } : { borderColor: ink.clear, backgroundColor: look.bar }]} />
          ))}
        </View>
      }
    />
  );
}

export function AddressBarPreview({ addressBar }: { addressBar: Settings["addressBar"] }) {
  const look = useLook();
  return <MiniWindow size="l" layout="side" bars={P.shortTabRows} field={fieldPlaceOf(addressBar)} look={look} />;
}

export function CommandBarPreview({ placement, addressBar }: { placement: Settings["commandBarPlacement"]; addressBar: Settings["addressBar"] }) {
  const look = useLook();
  const field = fieldPlaceOf(addressBar);
  if (placement === "field") return <MiniWindow size="l" layout="side" bars={P.shortTabRows} field={field} look={look} />;
  return (
    <MiniWindow
      size="l"
      layout="side"
      bars={P.shortTabRows}
      field={field}
      fieldLit={false}
      look={look}
      overlay={
        <View style={[COMMAND_BAR, { backgroundColor: look.window }]}>
          <View style={[COMMAND_FIELD, { borderColor: look.accent, backgroundColor: look.page }]} />
          {P.resultLines.map((w, i) => (
            <View key={i} style={[LINE, { width: `${w * 100}%` as DimensionValue, backgroundColor: look.bar }]} />
          ))}
        </View>
      }
    />
  );
}

export function ScrollToolbarPreview({ hides }: { hides: boolean }) {
  const look = useLook();
  const theme = useTheme();
  return (
    <MiniWindow
      size="l"
      layout="side"
      bars={P.shortTabRows}
      field={hides ? undefined : "toolbar"}
      look={{ ...look, accent: undefined }}
      overlay={
        <View style={[PAGE_TEXT, hides ? PAGE_TEXT_TOP : PAGE_TEXT_BELOW_TOOLBAR]}>
          {hides ? <View style={[STRIP, { backgroundColor: look.bar }]} /> : null}
          {P.pageLines.map((w, i) => (
            <View key={i} style={[LINE, { width: `${w * 100}%` as DimensionValue, backgroundColor: look.bar }]} />
          ))}
          {hides ? <Symbol name="arrow.down" size={P.scrollMark} color={theme.textTertiary} style={SCROLL_MARK} /> : null}
        </View>
      }
    />
  );
}

const SWITCHER = { flexDirection: "row", gap: P.gap, padding: P.gap, width: "78%", borderRadius: radius.tile * P.scale } as const;
const SWITCHER_CARD = { flex: 1, height: P.switcherCard, borderRadius: radius.tile * P.scale * 0.75, borderWidth: P.litBorder } as const;
const COMMAND_BAR = { gap: P.gap, padding: P.gap, width: "70%", borderRadius: radius.tile * P.scale } as const;
const COMMAND_FIELD = { height: P.commandField, borderRadius: capsule(P.commandField), borderWidth: P.litBorder / 1.5 } as const;
const LINE = { height: P.line, borderRadius: capsule(P.line) } as const;
const PAGE_TEXT = { ...StyleSheet.absoluteFillObject, gap: P.gap, paddingHorizontal: P.pagePad } as const;
const PAGE_TEXT_TOP = { paddingTop: P.stripTop } as const;
const STRIP = { height: P.strip, marginHorizontal: -P.pagePad + P.stripInset, marginBottom: P.gap, borderRadius: capsule(P.strip) } as const;
const PAGE_TEXT_BELOW_TOOLBAR = { paddingTop: P.belowToolbar } as const;
const SCROLL_MARK = { position: "absolute", right: P.pagePad, bottom: P.pagePad, width: P.scrollMark, height: P.scrollMark } as const;
