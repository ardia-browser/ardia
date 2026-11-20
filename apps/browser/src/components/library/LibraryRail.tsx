import { memo, useContext, useState } from "react";
import { Animated, Pressable, View } from "react-native";
import { libraryOf, type LibrarySection } from "../../state/library/library";
import { Button, Symbol, Text, useHover, useTheme } from "../ui";
import { plainKey } from "./libraryKeys";
import { LibraryWindowContext, useLibraryFocus } from "./useLibraryFocus";
import { LIBRARY, LIBRARY_SYMBOLS, LIBRARY_TITLES } from "./tokens";

const R = LIBRARY.rail;
const RAIL = { width: R.width, height: "100%" } as const;
const ITEMS = { flex: 1, justifyContent: "center", alignItems: "center", gap: R.gap } as const;
const BACK = { position: "absolute", left: R.inset, bottom: R.backBottom } as const;
const ITEM_KEYS = [{ key: "ArrowDown" }, { key: "ArrowUp" }, { key: "Enter" }, { key: " " }, { key: "Escape" }];

export const LibraryRail = memo(function LibraryRail({
  sections,
  section,
  onSelect,
  onBack,
  onEscape,
}: {
  sections: readonly LibrarySection[];
  section: LibrarySection;
  onSelect: (section: LibrarySection) => void;
  onBack: () => void;
  onEscape: () => void;
}) {
  const step = (from: LibrarySection, by: number) => {
    const at = sections.indexOf(from);
    const next = sections[Math.max(0, Math.min(sections.length - 1, at + by))];
    if (next) onSelect(next);
  };
  return (
    <View style={RAIL} accessibilityRole="tablist">
      <View style={ITEMS}>
        {sections.map((s) => (
          <RailItem key={s} section={s} selected={s === section} onSelect={onSelect} onStep={step} onEscape={onEscape} />
        ))}
      </View>
      <View style={BACK}>
        <Button variant="icon" icon="chevron.left" size={R.backSize} onPress={onBack} tooltip="Back" />
      </View>
    </View>
  );
});

const RailItem = memo(function RailItem({
  section,
  selected,
  onSelect,
  onStep,
  onEscape,
}: {
  section: LibrarySection;
  selected: boolean;
  onSelect: (section: LibrarySection) => void;
  onStep: (from: LibrarySection, by: number) => void;
  onEscape: () => void;
}) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const [bounce, setBounce] = useState(0);
  const windowId = useContext(LibraryWindowContext);
  const focus = useLibraryFocus();
  const title = LIBRARY_TITLES[section];
  return (
    <View {...hoverProps}>
      <Pressable
        {...focus}
        focusable
        accessibilityRole="tab"
        accessibilityLabel={title}
        accessibilityState={{ selected }}
        keyDownEvents={ITEM_KEYS}
        onKeyDown={({ nativeEvent }) => {
          if (!libraryOf(windowId).open) return;
          const key = plainKey(nativeEvent);
          if (key === "Escape") onEscape();
          else if (key === "ArrowDown") onStep(section, 1);
          else if (key === "ArrowUp") onStep(section, -1);
          else if (key === "Enter" || key === " ") onSelect(section);
        }}
        onPress={() => onSelect(section)}
        onPressIn={() => {
          onSelect(section);
          setBounce((count) => count + 1);
        }}
      >
        {({ pressed }) => (
          <Animated.View
            style={[
              {
                width: R.width - 2 * R.inset,
                height: R.item,
                borderRadius: LIBRARY.list.radius,
                alignItems: "center",
                justifyContent: "center",
                gap: R.labelGap,
                backgroundColor: selected ? theme.tabSelected : pressed ? theme.tabPressed : hovered ? theme.tabHover : undefined,
              },
            ]}
          >
            <Symbol name={LIBRARY_SYMBOLS[section]} size={R.glyph} weight={selected ? "semibold" : "regular"} color={selected ? theme.textPrimary : theme.icon} bounce={bounce} style={{ width: R.glyphBox, height: R.glyphBox }} />
            <Text size="caption" weight="semibold" tone={selected ? "textPrimary" : "textSecondary"} lines={1}>
              {title}
            </Text>
          </Animated.View>
        )}
      </Pressable>
    </View>
  );
});
