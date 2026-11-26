import { useEffect, useState } from "react";
import { cancelPairing, PAIRING_CODE_DIGITS, pairingCodeInput, pairingPrompt, startApplePasswordsPairing, submitApplePasswordsCode, useApplePasswords, type ApplePasswordsState } from "../../../state/site/applePasswords";
import { closeSettingsSheet, showSettingsSheet } from "../../../state/settings/sheet";
import { Box, Button, DialogActions, DialogTitle, Sheet, space, Text, TextField } from "../../ui";
import { Row } from "../Form";

const FIELDS = { marginTop: space.l } as const;
const ERROR = { marginTop: space.ml } as const;

const STATUS_TEXT: Record<ApplePasswordsState, string> = {
  connected: "Connected",
  notConnected: "Not connected",
  refused: "Apple Passwords isn't available on this Mac.",
  helperMissing: "Apple Passwords' browser helper is missing from this Mac. Update macOS in System Settings › General › Software Update, then try again.",
  tooOld: "Needs macOS 15.4 or later.",
  notEntitled: "This copy of Ardia can't use Apple Passwords.",
};

export function connectApplePasswords(profileId: string | null) {
  void startApplePasswordsPairing(profileId);
  showSettingsSheet(<ApplePasswordsPairingSheet />);
}

export function ApplePasswordsStatusRow() {
  const state = useApplePasswords((s) => s.state);
  if (!state) return null;
  return (
    <Row title="Apple Passwords" description={STATUS_TEXT[state]}>
      {state === "notConnected" ? <Button title="Connect" onPress={() => connectApplePasswords(null)} /> : null}
    </Row>
  );
}

function ApplePasswordsPairingSheet() {
  const pairing = useApplePasswords((s) => s.pairing);
  const [code, setCode] = useState("");
  useEffect(() => {
    if (!pairing) closeSettingsSheet();
  }, [pairing]);
  useEffect(() => {
    if (pairing?.error) setCode("");
  }, [pairing?.error]);
  if (!pairing) return null;
  const cancel = () => {
    cancelPairing();
    closeSettingsSheet();
  };
  const connect = async () => {
    if (code.length !== PAIRING_CODE_DIGITS) return;
    if (await submitApplePasswordsCode(code)) closeSettingsSheet();
  };
  const prompt = pairingPrompt(pairing.step);
  return (
    <Sheet size="s" onClose={cancel}>
      <DialogTitle>Connect Apple Passwords</DialogTitle>
      {prompt ? <Text>{prompt}</Text> : null}
      {pairing.step === "code" || pairing.step === "checking" ? (
        <Box row gap="m" style={FIELDS}>
          <TextField value={code} onChangeText={(text) => setCode(pairingCodeInput(text))} onSubmit={() => void connect()} onEscape={cancel} autoFocus mono width={120} disabled={pairing.step === "checking"} />
        </Box>
      ) : null}
      {pairing.error ? (
        <Text size="caption" tone="destructive" style={ERROR}>
          {pairing.error}
        </Text>
      ) : null}
      <DialogActions>
        <Button title="Cancel" onPress={cancel} />
        {pairing.step === "failed" ? null : <Button title="Connect" kind="primary" disabled={pairing.step !== "code" || code.length !== PAIRING_CODE_DIGITS} onPress={() => void connect()} />}
      </DialogActions>
    </Sheet>
  );
}
