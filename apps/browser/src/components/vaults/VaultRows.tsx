import { createContext, memo, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";
import { contrast, touchRetryInk, type VaultHighlight } from "../../state/vaults/highlight";
import { FOOTER_KINDS, itemKey, type VaultRow } from "../../state/vaults/menuModel";
import { loadVaultCode } from "../../state/vaults/codes";
import { noteCodeUnavailable } from "../../state/vaults/fill";
import { noteVaultMenuPress, type VaultTouchPhase } from "../../state/vaults/menu";
import { useVaultCode } from "../../state/vaults/hooks";
import { ActivitySpinner, capsule, curve, ink, reduceMotion, springs, Symbol, tabularNums, Text, useTheme, withAlpha } from "../ui";
import { CodeDigits } from "./CodeDigits";
import { useCrossfade, useGlow } from "./rowMotion";
import { CountdownRing, VaultAppIcon, type RingInk } from "./VaultParts";
import { VAULT_CODE, VAULT_MENU, VAULT_TOUCH } from "./tokens";
import { GENERATOR_COPY, itemSite, loginLines, rowLabel } from "./rowText";

export const CodesTicking = createContext(true);

export const rowHeight = (row: VaultRow) => (FOOTER_KINDS.has(row.kind) ? VAULT_MENU.compactRow : VAULT_MENU.row);

const TEXT = { flex: 1, minWidth: 0, gap: VAULT_MENU.textGap } as const;
const TEXT_SLOT = { flex: 1, minWidth: 0 } as const;
const TEXT_LAYER = { gap: VAULT_MENU.textGap, justifyContent: "center" } as const;
const SPINNER = { width: VAULT_MENU.spinner, height: VAULT_MENU.spinner } as const;
const TOUCH_ID = { width: VAULT_MENU.touchID, height: VAULT_MENU.touchID } as const;
const LAYER = { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" } as const;
const DISC = { position: "absolute", width: VAULT_TOUCH.retryDisc, height: VAULT_TOUCH.retryDisc, borderRadius: capsule(VAULT_TOUCH.retryDisc) } as const;
const TRAILING = { width: VAULT_MENU.touchID, height: VAULT_MENU.touchID, alignItems: "center", justifyContent: "center" } as const;
const BUSY_SLOT = { position: "absolute", top: 0, bottom: 0, width: VAULT_MENU.touchID, alignItems: "center", justifyContent: "center" } as const;
const RING_SLOT = { width: VAULT_CODE.ring, height: VAULT_CODE.ring } as const;
const RING_WAIT = { ...RING_SLOT, alignItems: "center", justifyContent: "center" } as const;
const TITLE_ROW = { flexDirection: "row", alignItems: "center" } as const;

const TRY_AGAIN = "Try Again";

type RowProps = Parameters<typeof VaultRowViewOf>[0];

const sameTouch = (a: VaultTouchState | null, b: VaultTouchState | null) => a === b || (!!a && !!b && a.phase === b.phase && a.retries === b.retries);

const sameRowProps = (a: RowProps, b: RowProps) =>
  a.tabId === b.tabId && a.seq === b.seq && a.row === b.row && a.selected === b.selected && a.plated === b.plated && a.reserveTrailing === b.reserveTrailing && a.highlight === b.highlight && a.busy === b.busy && a.site === b.site && sameTouch(a.touch, b.touch);

export const VaultRowView = memo(VaultRowViewOf, sameRowProps);

type InkFade = { plain: Ink; lit: Ink; glow: Animated.Value; shown: boolean };
export type Ink = { title: string; detail: string; icon: string; ground: string; ring?: RingInk; fade?: InkFade };

export type VaultTouchState = { phase: VaultTouchPhase; retries: number };

function useInk(highlight: VaultHighlight | null, surface: string): Ink {
  const theme = useTheme();
  if (!highlight) return { title: theme.textPrimary, detail: withAlpha(theme.dark ? ink.white : ink.black, VAULT_MENU.detailAlpha), icon: theme.icon, ground: surface };
  const on = highlight.onLight ? ink.black : ink.white;
  const warning = contrast(theme.warning, highlight.fill) >= VAULT_CODE.litWarningContrast ? theme.warning : on;
  return { title: on, detail: on, icon: on, ground: highlight.fill, ring: { arc: on, warning, track: withAlpha(on, theme.dark ? VAULT_CODE.restTrack.dark : VAULT_CODE.restTrack.light) } };
}

export function RowShell({ label, height, compact, selected, plated, highlight, onHover, onPress, children }: { label: string; height: number; compact: boolean; selected: boolean; plated: boolean; highlight: VaultHighlight; onHover: () => void; onPress: () => void; children: (ink: Ink, lit: boolean) => ReactNode }) {
  const lit = useInk(highlight, highlight.surface);
  const plain = useInk(null, highlight.surface);
  const { glow, shown } = useGlow(selected, plated);
  const fade = plated ? { plain, lit, glow, shown } : undefined;
  const inkOf = (pressed: boolean): Ink => (pressed && !selected ? lit : { ...(selected ? lit : plain), fade });
  return (
    <View onMouseEnter={onHover}>
      <Pressable onPressIn={noteVaultMenuPress} onPress={onPress} accessibilityRole="menuitem" accessibilityLabel={label} accessibilityState={{ selected }}>
        {({ pressed }) => (
          <View
            style={{
              height,
              marginHorizontal: VAULT_MENU.rowInset,
              paddingHorizontal: compact ? VAULT_MENU.footerPadding : VAULT_MENU.rowPadding,
              borderRadius: VAULT_MENU.rowRadius,
              flexDirection: "row",
              alignItems: "center",
              gap: VAULT_MENU.iconGap,
              backgroundColor: (selected && !plated) || (pressed && !selected) ? highlight.fill : undefined,
            }}
          >
            {children(inkOf(pressed), selected || pressed)}
          </View>
        )}
      </Pressable>
    </View>
  );
}

function useTryAgain(retries: number) {
  const [shown, setShown] = useState(false);
  const first = useRef(retries);
  useEffect(() => {
    if (retries === first.current) return;
    setShown(true);
    const timer = setTimeout(() => setShown(false), VAULT_TOUCH.tryAgainMs);
    return () => clearTimeout(timer);
  }, [retries]);
  return shown;
}

function Swap({ from, to, showTo, color, size, weight, mono }: { from: string; to: string; showTo: boolean; color: string; size?: "caption"; weight?: "medium"; mono?: boolean }) {
  const fade = useCrossfade(showTo, VAULT_TOUCH.crossfadeMs);
  if (from === to) return <Text lines={1} size={size} weight={weight} color={color} style={mono ? tabularNums : undefined}>{from}</Text>;
  return (
    <View>
      <Animated.View style={{ opacity: fade.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }}>
        <Text lines={1} size={size} weight={weight} color={color} style={mono ? tabularNums : undefined}>
          {from}
        </Text>
      </Animated.View>
      <Animated.View style={{ ...StyleSheet.absoluteFillObject, opacity: fade }}>
        <Text lines={1} size={size} weight={weight} color={color}>
          {to}
        </Text>
      </Animated.View>
    </View>
  );
}

type LinesProps = { title: string; detail?: string; ink: Ink; mono?: boolean; strong?: boolean; tryAgain?: boolean; renderTitle?: (ink: Ink) => ReactNode };

function LinesIn({ title, detail, ink, mono, strong, tryAgain, renderTitle }: LinesProps) {
  const weight = strong || detail ? "medium" : undefined;
  const swapTitle = !!tryAgain && !detail;
  return (
    <>
      {renderTitle ? <View style={TITLE_ROW}>{renderTitle(ink)}</View> : <Swap from={title} to={swapTitle ? TRY_AGAIN : title} showTo={swapTitle} color={ink.title} weight={weight} mono={mono} />}
      {detail ? <Swap from={detail} to={tryAgain ? TRY_AGAIN : detail} showTo={!!tryAgain} color={ink.detail} size="caption" /> : null}
    </>
  );
}

export function Lines(props: LinesProps) {
  const fade = props.ink.fade;
  if (!fade) return <View style={TEXT}><LinesIn {...props} /></View>;
  return (
    <View style={TEXT_SLOT}>
      <View style={TEXT_LAYER}>
        <LinesIn {...props} ink={fade.plain} />
      </View>
      {fade.shown ? (
        <Animated.View pointerEvents="none" style={{ ...StyleSheet.absoluteFillObject, ...TEXT_LAYER, opacity: fade.glow }}>
          <LinesIn {...props} ink={fade.lit} />
        </Animated.View>
      ) : null}
    </View>
  );
}

function TouchGlyph({ touch, ink, fill }: { touch: VaultTouchState; ink: Ink; fill: string | null }) {
  const theme = useTheme();
  const still = reduceMotion() === true;
  const shake = useRef(new Animated.Value(0)).current;
  const first = useRef(touch.retries);
  const granted = touch.phase === "granted";
  const check = useCrossfade(granted, VAULT_TOUCH.grantMs);
  useEffect(() => {
    if (still || touch.retries === first.current) return;
    shake.setValue(0);
    const run = Animated.timing(shake, { toValue: 1, duration: VAULT_TOUCH.shakeMs, easing: curve.linear, useNativeDriver: true });
    run.start();
    return () => run.stop();
  }, [touch.retries]);
  const pop = useRef(new Animated.Value(granted ? 1 : 0)).current;
  useEffect(() => {
    if (!granted || still) return pop.setValue(granted ? 1 : 0);
    pop.setValue(0);
    const run = Animated.spring(pop, { toValue: 1, ...springs.bouncy, useNativeDriver: true });
    run.start();
    return () => run.stop();
  }, [granted]);
  const retry = touch.phase === "retry";
  const red = touchRetryInk(fill, theme.destructive);
  const steps = VAULT_TOUCH.shakeSteps;
  const translateX = shake.interpolate({ inputRange: steps.map((_, i) => i / (steps.length - 1)), outputRange: [...steps] });
  const checkScale = pop.interpolate({ inputRange: [0, 1], outputRange: [VAULT_TOUCH.grantFrom, 1] });
  return (
    <Animated.View style={{ ...TRAILING, transform: still ? [] : [{ translateX }] }}>
      <Animated.View style={{ ...LAYER, opacity: check.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }}>
        {retry && red.disc ? <View style={{ ...DISC, backgroundColor: red.disc }} /> : null}
        <Symbol name="touchid" size={VAULT_MENU.touchID} color={retry ? red.glyph : ink.title} style={TOUCH_ID} />
      </Animated.View>
      <Animated.View style={{ ...LAYER, opacity: check, transform: still ? [] : [{ scale: checkScale }] }}>
        <Symbol name="checkmark.circle.fill" size={VAULT_MENU.touchID} color={ink.title} style={TOUCH_ID} />
      </Animated.View>
    </Animated.View>
  );
}

function GrantedThenSpinner({ touch, ink, fill }: { touch: VaultTouchState; ink: Ink; fill: string | null }) {
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), VAULT_TOUCH.grantMs + VAULT_TOUCH.grantHoldMs);
    return () => clearTimeout(timer);
  }, []);
  if (waited) return <Spinner />;
  return <TouchGlyph touch={touch} ink={ink} fill={fill} />;
}

