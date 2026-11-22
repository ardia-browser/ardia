import { useEffect, useState } from "react";
import { Platform, StyleSheet, TextInput } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { answerRequest, dismissPress, pressAction } from "../../state/page/actions";
import { usePageRequest, usePress } from "../../state/page/hooks";
import { confirmAnswer, pressHeading, pressMenuGroups, PRESS_TITLES, requestPlan, type PressAction, type Request } from "../../state/page/pagePrompts";
import { presentSystemRequest } from "./systemRequest";
import { ActionSheet, Dialog, dialogLayout, font, Menu, menuExitMs, menuLook, pointPlacer, Portal, radius, space, useTheme, type MenuItem, type SymbolName } from "../ui";
import { currentTabs } from "../../state/tabs/store";
import { findTab } from "../../state/tabs/tabsState";

export function PageRequestHost({ tabId }: { tabId: string }) {
  const request = usePageRequest(tabId);
  if (!request) return null;
  return <RequestDialog key={request.id} tabId={tabId} request={request} />;
}

function RequestDialog({ tabId, request }: { tabId: string; request: Request }) {
  const theme = useTheme();
  const plan = requestPlan(request);
  const [text, setText] = useState(plan.kind === "dialog" ? plan.dialog.defaultText : "");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  useEffect(() => {
    if (plan.kind === "answer") answerRequest(tabId, request, plan.answer);
    else if (SYSTEM_DIALOGS) presentSystemRequest(request, plan.dialog, (answer) => answerRequest(tabId, request, answer));
  }, []);
  if (plan.kind === "answer" || SYSTEM_DIALOGS) return null;
  const dialog = plan.dialog;
  const dismiss = () => answerRequest(tabId, request, { type: "dismiss" });
  const confirm = () => answerRequest(tabId, request, confirmAnswer(request, text, user, password));
  const field = (value: string, onChange: (value: string) => void, label: string, secure = false) => (
    <TextInput
      accessibilityLabel={label}
      value={value}
      onChangeText={onChange}
      placeholder={label}
      placeholderTextColor={theme.foregroundTertiary}
      selectionColor={theme.spaceAccentInk}
      secureTextEntry={secure}
      autoCapitalize="none"
      autoCorrect={false}
      style={[font.body, styles.field, { color: theme.label, borderColor: theme.separator }]}
    />
  );
  if (dialog.choices.length)
    return <ActionSheet title={dialog.title || null} message={dialog.message} cancel={dialog.cancel ?? "Cancel"} onCancel={dismiss} actions={dialog.choices.map((choice) => ({ title: choice.title, onPress: () => answerRequest(tabId, request, choice.answer) }))} />;
  return (
    <Dialog
      title={dialog.title}
      message={dialog.message}
      onDismiss={dialog.cancel ? dismiss : confirm}
      buttons={[...(dialog.cancel ? [{ title: dialog.cancel, onPress: dismiss }] : []), { title: dialog.confirm, onPress: confirm }]}
    >
      {dialog.field === "text" ? field(text, setText, "Text") : null}
      {dialog.field === "credentials" ? (
        <>
          {field(user, setUser, "User Name")}
          {field(password, setPassword, "Password", true)}
        </>
      ) : null}
    </Dialog>
  );
}

const SYSTEM_DIALOGS = Platform.OS === "ios";

const PRESS_ICONS: Record<PressAction, SymbolName> = {
  openInNewTab: "plusSquareOnSquare",
  openInBackground: "squareOnSquare",
  copyLink: "link",
  share: "squareAndArrowUp",
  download: "arrowDownCircle",
  saveImage: "arrowDownCircle",
};

export function PressMenu({ width, height }: { width: number; height: number }) {
  const press = usePress();
  const insets = useSafeAreaInsets();
  if (!press) return null;
  const items: MenuItem[] = [{ heading: pressHeading(press.target) }];
  for (const group of pressMenuGroups(press.target)) {
    items.push("divider");
    for (const action of group) items.push({ label: PRESS_TITLES[action], icon: PRESS_ICONS[action], onPress: () => pressAction(press, action) });
  }
  const placer = pointPlacer({ x: press.x, y: press.y + insets.top }, { width, height }, insets, menuLook.width);
  return (
    <Portal exitMs={menuExitMs(true)}>
      <Menu items={items} placer={placer} dimmed frost={null} privately={pressedPrivately(press.tabId)} onDismiss={dismissPress} />
    </Portal>
  );
}

const pressedPrivately = (tabId: string) => findTab(currentTabs(), tabId)?.isPrivate === true;

const styles = StyleSheet.create({
  field: { minHeight: dialogLayout.fieldHeight, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.row, paddingHorizontal: space.m },
});
