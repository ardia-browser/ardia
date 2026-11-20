import { memo, useImperativeHandle, useRef, type ReactNode, type Ref } from "react";
import { TextInput, View } from "react-native";
import { Button, concentric, font, space, Symbol, useHover, useTheme } from "../ui";
import { SidebarFieldFill } from "../sidebar/SidebarField";
import { SEARCH_KEYS, searchKeyAction } from "./libraryKeys";
import { LIBRARY } from "./tokens";
import { useLibraryFocus } from "./useLibraryFocus";

const S = LIBRARY.search;
const BUTTON_INSET = space.xs;

export const searchFieldButton = () => ({ box: S.height - 2 * BUTTON_INSET, radius: concentric(S.radius, BUTTON_INSET) });

export const LibrarySearch = memo(function LibrarySearch({
  value,
  placeholder,
  inputRef,
  onChange,
  onEscape,
  onEnterList,
  trailing,
}: {
  value: string;
  placeholder: string;
  inputRef?: Ref<TextInput>;
  onChange: (text: string) => void;
  onEscape: () => void;
  onEnterList: () => void;
  trailing?: ReactNode;
}) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const input = useRef<TextInput>(null);
  useImperativeHandle(inputRef, () => input.current!, []);
  const focus = useLibraryFocus(input);
  return (
    <View {...hoverProps} style={{ height: S.height, flexDirection: "row", alignItems: "center", paddingLeft: space.ml, paddingRight: BUTTON_INSET, gap: space.s }}>
      <SidebarFieldFill hovered={hovered} />
      <Symbol name="magnifyingglass" size={S.glyph} color={theme.textSecondary} style={{ width: S.glyphBox, height: S.glyphBox }} />
      <TextInput
        ref={input}
        {...focus}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={theme.placeholder}
        selectionColor={theme.selection}
        enableFocusRing={false}
        accessibilityLabel={placeholder}
        keyDownEvents={SEARCH_KEYS}
        onKeyDown={({ nativeEvent }) => {
          const action = searchKeyAction(nativeEvent);
          if (action === "escape") onEscape();
          else if (action === "enterList") onEnterList();
        }}
        style={{ flex: 1, ...font.body, color: theme.textPrimary, paddingVertical: 0 }}
      />
      {value ? <Button variant="icon" icon="xmark.circle.fill" size="m" {...searchFieldButton()} onPress={() => onChange("")} tooltip="Clear" /> : null}
      {trailing}
    </View>
  );
});
