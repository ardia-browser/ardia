import { useEffect, useState } from "react";
import type { ApplePasswordsState } from "../../../platform/applePasswords";
import { startApplePasswordsPairing, submitApplePasswordsCode, useApplePasswords } from "../../../state/site/applePasswords";
import { closeSettingsSheet, showSettingsSheet } from "../../../state/settings/sheet";
import { Box, Button, DialogActions, DialogTitle, Sheet, Text, TextField } from "../../ui";
import { Row } from "../Form";

const CODE_DIGITS = 6;
const FIELDS = { marginTop: 12 } as const;

const STATUS_TEXT: Record<ApplePasswordsState, string> = {
  connected: "Connected",
  notConnected: "Not connected",
  refused: "Apple Passwords isn't available on this Mac.",
  helperMissing: "Apple Passwords' browser helper isn't on this Mac.",
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
  const connect = async () => {
    if (code.length !== CODE_DIGITS) return;
    await submitApplePasswordsCode(code);
    if (!useApplePasswords.getState().pairing) closeSettingsSheet();
  };
  const prompt = pairing.step === "starting" ? "Opening the Passwords app…" : pairing.step === "failed" ? null : "Enter the six-digit code the Passwords app shows.";
  return (
    <Sheet size="s" onClose={closeSettingsSheet}>
      <DialogTitle>Connect Apple Passwords</DialogTitle>
      {prompt ? <Text>{prompt}</Text> : null}
      {pairing.step === "code" || pairing.step === "checking" ? (
        <Box row gap="m" style={FIELDS}>
          <TextField value={code} onChangeText={(text) => setCode(text.replace(/\D/g, "").slice(0, CODE_DIGITS))} onSubmit={() => void connect()} onEscape={closeSettingsSheet} autoFocus mono width={120} disabled={pairing.step === "checking"} />
        </Box>
      ) : null}
      {pairing.error ? (
        <Text size="caption" tone="destructive">
          {pairing.error}
        </Text>
      ) : null}
      <DialogActions>
        <Button title="Cancel" onPress={closeSettingsSheet} />
        {pairing.step === "failed" ? null : <Button title="Connect" kind="primary" disabled={pairing.step !== "code" || code.length !== CODE_DIGITS} onPress={() => void connect()} />}
      </DialogActions>
    </Sheet>
  );
}