function Spinner() {
  return (
    <View style={TRAILING}>
      <ActivitySpinner style={SPINNER} />
    </View>
  );
}

function BusyOverlay({ busy, compact = false }: { busy: boolean; compact?: boolean }) {
  return busy ? (
    <View pointerEvents="none" style={{ ...BUSY_SLOT, right: compact ? VAULT_MENU.footerPadding : VAULT_MENU.rowPadding }}>
      <ActivitySpinner style={SPINNER} />
    </View>
  ) : null;
}

export function Trailing({ busy, touch, ink, fill, reserve }: { busy: boolean; touch: VaultTouchState | null; ink: Ink; fill: string | null; reserve: boolean }) {
  if (busy && touch?.phase === "granted") return <GrantedThenSpinner touch={touch} ink={ink} fill={fill} />;
  if (busy) return <Spinner />;
  if (touch) return <TouchGlyph touch={touch} ink={ink} fill={fill} />;
  return reserve ? <View style={TRAILING} /> : null;
}

function ItemTile({ provider, ink, symbol = "key.fill" }: { provider: string; ink: Ink; symbol?: string }) {
  const fade = ink.fade;
  const tile = (layer: Ink) => <VaultAppIcon provider="" symbol={symbol} neutral badge={{ provider, ground: layer.ground }} />;
  if (!fade?.shown) return tile(fade ? fade.plain : ink);
  return (
    <View>
      {tile(fade.plain)}
      <Animated.View pointerEvents="none" style={{ ...StyleSheet.absoluteFillObject, opacity: fade.glow }}>
        {tile(fade.lit)}
      </Animated.View>
    </View>
  );
}

