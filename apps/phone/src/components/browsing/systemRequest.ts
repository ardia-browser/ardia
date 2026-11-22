import { ActionSheetIOS, Alert, type AlertButton } from "react-native";
import { confirmAnswer, type Request, type RequestAnswer, type RequestDialog } from "../../state/page/pagePrompts";

type Credentials = { login?: string; password?: string };

export function presentSystemRequest(request: Request, dialog: RequestDialog, answer: (answer: RequestAnswer) => void) {
  const dismiss: RequestAnswer = { type: "dismiss" };
  if (dialog.choices.length) {
    const cancelIndex = dialog.choices.length;
    ActionSheetIOS.showActionSheetWithOptions(
      { title: dialog.title || undefined, message: dialog.message ?? undefined, options: [...dialog.choices.map((choice) => choice.title), dialog.cancel ?? "Cancel"], cancelButtonIndex: cancelIndex },
      (index) => answer(index < cancelIndex ? dialog.choices[index]!.answer : dismiss),
    );
    return;
  }
  const cancel: AlertButton[] = dialog.cancel ? [{ text: dialog.cancel, style: "cancel", onPress: () => answer(dismiss) }] : [];
  if (dialog.field === "text") {
    Alert.prompt(dialog.title, dialog.message ?? undefined, [...cancel, { text: dialog.confirm, onPress: (value?: string) => answer(confirmAnswer(request, value ?? "", "", "")) }], "plain-text", dialog.defaultText);
    return;
  }
  if (dialog.field === "credentials") {
    Alert.prompt(
      dialog.title,
      dialog.message ?? undefined,
      [
        ...cancel,
        {
          text: dialog.confirm,
          onPress: (value?: unknown) => {
            const typed = (value ?? {}) as Credentials;
            answer(confirmAnswer(request, "", typed.login ?? "", typed.password ?? ""));
          },
        },
      ],
      "login-password",
    );
    return;
  }
  Alert.alert(dialog.title, dialog.message ?? undefined, [...cancel, { text: dialog.confirm, onPress: () => answer(confirmAnswer(request, "", "", "")) }], { cancelable: false });
}
