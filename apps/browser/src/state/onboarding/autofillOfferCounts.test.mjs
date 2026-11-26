import assert from "node:assert/strict";
import { after, test } from "node:test";

const native = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("../telemetry/client.ts");
const { takePasswordManagerCounts } = await import("../telemetry/passwordManagerCounts.ts");
const { useBrowser } = await import("../browser/store.ts");
const { usePlugins } = await import("../plugins/store.ts");
const { loadApplePasswords } = await import("../site/applePasswords.ts");
const { startOnboarding, useOnboarding } = await import("./onboarding.ts");
const { forgetOnboardingProgress } = await import("./onboardingDocument.ts");
const step = await import("./autofillStep.ts");
after(() => client.setSharing(false, "settings"));

usePlugins.setState({ scanned: true });
const S = () => useBrowser.getState();
const flush = () => new Promise((r) => setImmediate(r));

async function atStep() {
  forgetOnboardingProgress();
  step.resetAutofillStep();
  native.applePasswords.state = "notConnected";
  native.contacts.status = "notDetermined";
  native.contacts.answer = "authorized";
  S().hydrate({});
  const id = S().createWindow({ url: "https://a.test/" });
  await loadApplePasswords();
  startOnboarding(id, "autofill");
  await flush();
}

test("each onboarding offer's answer is counted while sharing is on, and nothing while it's off", async () => {
  client.loadChoice();
  client.setSharing(true, "settings");
  await atStep();
  takePasswordManagerCounts();
  step.toggleAutofillOffer("meCard");
  await step.continueAutofillStep();
  await flush();
  const counted = takePasswordManagerCounts();
  assert.equal(counted.onboarding_offers_me_card_accepted, 1);
  assert.equal(counted.onboarding_offers_apple_passwords_declined, 1);
  assert.equal(counted.onboarding_offers_me_card_declined, 0);
  assert.equal(counted.onboarding_offers_apple_passwords_accepted, 0);

  client.setSharing(false, "settings");
  await atStep();
  step.skipAutofillStep();
  assert.ok(Object.entries(takePasswordManagerCounts()).filter(([k]) => k.startsWith("onboarding_offers_")).every(([, n]) => n === 0));
  useOnboarding.setState({ windowId: null });
});
