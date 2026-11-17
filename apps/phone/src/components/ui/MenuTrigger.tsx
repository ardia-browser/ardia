import { actionSheet, ContextMenuView, nativeMenusAvailable, settingsUI, type ContextMenuHandle, type MenuItem as NativeMenuItem } from "@ardia/phone-native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform, StyleSheet, View, type StyleProp, type ViewInstance, type ViewStyle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import { sfName } from "../../lib/sfSymbols";
import type { Confirmation } from "./Dialog";
import { FloatingMenu, isSubmenu, Menu, type MenuAction, type MenuItem, type MenuSubmenu } from "./Menu";
import { tabsMotion } from "./motion";
import { Portal } from "./Overlay";
import { useTheme } from "./theme";

export type MenuHandlers = { onPress?: () => void; onLongPress?: () => void };

type Props = {
  items: MenuItem[];
  trigger?: "tap" | "longPress";
  fixedOrder?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
  haptic?: () => void;
  disabled?: boolean;
  place?: ViewStyle;
  dark?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  children: (handlers: MenuHandlers) => ReactNode;
};

export type NativeMenu = { items: NativeMenuItem[]; actions: Map<string, () => void> };

export const nativeMenus = () => nativeMenusAvailable().contextMenu;

export const spaceSystemImage = (name: string, icon: string | null): string | undefined => settingsUI.spaceMenuSymbol(name, icon) ?? undefined;

type Group = { title: string | null; items: NativeMenuItem[] };

export function nativeMenu(items: MenuItem[]): NativeMenu {
  const actions = new Map<string, () => void>();
  return { items: convert(items, "", actions), actions };
}

function convert(items: MenuItem[], prefix: string, actions: Map<string, () => void>): NativeMenuItem[] {
  const groups: Group[] = [{ title: null, items: [] }];
  items.forEach((item, index) => {
    const id = `${prefix}${index}`;
    if (item === "divider") groups.push({ title: null, items: [] });
    else if ("heading" in item) groups.push({ title: item.heading, items: [] });
    else groups[groups.length - 1]!.items.push(isSubmenu(item) ? submenu(item, id, actions) : action(item, id, actions));
  });
  const filled = groups.filter((group) => group.items.length > 0);
  if (filled.length === 1 && filled[0]!.title === null) return filled[0]!.items;
  return filled.map((group, at) => (group.title === null && at === 0 ? group.items : [{ id: `${prefix}g${at}`, title: group.title ?? "", inline: true, children: group.items }])).flat();
}

const image = (item: MenuAction | MenuSubmenu) => item.systemImage ?? sfName(item.icon);

function action(item: MenuAction, id: string, actions: Map<string, () => void>): NativeMenuItem {
  actions.set(id, item.onPress);
  return withoutEmpty({ id, title: item.label, systemImage: image(item), destructive: item.destructive, disabled: item.disabled, checked: item.checked });
}

function submenu(item: MenuSubmenu, id: string, actions: Map<string, () => void>): NativeMenuItem {
  return withoutEmpty({ id, title: item.label, systemImage: image(item), disabled: item.disabled, children: convert(item.children, `${id}.`, actions) });
}

const withoutEmpty = (item: NativeMenuItem): NativeMenuItem => Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined && value !== false)) as NativeMenuItem;

let nativeMenuOpened: () => void = () => undefined;

export const onNativeMenuOpened = (handler: () => void) => {
  nativeMenuOpened = handler;
};

export function MenuTrigger(props: Props) {
  return nativeMenus() ? <NativeTrigger {...props} /> : <DrawnTrigger {...props} />;
}

function NativeTrigger({ items, trigger = "longPress", fixedOrder, onOpen, onClose, disabled, dark, style, testID, children }: Props) {
  const theme = useTheme();
  const menu = nativeMenu(items);
  const actions = useRef(menu.actions);
  actions.current = menu.actions;
  const select = useCallback((id: string) => actions.current.get(id)?.(), []);
  const opened = useCallback(() => {
    nativeMenuOpened();
    onOpen?.();
  }, [onOpen]);
  const native = useRef<ContextMenuHandle>(null);
  const show = useCallback(() => void native.current?.show(), []);
  const showAt = useCallback((x: number, y: number) => void native.current?.show(x, y), []);
  const android = Platform.OS === "android";
  const handlers: MenuHandlers = !android || disabled ? {} : trigger === "tap" ? { onPress: show } : { onLongPress: show };
  const press = useMemo(
    () =>
      Gesture.LongPress()
        .withTestId(testID ? `${testID}LongPress` : "menuLongPress")
        .enabled(android && trigger === "longPress" && !disabled)
        .minDuration(tabsMotion.longPress)
        .onStart((event) => {
          runOnJS(showAt)(event.x, event.y);
        }),
    [android, trigger, disabled, testID, showAt],
  );
  const content = children(handlers);
  return (
    <ContextMenuView ref={native} testID={testID} style={style} collapsable={false} items={disabled ? [] : menu.items} trigger={trigger} fixedOrder={fixedOrder} onSelect={select} onOpen={opened} onClose={onClose} appearance={{ dark: dark ?? theme.dark }}>
      {android && trigger === "longPress" ? (
        <GestureDetector gesture={press}>
          <View style={styles.pressArea} collapsable={false}>
            {content}
          </View>
        </GestureDetector>
      ) : (
        content
      )}
    </ContextMenuView>
  );
}

function DrawnTrigger({ items, trigger = "longPress", onOpen, onClose, haptic, disabled = false, place, style, testID, children }: Props) {
  const anchor = useRef<ViewInstance>(null);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (!disabled || !opened) return;
    setOpened(false);
    onClose?.();
  }, [disabled]);
  const open = useCallback(() => {
    if (disabled) return;
    haptic?.();
    setOpened(true);
    onOpen?.();
  }, [disabled, haptic, onOpen]);
  const dismiss = useCallback(() => {
    setOpened(false);
    onClose?.();
  }, [onClose]);
  return (
    <View ref={anchor} testID={testID} style={style} collapsable={false}>
      {children(trigger === "tap" ? { onPress: open } : { onLongPress: open })}
      {opened && !disabled ? (
        place && (place.top !== undefined || place.bottom !== undefined) ? (
          <Portal>
            <Menu items={items} place={place} onDismiss={dismiss} />
          </Portal>
        ) : (
          <FloatingMenu items={items} anchor={anchor} place={place ?? {}} onDismiss={dismiss} />
        )
      ) : null}
    </View>
  );
}

export function confirmInSheet(confirmation: Confirmation, drawn: () => void) {
  if (!nativeMenusAvailable().actionSheet) {
    drawn();
    return;
  }
  void actionSheet({
    title: confirmation.title,
    message: confirmation.message,
    actions: [
      { id: "confirm", title: confirmation.action, destructive: confirmation.destructive !== false },
      { id: "cancel", title: "Cancel", cancel: true },
    ],
  }).then((chosen) => {
    if (chosen === "confirm") confirmation.run();
  });
}

const styles = StyleSheet.create({ pressArea: { flexGrow: 1, alignSelf: "stretch" } });