function RingSlot({ live, ink, paused }: { live: { expiresAt: number; period: number } | null; ink: Ink; paused: boolean }) {
  const fade = ink.fade;
  const ring = (layer: Ink) => (live ? <CountdownRing key={live.expiresAt} expiresAt={live.expiresAt} period={live.period} paused={paused} colors={layer.ring} /> : null);
  return (
    <View style={RING_SLOT}>
      {fade?.shown ? <Animated.View style={{ ...StyleSheet.absoluteFillObject, opacity: fade.glow.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }}>{ring(fade.plain)}</Animated.View> : ring(fade ? fade.plain : ink)}
      {fade?.shown ? (
        <Animated.View pointerEvents="none" style={{ ...StyleSheet.absoluteFillObject, opacity: fade.glow }}>
          {ring(fade.lit)}
        </Animated.View>
      ) : null}
    </View>
  );
}

function CodeLine({ tabId, seq, row, ink, trailing }: { tabId: string; seq: number; row: Extract<VaultRow, { kind: "otp" }>; ink: Ink; trailing: ReactNode }) {
  const key = itemKey(row.item);
  const code = useVaultCode(key);
  const ticking = useContext(CodesTicking);
  useEffect(() => {
    if (code === undefined) void loadVaultCode(row.item);
    if (code === "none") noteCodeUnavailable(tabId, seq, key);
    if (!code || typeof code === "string" || !ticking) return;
    const timer = setTimeout(() => void loadVaultCode(row.item), Math.max(0, code.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [code, key, ticking]);
  const live = code && typeof code === "object" ? code : null;
  const renderTitle = (layer: Ink) => <CodeDigits owner={key} code={live} color={layer.title} weight="medium" />;
  return (
    <>
      <ItemTile provider={row.item.provider} ink={ink} />
      <Lines title="" detail={row.item.username || row.item.title || itemSite(row.item.urls)} ink={ink} renderTitle={renderTitle} />
      {live ? <RingSlot live={live} ink={ink} paused={!ticking} /> : <View style={RING_WAIT}><ActivitySpinner style={SPINNER} /></View>}
      {trailing}
    </>
  );
}

function VaultRowViewOf({
  tabId,
  seq,
  row,
  selected,
  plated,
  reserveTrailing,
  highlight,
  touch,
  busy,
  site,
  onHover,
  onPress,
}: {
  tabId: string;
  seq: number;
  row: VaultRow;
  selected: boolean;
  plated: boolean;
  reserveTrailing: boolean;
  highlight: VaultHighlight;
  touch: VaultTouchState | null;
  busy: boolean;
  site: string;
  onHover: () => void;
  onPress: () => void;
}) {
  const tryAgain = useTryAgain(touch?.retries ?? 0) && !!touch && !busy;
  const label = rowLabel(row, site);
  const shell = (children: (ink: Ink, lit: boolean) => ReactNode) => (
    <RowShell label={label} height={rowHeight(row)} compact={FOOTER_KINDS.has(row.kind)} selected={selected} plated={plated} highlight={highlight} onHover={onHover} onPress={onPress}>
      {children}
    </RowShell>
  );
  const trailing = (ink: Ink, lit: boolean) => <Trailing busy={busy} touch={touch} ink={ink} fill={lit ? highlight.fill : null} reserve={reserveTrailing} />;
  switch (row.kind) {
    case "login": {
      const { title, detail } = loginLines(row.item, site);
      return shell((ink, lit) => (
        <>
          <ItemTile provider={row.item.provider} ink={ink} />
          <Lines title={title} detail={detail || undefined} ink={ink} tryAgain={tryAgain} />
          {trailing(ink, lit)}
        </>
      ));
    }
    case "otp":
      return shell((ink, lit) => <CodeLine tabId={tabId} seq={seq} row={row} ink={ink} trailing={trailing(ink, lit)} />);
    case "username":
      return shell((ink) => (
        <>
          <ItemTile provider={row.item.provider} symbol="person.crop.circle" ink={ink} />
          <Lines title={row.username} detail="Used Before" ink={ink} />
          <BusyOverlay busy={busy} />
        </>
      ));
    case "generate": {
      const copy = GENERATOR_COPY[row.style];
      return shell((ink) => (
        <>
          <VaultAppIcon provider="" symbol="key.fill" neutral />
          <Lines title={copy.title} detail={copy.detail} ink={ink} strong />
          <BusyOverlay busy={busy} />
        </>
      ));
    }
    case "unlock":
      return shell((ink, lit) => (
        <>
          <VaultAppIcon provider={row.provider} />
          <Lines title={label} ink={ink} tryAgain={tryAgain} />
          {trailing(ink, lit)}
        </>
      ));
    case "suggest":
      return shell((ink) => (
        <>
          <Lines title={label} ink={ink} />
          <BusyOverlay busy={busy} compact />
        </>
      ));
    case "allPasswords":
    case "openPasswords":
    case "settings":
      return shell((ink) => <Lines title={label} ink={ink} />);
  }
}
