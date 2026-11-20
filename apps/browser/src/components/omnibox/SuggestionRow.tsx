import { displayHost, displayUrl, hostOf, type Suggestion } from "@ardia/core";
import { memo, useEffect, useState } from "react";
import { AccessibilityInfo, Image, Pressable, Text as NativeText, View } from "react-native";
import { Button, LiveRegion, Symbol, Text, useHover, useTheme, withAlpha, type Theme } from "../ui";
import { Favicon, LocalFileIcon } from "../favicon/Favicon";
import { filePathLabel, fullFilePath, isLocalFileUrl } from "../../lib/url";
import { SELECTED_SUGGESTION_ALPHA, SUGGESTION } from "./tokens";
import { emptyAnnouncement } from "./emptyAnnouncement";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";

const ICON_BOX = { width: SUGGESTION.iconBox, height: SUGGESTION.iconBox } as const;
const NO_SHRINK = { flexShrink: 0 } as const;
const EMPTY_ROW = { height: SUGGESTION.height, marginVertical: SUGGESTION.gapY, flexDirection: "row", alignItems: "center", paddingHorizontal: SUGGESTION.padX, gap: SUGGESTION.gap } as const;
const STACK = { flexShrink: 1, gap: SUGGESTION.stackGap } as const;
const fullLocation = (url: string) => (isLocalFileUrl(url) ? fullFilePath(url) : displayUrl(url));
const RETURN_BOX = { width: SUGGESTION.returnBox, height: SUGGESTION.returnBox } as const;

const selectedFill = (theme: Theme) =>
  theme.powerUpColor ? withAlpha(theme.powerUpColor, theme.dark ? SELECTED_SUGGESTION_ALPHA.dark : SELECTED_SUGGESTION_ALPHA.light) : theme.commandBarSelected;

export function SuggestionIcon({ suggestion: s, color }: { suggestion: Suggestion; color?: string }) {
  const theme = useTheme();
  const tint = color ?? theme.textSecondary;
  switch (s.kind) {
    case "page":
      return isLocalFileUrl(s.url) && !s.favicon ? <LocalFileIcon size={SUGGESTION.iconBox} color={tint} /> : <Favicon url={s.url} favicon={s.favicon} />;
    case "create":
      return <Favicon url={`https://${s.site}`} />;
    case "search":
      return <Symbol name="magnifyingglass" size={SUGGESTION.icon} color={tint} style={ICON_BOX} />;
    case "calc":
      return <Symbol name="equal.circle" size={SUGGESTION.calcIcon} color={tint} style={ICON_BOX} />;
    case "action":
      return <Symbol name={s.icon ?? "command"} size={SUGGESTION.icon} color={tint} style={ICON_BOX} />;
    case "extension":
      return s.icon ? (
        <Image source={{ uri: s.icon }} style={ICON_BOX} />
      ) : (
        <Symbol name="puzzlepiece.extension" size={SUGGESTION.icon} color={tint} style={ICON_BOX} />
      );
    case "provider":
      return <Favicon url={s.url} favicon={s.icon} />;
  }
}

function labels(s: Suggestion): [string, string | null] {
  switch (s.kind) {
    case "page": {
      const where = isLocalFileUrl(s.url) ? filePathLabel(s.url) : displayUrl(s.url);
      if (s.tabId) return [s.title || where, "Switch to Tab"];
      return s.title ? [s.title, where] : [where, null];
    }
    case "search":
      return [s.bang || !s.suggested ? `Search ${s.engine} for “${s.query}”` : s.query, null];
    case "calc":
      return [s.value, s.expression];
    case "action":
    case "create":
      return [s.title, null];
    case "extension":
      return [s.title, s.open === "action" ? "Open Extension" : "Extension Options"];
    case "provider": {
      const host = displayHost(hostOf(s.url)) || displayUrl(s.url);
      return [s.title, s.subtitle ? `${host} · ${s.subtitle}` : host];
    }
  }
}

export type RowActions = {
  choose(s: Suggestion): void;
  remove(url: string): void;
};

