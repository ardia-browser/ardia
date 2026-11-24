import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { View } from "react-native";
import type { PluginNode } from "../../lib/pluginProtocol";
import { handledKeysOf, mergeShortcutBindings, pressedBinding, type ShortcutBinding, type ShortcutKeyEvent, type ShortcutRegistration } from "../../lib/pluginShortcuts";
import { chooseFromMenu } from "../../state/app/menuChoice";
import { copyText } from "../../state/app/system";
import { useShortcutAssignments } from "../../state/commands/commandShortcuts";
import { COMMAND_KEY } from "../../state/commands/keyNotation";
import { newTab } from "../../state/tabs/actions";
import { consentToken } from "../../state/telemetry/client";
import { notePlugin } from "../../state/telemetry/pluginCounts";
import { Box, Button } from "../ui";
import { actionsIn, bool, isHandlerRef, isWebUrl, str, useSurface } from "./surfaceNodes";
import { heldByArdia, menuKeyOf, panelShortcuts, ShortcutScopeContext, shortcutHint, useShortcutRegistration, type ShortcutScope, type SurfaceKeys } from "./surfaceShortcuts";

export function useRunAction() {
  const { fire, windowId } = useSurface();
  return useCallback(
    (action: PluginNode | undefined, args: unknown[] = []): boolean => {
      if (!action) return false;
      const { onAction, url, copy } = action.props;
      let ran = false;
      if (isWebUrl(url)) {
        newTab(windowId, { url });
        ran = true;
      } else if (typeof copy === "string") {
        void copyText(copy);
        ran = true;
      }
      if (isHandlerRef(onAction)) return fire(onAction, args) || ran;
      return ran;
    },
    [fire, windowId],
  );
}

export function SurfaceShortcutScope({ onKeys, children }: { onKeys?: (keys: SurfaceKeys | null) => void; children: ReactNode }) {
  const run = useRunAction();
  const registrations = useRef(new Map<string, ShortcutRegistration<PluginNode>>());
  const nextSeq = useRef(0);
  const [bindings, setBindings] = useState<readonly ShortcutBinding<PluginNode>[]>([]);
  const latest = useRef(bindings);
  latest.current = bindings;
  const register = useCallback((id: string, depth: number, list: readonly ShortcutBinding<PluginNode>[] | null) => {
    const all = registrations.current;
    if (list === null) {
      if (!all.delete(id)) return;
    } else {
      const known = all.get(id);
      if (!known && !list.length) return;
      all.set(id, { depth, seq: known?.seq ?? nextSeq.current++, bindings: list });
    }
    setBindings(mergeShortcutBindings(all.values(), heldByArdia));
  }, []);
  const press = useCallback(
    (e: ShortcutKeyEvent) => {
      const consent = consentToken();
      const hit = pressedBinding(latest.current, e, COMMAND_KEY);
      if (!hit || heldByArdia(hit.shortcut)) return false;
      if (run(hit.action)) notePlugin("plugin_action_shortcuts", consent);
      return true;
    },
    [run],
  );
  const assignments = useShortcutAssignments();
  useEffect(() => {
    if (registrations.current.size) setBindings(mergeShortcutBindings(registrations.current.values(), heldByArdia));
  }, [assignments]);
  const keys = useMemo(() => handledKeysOf(bindings, COMMAND_KEY), [bindings]);
  const scope = useMemo<ShortcutScope>(() => ({ keys, press, register, depth: 0 }), [keys, press, register]);
  useEffect(() => {
    onKeys?.(keys.length ? { keys, press } : null);
  }, [onKeys, keys, press]);
  useEffect(() => () => onKeys?.(null), [onKeys]);
  return <ShortcutScopeContext.Provider value={scope}>{children}</ShortcutScopeContext.Provider>;
}

export function useActionMenu() {
  const run = useRunAction();
  return useCallback(
    async (panel: unknown) => {
      const actions = actionsIn(panel);
      if (!actions.length) return;
      const shortcuts = panelShortcuts(actions);
      const chosen = await chooseFromMenu<number>(actions.map((a, index) => ({ value: index, title: str(a.props.title) ?? "Action", symbol: str(a.props.icon), ...menuKeyOf(shortcuts.get(a)) })));
      if (chosen !== null) run(actions[chosen]);
    },
    [run],
  );
}

export function ActionButtons({ panel, primaryFirst = true }: { panel: unknown; primaryFirst?: boolean }) {
  const run = useRunAction();
  const actions = useMemo(() => actionsIn(panel), [panel]);
  useShortcutRegistration(actions);
  if (!actions.length) return null;
  const shortcuts = panelShortcuts(actions);
  return (
    <Box row gap="s" style={ROW}>
      {actions.map((action, index) => (
        <WithShortcutHint key={`${index}:${str(action.props.title) ?? ""}`} hint={shortcutHint(shortcuts.get(action))}>
          <Button
            title={str(action.props.title) ?? "Action"}
            icon={str(action.props.icon)}
            kind={bool(action.props.destructive) || action.props.tone === "destructive" ? "destructive" : primaryFirst && index === 0 ? "primary" : "default"}
            onPress={() => void run(action)}
          />
        </WithShortcutHint>
      ))}
    </Box>
  );
}

export function WithShortcutHint({ hint, children }: { hint: string | undefined; children: ReactNode }) {
  return hint ? <View tooltip={hint}>{children}</View> : <>{children}</>;
}

export function ActionMenuButton({ panel, tooltip = "Actions" }: { panel: unknown; tooltip?: string }) {
  const menu = useActionMenu();
  if (!actionsIn(panel).length) return null;
  return <Button variant="icon" size="s" icon="ellipsis" tooltip={tooltip} onPress={() => void menu(panel)} />;
}

const ROW = { flexWrap: "wrap", justifyContent: "flex-end" } as const;
