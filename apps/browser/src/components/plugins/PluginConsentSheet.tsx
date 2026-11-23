import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, ScrollView, View } from "react-native";
import { useShallow } from "zustand/react/shallow";
import { consentLines, type ConsentLine } from "../../state/plugins/actions";
import { installPhase, installWatch, REVIEW, type InstallPhase } from "../../state/plugins/consentInstall";
import { CONSENT_KEYS, CONSENT_KEYS_UP, consentKeyDown, consentKeyUp, FRESH_CONSENT_KEYS, type ConsentButton, type ConsentKeyPress } from "../../state/plugins/consentKeys";
import { useConsentListing, useConsentVerb } from "../../state/plugins/hooks";
import { requestPluginConsent } from "../../state/plugins/lifecycle";
import { installOfficialPlugin } from "../../state/plugins/official";
import { CONSENT_WORDS, consentSource, type ConsentVerb } from "../../state/plugins/consentWords";
import { usePlugins, type PluginListing, type PluginsStore } from "../../state/plugins/store";
import { Button, Dialog, Symbol, Text } from "../ui";
import { contrastTheme, useTheme } from "../ui/theme";
import { themeOverride } from "../ui/ThemeOverride";
import { useSystemIncreaseContrast } from "../../state/app/systemContrast";
import { ink, radius } from "../ui/tokens";
import { useControlTurnedOff } from "../../state/app/programControlSetting";
import { useNeverChosenCount } from "../../state/site/passwordManager";
import { ConsentSections, EdgeFade, InstallBar, PluginIcon } from "./consent/ConsentParts";
import { CONSENT_MOTION, CONSENT_SHEET as C } from "./consent/tokens";

type ConsentRequest = NonNullable<PluginsStore["consent"]>;

type Shown = { listing: PluginListing | undefined; verb: ConsentVerb; lines: ConsentLine[] };

export function PluginConsentSheet({ request, onCancel, onConfirm, onClosed }: { request: ConsentRequest; onCancel: (id: number) => boolean; onConfirm: (id: number) => boolean; onClosed: () => void }) {
  const { id, name, hash } = request;
  const live = useConsentListing(name, hash);
  const liveVerb = useConsentVerb(name, hash);
  const controlOff = useControlTurnedOff();
  const movesProfiles = useNeverChosenCount();
  const [installing, setInstalling] = useState(false);
  const [retryFailure, setRetryFailure] = useState<string | null>(null);
  const shown = useRef<Shown | null>(null);
  if (!installing || !shown.current) {
    const m = live?.manifest;
    shown.current = { listing: live, verb: liveVerb, lines: m ? consentLines(m, { controlOff, official: !!live?.official, movesProfiles }) : [] };
  }
  const { listing, verb, lines } = shown.current;
  const m = listing?.manifest;
  const words = CONSENT_WORDS[verb];
  const program = m?.programs[0]?.name ?? null;
  const phase = usePlugins(useShallow((s: PluginsStore): InstallPhase => (installing ? installPhase(installWatch(s, request, program, retryFailure)) : REVIEW)));
  const changed = !m || listing?.hash !== hash;
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    if (phase.step !== "installed") return;
    if (verb === "turnOn") return onClosed();
    const timer = setTimeout(onClosed, CONSENT_MOTION.installedHoldMs);
    return () => clearTimeout(timer);
  }, [phase.step]);
  const cancel = () => {
    if (onCancel(id)) onClosed();
  };
  const install = () => {
    if (changed) return;
    setInstalling(true);
    onConfirm(id);
  };
  const retry = () => {
    setRetryFailure(null);
    if (!listing?.official) {
      onClosed();
      requestPluginConsent(name);
      return;
    }
    void installOfficialPlugin(name, { showSheet: false }).then((result) => {
      if (mounted.current && !result.ok && !result.cancelled) setRetryFailure(result.reason);
    });
  };
  const title = m?.title ?? name;
  const theme = useTheme();
  const strong = useSystemIncreaseContrast((s) => s.on);
  return (
    <Dialog width={C.size} pad="none" maxHeight={C.maxHeight} onDismiss={phase.step === "review" ? cancel : onClosed} backdropCloses={false}>
      <SheetKeys phase={phase} canInstall={!changed} label={`${words.title} ${m?.title ?? name}?`} onCancel={cancel} onInstall={install} onRetry={retry} onClose={onClosed}>
        {(selected) =>
          themeOverride(
            strong ? contrastTheme(theme) : theme,
            <>
              <Header name={name} title={title} listing={listing} />
              <List changed={changed} lines={lines} />
              <Footer phase={phase} selected={selected} words={words} canInstall={!changed} onCancel={cancel} onInstall={install} onRetry={retry} onClose={onClosed} />
            </>,
          )
        }
      </SheetKeys>
    </Dialog>
  );
}

