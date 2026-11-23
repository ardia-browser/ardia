import { asSecret, type Secret, type SecretFree } from "@ardia/core";
import { capture, queueLog } from "./client";
import { fittedEvent, fittedReply } from "../automation/socketWire";
import { keychainSetSecret } from "../../platform/keychain";
import { savePassword } from "../../platform/passwords";
import { SyncNative } from "../../platform/sync";
import { setSecret } from "../live/net";
import { enterRecoveryPhrase } from "../sync/engine";

export function refusedAtCompileTime(token: Secret<"oauthToken">) {
  const password = asSecret("password", "fixture");
  // @ts-expect-error a branded secret is refused by telemetry events
  capture("fixture", { token }, null);
  // @ts-expect-error a branded secret is refused nested inside telemetry events
  capture("fixture", { nested: { list: [password] } }, null);
  capture("fixture", { kind: token.kind, count: 1 }, null);
  // @ts-expect-error a branded secret is refused in raw telemetry properties
  capture("fixture", {}, null, { raw: { frames: [{ token }] } });
  capture("fixture", {}, null, { raw: { frames: [{ name: "f" }] } });
  // @ts-expect-error a branded secret is refused by log attributes
  queueLog("error", "fixture", { token }, null);
  // @ts-expect-error a branded secret is refused by control-socket replies
  fittedReply(1, { result: { token } }, undefined, null);
  // @ts-expect-error a branded secret is refused by control-socket events
  fittedEvent("tab.idle", 0, { password }, null);
  // @ts-expect-error a branded secret is refused by sync payload writes
  void SyncNative?.write("/folder", "scope", password);
  // @ts-expect-error a branded secret never passes for text
  const text: string = password;
  // @ts-expect-error only listed kinds make a secret
  asSecret("cookie", "fixture");
  // @ts-expect-error a secret of one kind isn't another kind
  void savePassword("profile", "https://example.com", "user", token);
  // @ts-expect-error the Keychain takes only a branded secret
  void keychainSetSecret("account", "plain");
  // @ts-expect-error live tokens are stored only as branded secrets
  void setSecret("github", "plain");
  // @ts-expect-error a recovery phrase is entered only as a branded secret
  void enterRecoveryPhrase("/folder", "plain words");
  const free: SecretFree<{ count: number; nested: { flag: boolean } }> = { count: 1, nested: { flag: true } };
  // @ts-expect-error SecretFree of a shape holding a secret is never
  const held: SecretFree<{ token: Secret }> = { token };
  return [text, free, held];
}
