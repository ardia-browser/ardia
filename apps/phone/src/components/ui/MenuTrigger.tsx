import { actionSheet, ContextMenuView, nativeMenusAvailable, settingsUI, type MenuItem as NativeMenuItem } from "@ardia/phone-native";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { findNodeHandle, Platform, View, type GestureResponderEvent, type StyleProp, type ViewInstance, type ViewStyle } from "react-native";
import type { MenuAlign, Point } from "../../lib/menuPlace";
import { menuSfName } from "./sfSymbolNames";
import { handFocusOver } from "./coverFocus";
import { useFocusReturn } from "./focusReturn";
import type { Confirmation } from "./Dialog";
import { FloatingMenu, isSubmenu, useMenuFloor, useMenuFrost, type MenuAction, type MenuItem, type MenuSubmenu } from "./Menu";
import { useTheme } from "./theme";
import { dismissWords } from "../../lib/sharedWords";

export type MenuHandlers = { onPress?: (event?: GestureResponderEvent) => void; onLongPress?: (event?: GestureResponderEvent) => void; openFor?: (opener: unknown) => void };

export type MenuOpener = MutableRefObject<(() => void) | null>;

type Props = {
  opener?: MenuOpener;
  items: MenuItem[];
  trigger?: "tap" | "longPress";
  fixedOrder?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
  haptic?: () => void;
  disabled?: boolean;
  privately?: boolean;
  align?: MenuAlign;
  frost?: string | null;
  restoresAfterChoice?: boolean;
  place?: ViewStyle;
  previewRadius?: number;
  dark?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  children: (handlers: MenuHandlers) => ReactNode;
};

export type NativeMenu = { items: NativeMenuItem[]; actions: Map<string, () => void> };

export const nativeMenus = () => Platform.OS === "ios" && nativeMenusAvailable().contextMenu;

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

const image = (item: MenuAction | MenuSubmenu) => item.systemImage ?? menuSfName(item.icon);

function action(item: MenuAction, id: string, actions: Map<string, () => void>): NativeMenuItem {
  actions.set(id, item.onPress);
  return withoutEmpty({ id, title: item.label, systemImage: image(item), destructive: item.destructive, disabled: item.disabled, checked: item.checked });
}

function submenu(item: MenuSubmenu, id: string, actions: Map<string, () => void>): NativeMenuItem {
  return withoutEmpty({ id, title: item.label, systemImage: image(item), disabled: item.disabled, children: convert(item.children, `${id}.`, actions) });
}

const withoutEmpty = (item: NativeMenuItem): NativeMenuItem => Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined && value !== false)) as NativeMenuItem;

let nativeMenuOpened: (privately: boolean) => void = () => undefined;

export const onNativeMenuOpened = (handler: (privately: boolean) => void) => {
  nativeMenuOpened = handler;
};

export function MenuTrigger(props: Props) {
  return nativeMenus() ? <NativeTrigger {...props} /> : <DrawnTrigger {...props} />;
}

function NativeTrigger({ items, trigger = "longPress", fixedOrder, onOpen, onClose, disabled, privately = false, previewRadius, dark, style, testID, children }: Props) {
  const theme = useTheme();
  const menu = nativeMenu(items);
  const actions = useRef(menu.actions);
  actions.current = menu.actions;
  const select = useCallback((id: string) => actions.current.get(id)?.(), []);
  const opened = useCallback(() => {
    nativeMenuOpened(privately);
    onOpen?.();
  }, [onOpen, privately]);
  return (
    <ContextMenuView testID={testID} style={style} collapsable={false} items={disabled ? [] : menu.items} trigger={trigger} fixedOrder={fixedOrder} onSelect={select} onOpen={opened} onClose={onClose} previewRadius={previewRadius} appearance={{ dark: dark ?? theme.dark }}>
      {children({})}
    </ContextMenuView>
  );
}

const pressPoint = (event?: GestureResponderEvent): Point | null => {
  const touch = event?.nativeEvent;
  return touch && typeof touch.pageX === "number" && typeof touch.pageY === "number" ? { x: touch.pageX, y: touch.pageY } : null;
};

function DrawnTrigger({ opener: openerHandle, items, trigger = "longPress", onOpen, onClose, haptic, disabled = false, place, privately, align, frost: frostHere, restoresAfterChoice = false, style, testID, children }: Props) {
  const anchor = useRef<ViewInstance>(null);
  const opener = useRef<unknown>(null);
  const cancelRestore = useRef<() => void>(() => undefined);
  const returnFocus = useFocusReturn();
  useEffect(() => () => cancelRestore.current(), []);
  const frostAround = useMenuFrost();
  const frost = frostHere === undefined ? frostAround : frostHere;
  const floor = useMenuFloor();
  const [opened, setOpened] = useState<{ at: Point | null } | null>(null);
  useEffect(() => {
    if (!disabled) return;
    cancelRestore.current();
    if (!opened) return;
    setOpened(null);
    onClose?.();
  }, [disabled]);
  const open = useCallback(
    (event?: GestureResponderEvent, explicitOpener?: unknown) => {
      if (disabled) return;
      cancelRestore.current();
      haptic?.();
      opener.current = explicitOpener ?? event?.currentTarget ?? null;
      setOpened({ at: trigger === "longPress" ? pressPoint(event) : null });
      onOpen?.();
    },
    [disabled, haptic, onOpen, trigger],
  );
  const dismiss = useCallback(
    (chosen?: boolean) => {
      setOpened(null);
      onClose?.();
      cancelRestore.current();
      const target = () => (opener.current ?? anchor.current) as Parameters<typeof findNodeHandle>[0];
      if (chosen && !restoresAfterChoice) {
        handFocusOver(target);
        return;
      }
      const stopRestore = returnFocus(target);
      cancelRestore.current = () => {
        stopRestore();
        cancelRestore.current = () => undefined;
      };
    },
    [onClose, restoresAfterChoice, returnFocus],
  );
  const pendingOpen = useRef(false);
  useLayoutEffect(() => {
    if (!openerHandle) return;
    openerHandle.current = () => {
      if (disabled) {
        pendingOpen.current = true;
        return;
      }
      open(undefined, anchor.current);
    };
    return () => {
      openerHandle.current = null;
    };
  }, [openerHandle, disabled, open]);
  useEffect(() => {
    if (disabled || !pendingOpen.current) return;
    pendingOpen.current = false;
    open(undefined, anchor.current);
  }, [disabled, open]);
  const held = trigger === "longPress";
  return (
    <View ref={anchor} testID={testID} style={style} collapsable={false}>
      {children(held ? { onLongPress: open, openFor: (target) => open(undefined, target) } : { onPress: open, openFor: (target) => open(undefined, target) })}
      {opened && !disabled ? <FloatingMenu items={items} anchor={anchor} at={opened.at} floor={floor} align={align} place={place ?? {}} dimmed={held} privately={privately} frost={frost} onDismiss={dismiss} /> : null}
    </View>
  );
}

const nativeActionSheet = () => Platform.OS === "ios" && nativeMenusAvailable().actionSheet;

export function confirmInSheet(confirmation: Confirmation, drawn: () => void) {
  if (!nativeActionSheet()) {
    drawn();
    return;
  }
  void actionSheet({
    title: confirmation.title,
    message: confirmation.message,
    actions: [
      { id: "confirm", title: confirmation.action, destructive: confirmation.destructive !== false },
      { id: "cancel", title: dismissWords.cancel, cancel: true },
    ],
  }).then((chosen) => {
    if (chosen === "confirm") confirmation.run();
  });
}