function SheetKeys({
  phase,
  canInstall,
  label,
  onCancel,
  onInstall,
  onRetry,
  onClose,
  children,
}: {
  phase: InstallPhase;
  canInstall: boolean;
  label: string;
  onCancel: () => void;
  onInstall: () => void;
  onRetry: () => void;
  onClose: () => void;
  children: (selected: ConsentButton | null) => ReactNode;
}) {
  const [selected, setSelected] = useState<ConsentButton | null>(null);
  const keyState = useRef(FRESH_CONSENT_KEYS);
  const keys = useRef<View>(null);
  useEffect(() => keys.current?.focus(), []);
  useEffect(() => {
    keyState.current = FRESH_CONSENT_KEYS;
    setSelected(null);
  }, [phase.step]);
  const onKey = (e: ConsentKeyPress) => {
    if (phase.step === "installing" || phase.step === "installed") {
      if (!e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === "Escape" || (phase.step === "installed" && e.key === "Enter"))) onClose();
      return;
    }
    const next = consentKeyDown(keyState.current, e, phase.step === "failed" || canInstall);
    keyState.current = next.state;
    setSelected(next.state.selected);
    if (next.press === "cancel") (phase.step === "failed" ? onClose : onCancel)();
    else if (next.press === "install") (phase.step === "failed" ? onRetry : onInstall)();
  };
  return (
    <View
      ref={keys}
      focusable
      enableFocusRing={false}
      accessibilityLabel={label}
      keyDownEvents={CONSENT_KEYS}
      keyUpEvents={CONSENT_KEYS_UP}
      onKeyDown={(e) => onKey(e.nativeEvent)}
      onKeyUp={(e) => {
        keyState.current = consentKeyUp(keyState.current, e.nativeEvent);
      }}
      style={SHEET}
    >
      {children(selected)}
    </View>
  );
}

function Header({ name, title, listing }: { name: string; title: string; listing: PluginListing | undefined }) {
  const theme = useTheme();
  const m = listing?.manifest;
  const official = !!listing?.official;
  return (
    <View style={HEADER}>
      <PluginIcon name={name} icon={m?.icon ?? null} provider={m?.contributes.credentialProvider ?? null} />
      <Text size="large" weight="semibold" lines={C.nameLines} style={NAME}>
        {title}
      </Text>
      <View style={META}>
        {official ? <Symbol name="checkmark.seal.fill" size={C.seal} color={theme.formAccent} style={SEAL} /> : null}
        <Text size="small" tone="textSecondary">
          {consentSource(official, m?.version ?? null)}
        </Text>
      </View>
      {m?.description ? (
        <Text size="small" tone="textSecondary" lines={C.descriptionLines} style={DESCRIPTION}>
          {m.description}
        </Text>
      ) : null}
    </View>
  );
}

function List({ changed, lines }: { changed: boolean; lines: ConsentLine[] }) {
  const theme = useTheme();
  const metrics = useRef({ frame: 0, content: 0, offset: 0 });
  const [above, setAbove] = useState(false);
  const [below, setBelow] = useState(false);
  const measure = (patch: Partial<typeof metrics.current>) => {
    const next = { ...metrics.current, ...patch };
    metrics.current = next;
    setAbove(next.offset > 0);
    setBelow(next.content - next.frame - next.offset > C.fade + 1);
  };
  return (
    <View style={LIST_AREA}>
      <ScrollView
        style={LIST}
        contentContainerStyle={LIST_CONTENT}
        scrollEventThrottle={16}
        onScroll={(e) => measure({ offset: Math.max(0, e.nativeEvent.contentOffset.y) })}
        onLayout={(e) => measure({ frame: e.nativeEvent.layout.height })}
        onContentSizeChange={(_, height) => measure({ content: height })}
      >
        {changed ? (
          <Text tone="textSecondary" style={CHANGED}>
            The plugin changed while this was open. Close this and try again.
          </Text>
        ) : (
          <ConsentSections lines={lines} />
        )}
      </ScrollView>
      {above ? <EdgeFade edge="top" /> : null}
      {below ? <EdgeFade edge="bottom" /> : null}
    </View>
  );
}

