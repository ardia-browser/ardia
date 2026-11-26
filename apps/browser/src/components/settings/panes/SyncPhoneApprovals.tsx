import { useState } from "react";
import { confirm } from "../../../state/app/system";
import { consentToken } from "../../../state/telemetry/client";
import type { ConsentToken } from "../../../state/telemetry/consentPeriod";
import { Button } from "../../ui";
import { forgetPhoneKey, phoneKeys, trustPhoneKey, type PhoneKey } from "../../../state/sync/vaultApprovals";
import type { SyncedDevice } from "../../../state/sync/syncDoc";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";

async function confirmTrust(key: PhoneKey, consent: ConsentToken | null) {
  const { confirmed } = await confirm({
    title: `Let “${key.name}” approve sign-ins?`,
    message: `On ${key.name}, a sign-in request shows its code. Trust it only if that code is ${key.fingerprint}. Once trusted, ${key.name} can let programs on this ${PLATFORM_TERMS.computer} sign in with your saved passwords, after Face ID.`,
    confirmTitle: "Trust",
  });
  return confirmed && trustPhoneKey(key.phone, key.fingerprint, consent);
}

async function confirmForget(key: PhoneKey) {
  const { confirmed } = await confirm({
    title: `Stop sign-in approvals from “${key.name}”?`,
    message: `${key.name} can't approve sign-ins for this ${PLATFORM_TERMS.computer} until you trust it again.`,
    confirmTitle: "Stop",
    destructive: true,
  });
  return confirmed && forgetPhoneKey(key.phone);
}

export function PhoneApprovalButton({ device }: { device: SyncedDevice }) {
  const [, changed] = useState(0);
  const key = phoneKeys().find((k) => k.phone === device.id);
  if (!key) return null;
  const press = () => void (key.trusted ? confirmForget(key) : confirmTrust(key, consentToken())).then(() => changed((n) => n + 1));
  return <Button title={key.trusted ? "Stop Sign-In Approvals…" : "Approve Sign-Ins…"} onPress={press} />;
}
