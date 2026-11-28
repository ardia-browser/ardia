import { useEffect, useState } from "react";
import { View } from "react-native";
import { PAIRING_CODE_DIGITS, pairingCodeInput, pairingCodeSecret, pairingPrompt, submitApplePasswordsCode, useApplePasswords } from "../../state/site/applePasswords";
import { cancelLoginListPairing, loginListPairingDone } from "../../state/site/loginListPairing";
import { Button, PanelCloseButton, Popover, POPOVER_WIDTH, Text, TextField } from "../ui";
import { PromptBody } from "./Prompts";

export function LoginListPairingPrompt({ tabId, right, top }: { tabId: string; right: number; top: number }) {
  const pairing = useApplePasswords((s) => s.pairing);
  const [code, setCode] = useState("");
  useEffect(() => {
    if (!pairing) loginListPairingDone(tabId);
  }, [pairing, tabId]);
  useEffect(() => {
    if (pairing?.error) setCode("");
  }, [pairing?.error]);
  if (!pairing) return null;
  const cancel = () => cancelLoginListPairing(tabId);
  const connect = () => {
    if (code.length === PAIRING_CODE_DIGITS) void submitApplePasswordsCode(pairingCodeSecret(code));
  };
  const entering = pairing.step === "code" || pairing.step === "checking";
  return (
    <Popover width={POPOVER_WIDTH.s} top={top} right={right} onDismiss={cancel}>
      <View>
        <PromptBody
          icons={["key.fill"]}
          title="Connect Apple Passwords"
          message={pairingPrompt(pairing.step)}
          detail={
            <>
              {entering ? <TextField value={code} onChangeText={(text) => setCode(pairingCodeInput(text))} onSubmit={connect} onEscape={cancel} autoFocus mono width={120} disabled={pairing.step === "checking"} /> : null}
              {pairing.error ? (
                <Text size="small" tone="destructive">
                  {pairing.error}
                </Text>
              ) : null}
            </>
          }
        >
          <Button variant="pill" title="Cancel" onPress={cancel} />
          {pairing.step === "failed" ? null : <Button variant="pill" title="Connect" primary disabled={pairing.step !== "code" || code.length !== PAIRING_CODE_DIGITS} onPress={connect} />}
        </PromptBody>
        <PanelCloseButton onPress={cancel} />
      </View>
    </Popover>
  );
}