function Footer({
  phase,
  selected,
  words,
  canInstall,
  onCancel,
  onInstall,
  onRetry,
  onClose,
}: {
  phase: InstallPhase;
  selected: ConsentButton | null;
  words: (typeof CONSENT_WORDS)[ConsentVerb];
  canInstall: boolean;
  onCancel: () => void;
  onInstall: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const fade = useRef(new Animated.Value(1)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    fade.setValue(0);
    const run = Animated.timing(fade, { toValue: 1, ...CONSENT_MOTION.phase, useNativeDriver: true });
    run.start();
    return () => run.stop();
  }, [phase.step]);
  return (
    <Animated.View style={[FOOTER, { opacity: fade }]}>
      {phase.step === "review" ? (
        <>
          <View style={GROW} />
          <Ring on={selected === "cancel"} color={theme.formAccent}>
            <Button title="Cancel" onPress={onCancel} />
          </Ring>
          <Ring on={selected === "install"} color={theme.formAccent}>
            <Button title={words.button} kind="primary" disabled={!canInstall} onPress={onInstall} />
          </Ring>
        </>
      ) : phase.step === "installing" ? (
        <>
          <Text size="small" tone="textSecondary" lines={1} style={GROW}>
            {phase.label}
          </Text>
          <InstallBar fraction={phase.fraction} />
        </>
      ) : phase.step === "installed" ? (
        <>
          <Symbol name="checkmark.circle.fill" size={C.statusGlyph} color={theme.success} style={STATUS_ICON} />
          <Text size="small" weight="medium" style={GROW}>
            {words.done}
          </Text>
        </>
      ) : (
        <View style={FAILED}>
          <View style={REASON}>
            <Symbol name="exclamationmark.triangle.fill" size={C.statusGlyph} color={theme.warning} style={STATUS_ICON} />
            <Text size="small" tone="textSecondary" selectable style={GROW}>
              {phase.reason}
            </Text>
          </View>
          <View style={BUTTONS}>
            <Ring on={selected === "cancel"} color={theme.formAccent}>
              <Button title="Close" onPress={onClose} />
            </Ring>
            <Ring on={selected === "install"} color={theme.formAccent}>
              <Button title="Try Again" kind="primary" onPress={onRetry} />
            </Ring>
          </View>
        </View>
      )}
    </Animated.View>
  );
}

function Ring({ on, color, children }: { on: boolean; color: string; children: ReactNode }) {
  return <View style={{ borderRadius: radius.control + RING * 2, borderWidth: RING, padding: RING, borderColor: on ? color : ink.clear, margin: -RING * 2 }}>{children}</View>;
}

const RING = 2;
const SHEET = { flexShrink: 1, padding: C.inset } as const;
const HEADER = { alignItems: "center" } as const;
const NAME = { textAlign: "center", marginTop: C.headerGap } as const;
const META = { flexDirection: "row", alignItems: "center", gap: C.metaGap * 2, marginTop: C.metaGap } as const;
const SEAL = { width: C.seal + C.metaGap, height: C.seal + C.metaGap, transform: [{ translateY: -C.sealLift }] } as const;
const DESCRIPTION = { textAlign: "center", marginTop: C.descriptionGap } as const;
const LIST_AREA = { flexShrink: 1, marginTop: C.listGap, marginHorizontal: C.listInset - C.inset } as const;
const LIST = { flexGrow: 0, flexShrink: 1 } as const;
const LIST_CONTENT = { paddingBottom: C.fade } as const;
const CHANGED = { paddingHorizontal: C.rowPadX } as const;
const FOOTER = { flexDirection: "row", alignItems: "center", gap: C.rowGap, minHeight: C.footerHeight } as const;
const GROW = { flex: 1 } as const;
const FAILED = { flex: 1, gap: C.footerGap } as const;
const REASON = { flexDirection: "row", alignItems: "flex-start", gap: C.rowGap } as const;
const BUTTONS = { flexDirection: "row", justifyContent: "flex-end", gap: C.rowGap } as const;
const STATUS_ICON = { width: C.statusBox, height: C.statusBox } as const;
