import { useEffect, useRef, useState } from "react";
import { StyleSheet } from "react-native";
import { BottomSheet, Button, Form, Group, HStack, Host, Image, Label, NavigationStack, ProgressView, Section, Text, Toggle, VStack } from "@expo/ui/swift-ui";
import {
  accessibilityElement,
  accessibilityHidden,
  buttonBorderShape,
  buttonStyle,
  controlSize,
  disabled,
  font,
  foregroundStyle,
  frame,
  interactiveDismissDisabled,
  listRowBackground,
  listRowInsets,
  listRowSeparator,
  navigationBarTitleDisplayMode,
  navigationTitle,
  presentationDetents,
  presentationDragIndicator,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { sync } from "../../platform/sync";
import { haptics } from "../../state/app/haptics";
import { useSync } from "../../state/sync/store";
import { askedBy, nextVaultRequest, sheetLatencyMs, siteName, timeLeft, type VaultRequest } from "../../state/sync/vaultRequests";
import { countUsage } from "../../state/telemetry/telemetry";

const PLUM = "#B25B6B";
const FILL = Number.MAX_SAFE_INTEGER;
const SECONDARY = { type: "hierarchical", style: "secondary" } as const;
const BUTTON_ROW = { top: 6, bottom: 6, leading: 0, trailing: 0 };
const ROUNDED = buttonBorderShape("roundedRectangle", 12);

export function VaultApprovalSheet() {
  const requests = useSync((s) => s.view.vaultRequests);
  const vaultKey = useSync((s) => s.view.vaultKey ?? null);
  const [setAside, setSetAside] = useState<ReadonlySet<string>>(() => new Set());
  const [, tick] = useState(0);
  const now = Date.now();
  const request = nextVaultRequest(requests, setAside, now);
  const shownId = useRef<string | null>(null);
  useEffect(() => {
    if (!request) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [request?.id]);
  useEffect(() => {
    if (!request || shownId.current === request.id) return;
    shownId.current = request.id;
    if (__DEV__) console.info(`[vault] sheet shown ${sheetLatencyMs(request, Date.now())} ms after the Mac asked`);
    countUsage("vault_requests_shown");
    if (!request.trusted) countUsage("vault_requests_untrusted");
    haptics.warning();
  }, [request?.id]);
  const needsKey = request !== null && !request.trusted && vaultKey === null;
  const [keyFailed, setKeyFailed] = useState(false);
  useEffect(() => {
    if (needsKey) void sync.prepareVaultKey().then((made) => setKeyFailed(made === null));
  }, [needsKey]);
  const putAside = (id: string) => setSetAside((was) => new Set(was).add(id));
  return (
    <Host testID="vaultApprovalSheet" style={styles.anchor} pointerEvents="none">
      <BottomSheet isPresented={request !== null} onIsPresentedChange={(presented) => (presented || !request ? undefined : putAside(request.id))}>
        {request ? <VaultApproval key={request.id} request={request} vaultKey={vaultKey} keyFailed={keyFailed} now={now} onDone={() => putAside(request.id)} /> : <Group>{null}</Group>}
      </BottomSheet>
    </Host>
  );
}

type Busy = "allow" | "deny" | null;

const PROBLEMS: Record<string, string> = {
  untrusted: "Your Mac doesn’t trust this iPhone yet, so it would ignore the answer.",
  unavailable: "This iPhone can’t sign an answer: it needs Face ID or a passcode.",
};

function VaultApproval({ request, vaultKey, keyFailed, now, onDone }: { request: VaultRequest; vaultKey: string | null; keyFailed: boolean; now: number; onDone: () => void }) {
  const [always, setAlways] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const answer = async (allow: boolean) => {
    if (busy) return;
    setBusy(allow ? "allow" : "deny");
    setProblem(null);
    const result = await sync.answerVaultRequest(request.id, allow, allow && always && request.alwaysOffered);
    setBusy(null);
    if (result === "sent") {
      countUsage(allow ? "vault_requests_allowed" : "vault_requests_denied");
      if (allow) haptics.success();
      onDone();
    } else if (result === "cancelled") {
      countUsage("vault_face_id_cancelled");
    } else if (result === "gone") {
      onDone();
    } else {
      haptics.error();
      setProblem(PROBLEMS[result] ?? "Your answer couldn’t be sent. Check that sync is on, then try again.");
    }
  };
  const ends = `Ends in ${timeLeft(request.expiresAt - now)}. The program never sees your passwords; Ardia fills them in on your Mac.`;
  const footer = <Text>{problem ?? ends}</Text>;
  return (
    <Group modifiers={[presentationDetents(["large"]), presentationDragIndicator("visible"), interactiveDismissDisabled(busy !== null)]}>
      <NavigationStack>
        <Form modifiers={[navigationTitle("Sign-In Request"), navigationBarTitleDisplayMode("inline"), tint(PLUM)]}>
          <Section>
            <HStack spacing={12} modifiers={[accessibilityElement("combine")]}>
              <Image systemName="key.horizontal.fill" modifiers={[font({ textStyle: "title2", weight: "semibold" }), foregroundStyle(PLUM), frame({ width: 32 }), accessibilityHidden(true)]} />
              <VStack alignment="leading" spacing={2}>
                <Text modifiers={[font({ textStyle: "headline" })]}>{request.program}</Text>
                <Text modifiers={[font({ textStyle: "subheadline" }), foregroundStyle(SECONDARY)]}>{`Asks to sign in from ${askedBy(request)}`}</Text>
              </VStack>
            </HStack>
          </Section>
          <Section title={request.sites.length === 1 ? "Site" : "Sites"}>
            {request.sites.map((site) => (
              <Label key={site} title={siteName(site)} systemImage="lock.fill" />
            ))}
          </Section>
          {request.why ? (
            <Section title="Reason Given">
              <Text>{request.why}</Text>
            </Section>
          ) : null}
          {request.trusted ? null : (
            <Section title="Trust This iPhone First" footer={<Text>{`On ${request.fromDevice?.trim() || "your Mac"}, open Ardia’s Settings › Sync and choose Approve Sign-Ins… next to this iPhone. Trust it only if the code there matches this one.`}</Text>}>
              {vaultKey ? (
                <Text modifiers={[font({ textStyle: "title3", weight: "semibold", design: "monospaced" }), foregroundStyle(PLUM)]}>{vaultKey}</Text>
              ) : keyFailed ? (
                <Text modifiers={[foregroundStyle(SECONDARY)]}>{PROBLEMS.unavailable}</Text>
              ) : (
                <ProgressView />
              )}
            </Section>
          )}
          {request.trusted && request.alwaysOffered ? (
            <Section>
              <Toggle isOn={always} onIsOnChange={setAlways} label={`Always Allow ${request.program} on ${request.sites.length === 1 ? "This Site" : "These Sites"}`} modifiers={[disabled(busy !== null)]} />
            </Section>
          ) : null}
          <Section footer={footer} modifiers={[listRowBackground("clear"), listRowInsets(BUTTON_ROW), listRowSeparator("hidden")]}>
            {request.trusted ? (
              <Button onPress={() => void answer(true)} modifiers={[buttonStyle("borderedProminent"), ROUNDED, controlSize("large"), tint(PLUM), disabled(busy !== null)]}>
                {busy === "allow" ? <ProgressView modifiers={[frame({ maxWidth: FILL })]} /> : <Label title="Allow with Face ID" systemImage="faceid" modifiers={[frame({ maxWidth: FILL })]} />}
              </Button>
            ) : null}
            <Button onPress={() => void answer(false)} modifiers={[buttonStyle("bordered"), ROUNDED, controlSize("large"), disabled(busy !== null)]}>
              {busy === "deny" ? <ProgressView modifiers={[frame({ maxWidth: FILL })]} /> : <Text modifiers={[frame({ maxWidth: FILL })]}>Don’t Allow</Text>}
            </Button>
          </Section>
        </Form>
      </NavigationStack>
    </Group>
  );
}

const styles = StyleSheet.create({ anchor: { position: "absolute", width: 0, height: 0 } });
