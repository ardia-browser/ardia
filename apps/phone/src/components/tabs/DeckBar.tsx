import { useEffect, useRef, type ComponentProps } from "react";
import { haptics } from "../../state/app/haptics";
import { StyleSheet, View, type ViewInstance } from "react-native";
import { noteDeckBarTop, watchDeckBar } from "../../state/toasts/store";
import type { FrostVariant } from "@ardia/phone-native";
import { browseLayout, capsule, LookGlass, PressScale, Symbol, tabsLayout, usesGlass, useTheme, type SymbolName } from "../ui";
import { t } from "../../lib/uiLanguage";


export type DeckBarFrost = { source: string; variant: FrostVariant; incognito?: boolean };

type Props = {
  leading: { icon: SymbolName; label: string; onPress: () => void } | null;
  plusLabel: string;
  frost: DeckBarFrost;
  onPlus: () => void;
  onPlusMenu: () => void;
  onSettings: () => void;
  covered?: boolean;
};

type PlateProps = ComponentProps<typeof LookGlass>;

function PlainPlate({ cornerRadius, fill, style, children }: PlateProps) {
  return (
    <View testID="deckBarPlain" style={[style, { backgroundColor: fill, borderRadius: cornerRadius }]}>
      {children}
    </View>
  );
}

export function DeckBar({ leading, plusLabel, frost, onPlus, onPlusMenu, onSettings, covered = false }: Props) {
  const Plate = covered ? PlainPlate : LookGlass;
  const theme = useTheme();
  const plus = tabsLayout.barPlus;
  const glass = usesGlass();
  const sideSize = (name: SymbolName) => (glass ? (GLASS_GLYPHS[name] ?? GLASS_GLYPHS.gearshape) : FROST_ICONS.side);
  const edge = glass ? null : [styles.edge, { borderColor: theme.controlEdge }];
  const row = useRef<ViewInstance>(null);
  const measure = () =>
    row.current?.measureInWindow((_x, y, _width, height) => {
      if (height > 0) noteDeckBarTop(y);
    });
  useEffect(() => {
    watchDeckBar(measure);
    return () => watchDeckBar(null);
  }, []);
  return (
    <View ref={row} style={styles.row} onLayout={measure}>
      <View style={styles.side}>
        {leading ? (
          <PressScale label={leading.label} onPress={leading.onPress} onPressIn={haptics.barPress} style={styles.hit}>
            <Plate {...frost} shape="circle" cornerRadius={circleRadius} fill={theme.deckControl} style={[styles.circle, edge]}>
              <View pointerEvents="none">
                <Symbol name={leading.icon} size={sideSize(leading.icon)} color={theme.secondaryLabel} />
              </View>
            </Plate>
          </PressScale>
        ) : null}
      </View>
      <PressScale
        label={plusLabel}
        hint={t(`Touch and hold for more options.`)}
        onPress={onPlus}
        onLongPress={onPlusMenu}
        onPressIn={haptics.barPress}
        style={{ width: plus.width, height: plus.height }}
      >
        <Plate {...frost} shape="capsule" cornerRadius={capsule(plus.height)} fill={theme.deckControl} style={[styles.plus, edge]}>
          <View pointerEvents="none">
            <Symbol name="plus" size={glass ? GLASS_GLYPHS.plus : FROST_ICONS.plus} color={theme.label} />
          </View>
        </Plate>
      </PressScale>
      <View style={[styles.side, styles.end]}>
        <PressScale label={t(`Settings`)} onPress={onSettings} onPressIn={haptics.barPress} style={styles.hit}>
          <Plate {...frost} shape="circle" cornerRadius={circleRadius} fill={theme.deckControl} style={[styles.circle, edge]}>
            <View pointerEvents="none">
              <Symbol name="gearshape" size={sideSize("gearshape")} color={theme.secondaryLabel} />
            </View>
          </Plate>
        </PressScale>
      </View>
    </View>
  );
}

const circleRadius = capsule(tabsLayout.barCircle);
const FROST_ICONS = { side: 17, plus: 22 } as const;
const GLASS_GLYPHS: Partial<Record<SymbolName, number>> & { gearshape: number; plus: number } = { laptop: 24.6, gearshape: 18, plus: 24.5 };

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", height: browseLayout.hitTarget },
  side: { flex: 1, alignItems: "flex-start" },
  end: { alignItems: "flex-end" },
  hit: { width: browseLayout.hitTarget, height: browseLayout.hitTarget, alignItems: "center", justifyContent: "center" },
  circle: {
    width: tabsLayout.barCircle,
    height: tabsLayout.barCircle,
    alignItems: "center",
    justifyContent: "center",
  },
  plus: { flex: 1, alignItems: "center", justifyContent: "center" },
  edge: { borderWidth: StyleSheet.hairlineWidth },
});