export const SuggestionList = memo(function SuggestionList({
  items,
  selectedIndex,
  scopeHint,
  empty,
  dropdown,
  actions,
}: {
  items: Suggestion[];
  selectedIndex: number;
  scopeHint: string | null;
  empty: string | null;
  dropdown: boolean;
  actions: RowActions;
}) {
  const [announced, setAnnounced] = useState<string | null>(null);
  useEffect(() => {
    const step = emptyAnnouncement(announced, items.length ? null : empty, items.length > 0);
    if (step.announced !== announced) setAnnounced(step.announced);
    if (step.say && PLATFORM_FEATURES.announcesByCall) AccessibilityInfo.announceForAccessibility(step.say);
  }, [empty, items.length]);
  const frame = { paddingHorizontal: dropdown ? SUGGESTION.dropdownListX : SUGGESTION.listX, paddingBottom: dropdown ? SUGGESTION.dropdownListBelow : SUGGESTION.listBelow };
  return (
    <>
      <LiveRegion text={announced ?? ""} />
      {items.length ? (
        <View style={frame}>
          {items.map((s, i) => (
            <SuggestionRow
              key={i}
              suggestion={s}
              selected={i === selectedIndex}
              scopeHint={i === 0 ? scopeHint : null}
              actions={actions}
            />
          ))}
        </View>
      ) : empty ? (
        <View style={frame}>
          <EmptyRow text={empty} />
        </View>
      ) : null}
    </>
  );
});

function EmptyRow({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <View accessibilityRole="text" style={EMPTY_ROW}>
      <Symbol name="magnifyingglass" size={SUGGESTION.icon} color={theme.textSecondary} style={ICON_BOX} />
      <Text lines={1} size="title" tone="textSecondary" style={{ flexShrink: 1 }}>{text}</Text>
    </View>
  );
}

function sameSuggestion(a: Suggestion, b: Suggestion): boolean {
  if (a === b) return true;
  const ka = Object.keys(a) as (keyof Suggestion)[];
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

export const isRemovable = (s: Suggestion | undefined): s is Extract<Suggestion, { kind: "page" }> => s?.kind === "page" && !!s.visited && !s.tabId;

const SuggestionRow = memo(
  function SuggestionRow({
    suggestion: s,
    selected,
    scopeHint,
    actions,
  }: {
    suggestion: Suggestion;
    selected: boolean;
    scopeHint: string | null;
    actions: RowActions;
  }) {
    const theme = useTheme();
    const { hovered, hoverProps } = useHover();
    const [title, accessory] = labels(s);
    const location = s.kind === "page" && !s.tabId ? accessory : null;
    const pathEnd = s.kind === "page" && isLocalFileUrl(s.url);
    const twoLines = !!location;
    const hint = s.kind === "provider" ? s.provider : s.kind === "action" && !selected ? s.hint : null;
    const onRemove = isRemovable(s) ? () => actions.remove(s.url) : undefined;
    const removable = !!onRemove && (hovered || selected);
    return (
      <View {...hoverProps}>
        <Pressable onPress={() => actions.choose(s)} tooltip={s.kind === "page" ? fullLocation(s.url) : undefined}>
          <View
            style={{
              height: twoLines ? SUGGESTION.stackedHeight : SUGGESTION.height,
              marginVertical: SUGGESTION.gapY,
              borderRadius: SUGGESTION.radius,
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: SUGGESTION.padX,
              gap: SUGGESTION.gap,
              backgroundColor: selected ? selectedFill(theme) : hovered ? theme.commandBarHover : undefined,
            }}
          >
            <SuggestionIcon suggestion={s} />
            {twoLines ? (
              <View style={STACK}>
                <Text lines={1} size="title">{title}</Text>
                <Text lines={1} size="small" tone="textSecondary" ellipsizeMode={pathEnd ? "head" : "tail"}>{location}</Text>
              </View>
            ) : (
              <Text lines={1} size="title" style={{ flexShrink: 1 }}>
                {title}
                {accessory ? (
                  <NativeText style={{ color: theme.textSecondary }}>
                    {" — "}
                    {accessory}
                  </NativeText>
                ) : null}
              </Text>
            )}
            {scopeHint ? <Text lines={1} size="title" tone="textSecondary" style={NO_SHRINK}>{`— ${scopeHint}`}</Text> : null}
            <View style={{ flex: 1 }} />
            {hint && !removable ? <Text size="small" tone="textSecondary">{hint}</Text> : null}
            {removable ? (
              <Button variant="icon" icon="xmark" size="s" color={theme.textSecondary} tooltip="Remove from History" onPress={onRemove} />
            ) : null}
            {selected ? <Symbol name="return" size={SUGGESTION.returnGlyph} weight="medium" color={theme.textSecondary} style={[RETURN_BOX, { marginLeft: SUGGESTION.trailingGap - SUGGESTION.gap }]} /> : null}
          </View>
        </Pressable>
      </View>
    );
  },
  (a, b) => a.selected === b.selected && a.scopeHint === b.scopeHint && a.actions === b.actions && sameSuggestion(a.suggestion, b.suggestion),
);
