import { asSecret } from "@ardia/core";
import { useBrowser } from "../browser/store";
import { consumeCallbackUrls } from "../tabs/callbackUrls";
import { endpoints, form } from "./net";
import { connectGoogle } from "./sources";
import { secureRandomHex } from "../../platform/secureRandom";
import { base64Url, sha256 } from "../../lib/sha256";

const REDIRECT = "http://127.0.0.1:53682/ardia-oauth";
const SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";

let pending: { cancel(): void } | null = null;

function query(url: string): Map<string, string> {
  const search = url.split("#")[0]!.split("?")[1] ?? "";
  return new Map(
    search
      .split("&")
      .filter(Boolean)
      .map((pair) => pair.split("=").map((v) => decodeURIComponent(v.replace(/\+/g, " "))) as [string, string]),
  );
}

export function connectGoogleDrive(windowId: string, clientId: string, clientSecret: string): Promise<void> {
  pending?.cancel();
  const plainVerifier = secureRandomHex(64);
  const challenge = base64Url(sha256(plainVerifier));
  const verifier = asSecret("oauthToken", plainVerifier);
  const state = secureRandomHex(32);
  const url = `${endpoints.googleAuth}?${form({
    client_id: clientId.trim(),
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  })}`;
  const tabId = useBrowser.getState().newTab(windowId, { url });
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const attempt = { cancel: () => finish(new Error("Cancelled")) };
    const closeTab = () => {
      if (useBrowser.getState().tabs[tabId]) useBrowser.getState().closeTabs([tabId], { unrecorded: true });
    };
    const stopWatching = useBrowser.subscribeTo(["tabs"], (s) => {
      if (!s.tabs[tabId]) finish(new Error("Sign-in was cancelled"));
    });
    const stopGuarding = useBrowser.subscribeTo(["tabs"], (s) => {
      if (s.tabs[tabId]) return;
      stopGuarding();
      stopConsuming();
    });
    const stopConsuming = consumeCallbackUrls(tabId, (address) => {
      if (!address.startsWith(REDIRECT)) return false;
      if (settled) return true;
      const params = query(address);
      stopWatching();
      closeTab();
      if (params.get("state") !== state) {
        finish(new Error("Sign-in didn't match this request"));
        return true;
      }
      const code = params.get("code");
      if (!code) finish(new Error("Google didn't grant access"));
      else connectGoogle(clientId.trim(), clientSecret.trim(), asSecret("oauthToken", code), verifier, REDIRECT).then(() => finish(), finish);
      return true;
    });
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      stopWatching();
      closeTab();
      if (pending === attempt) pending = null;
      if (error) reject(error);
      else resolve();
    };
    pending = attempt;
  });
}
