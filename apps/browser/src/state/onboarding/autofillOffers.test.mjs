import assert from "node:assert/strict";
import { test } from "node:test";

const native = await import("../../test-native/index.ts");
const { PLATFORM_FEATURES } = await import("../../lib/platformFeatures.ts");
const { useBrowser } = await import("../browser/store.ts");
const { usePlugins } = await import("../plugins/store.ts");
const { loadApplePasswords } = await import("../site/applePasswords.ts");
const { setMeCardFor, useMeCard } = await import("../site/meCard.ts");
const { useApplePasswords } = await import("../site/applePasswords.ts");
const { currentPasswordManager } = await import("../site/passwordManager.ts");
const { activeSteps, questionsFor, startOnboarding, STEPS, useOnboarding } = await import("./onboarding.ts");
const offers = await import("./autofillOffers.ts");
const step = await import("./autofillStep.ts");
const { forgetOnboardingProgress } = await import("./onboardingDocument.ts");

usePlugins.setState({ scanned: true });
const S = () => useBrowser.getState();
const flush = () => new Promise((r) => setImmediate(r));
const MAC = { systemPasswordManagers: PLATFORM_FEATURES.systemPasswordManagers, meCard: PLATFORM_FEATURES.meCard };

async function onboardingOn({ apple = "notConnected", features = MAC, fresh = true } = {}) {
  Object.assign(PLATFORM_FEATURES, features);
  native.applePasswords.state = apple;
  native.applePasswords.calls.length = 0;
  native.contacts.status = "notDetermined";
  native.contacts.answer = "authorized";
  native.contacts.requests = 0;
  if (fresh) forgetOnboardingProgress();
  step.resetAutofillStep();
  S().hydrate({});
  const id = S().createWindow({ url: "https://a.test/" });
  await loadApplePasswords();
  startOnboarding(id, "autofill");
  await flush();
  return S().windows[id].profileId;
}

test("S11: on an entitled Mac one step after Pin your apps offers Apple Passwords and the Me card", async () => {
  const profile = await onboardingOn();
  assert.deepEqual(STEPS.slice(-5), ["pins", "autofill", "home", "plugins", "outro"]);
  assert.ok(activeSteps().includes("autofill"));
  assert.deepEqual(questionsFor("autofill").map((q) => q.id), ["autofill"]);
  assert.deepEqual(offers.openAutofillOffers(profile), ["applePasswords", "meCard"]);
});

test("S11: a Mac without Apple's entitlement offers only the Me card, and Linux and Windows get no step", async () => {
  let profile = await onboardingOn({ apple: "notEntitled" });
  assert.deepEqual(offers.openAutofillOffers(profile), ["meCard"]);
  assert.ok(activeSteps().includes("autofill"));
  profile = await onboardingOn({ apple: "notConnected", features: { systemPasswordManagers: false, meCard: false } });
  assert.deepEqual(offers.openAutofillOffers(profile), []);
  assert.ok(!activeSteps().includes("autofill"));
  Object.assign(PLATFORM_FEATURES, MAC);
  useOnboarding.setState({ windowId: null });
});

test("S11: declining both offers moves on, and neither offer comes back in a later onboarding", async () => {
  const profile = await onboardingOn();
  assert.deepEqual(offers.offerPicks(step.useAutofillStep.getState().picks, offers.openAutofillOffers(profile)), [], "nothing starts ticked");
  await step.continueAutofillStep();
  assert.equal(useOnboarding.getState().step, "home");
  assert.equal(native.contacts.requests, 0, "a declined Me card never asks for Contacts");
  assert.deepEqual(native.applePasswords.calls, [], "a declined Apple Passwords never starts Pairing");
  const again = await onboardingOn({ fresh: false });
  assert.deepEqual(offers.openAutofillOffers(again), []);
  assert.ok(!activeSteps().includes("autofill"));
  useOnboarding.setState({ windowId: null });
});

test("S11: skipping the step declines what it offered, for good", async () => {
  await onboardingOn({ apple: "notEntitled" });
  step.toggleAutofillOffer("meCard");
  step.skipAutofillStep();
  assert.equal(useOnboarding.getState().step, "home");
  assert.equal(native.contacts.requests, 0);
  const again = await onboardingOn({ fresh: false, apple: "notEntitled" });
  assert.deepEqual(offers.openAutofillOffers(again), []);
  const entitled = await onboardingOn({ fresh: false });
  assert.deepEqual(offers.openAutofillOffers(entitled), ["applePasswords"], "an offer it never showed still comes once Apple Passwords can work");
  useOnboarding.setState({ windowId: null });
});

test("S11: accepting the Me card asks for Contacts once, turns it on and moves on, and the offer doesn't return", async () => {
  const profile = await onboardingOn({ apple: "notEntitled" });
  native.contacts.card = { name: "Ada Lovelace", organization: "", emails: ["ada@example.test"], phones: [], addresses: [] };
  assert.equal(native.contacts.requests, 0, "showing the offer never asks");
  step.toggleAutofillOffer("meCard");
  await step.continueAutofillStep();
  await flush();
  assert.equal(native.contacts.requests, 1);
  assert.equal(useMeCard.getState().entries[profile]?.length, 1);
  assert.equal(useOnboarding.getState().step, "home");
  assert.deepEqual(useOnboarding.getState().picked.autofill, ["Fills forms from your Me card"]);
  await setMeCardFor(profile, false);
  const again = await onboardingOn({ fresh: false, apple: "notEntitled" });
  assert.deepEqual(offers.openAutofillOffers(again), [], "turning it off later doesn't bring the offer back");
  native.contacts.card = null;
  useOnboarding.setState({ windowId: null });
});

test("S11: accepting Apple Passwords pairs right in the step with the Passwords app's code, then picks it and moves on", async () => {
  const profile = await onboardingOn();
  step.toggleAutofillOffer("applePasswords");
  await step.continueAutofillStep();
  assert.deepEqual(native.applePasswords.calls, ["pair"]);
  assert.equal(step.useAutofillStep.getState().phase, "pairing");
  assert.equal(useApplePasswords.getState().pairing?.step, "code");
  assert.equal(useOnboarding.getState().step, "autofill");
  assert.equal(await step.submitAutofillPairingCode("111111"), false);
  assert.match(useApplePasswords.getState().pairing?.error ?? "", /didn't match/);
  assert.equal(useOnboarding.getState().step, "autofill", "a wrong code stays on the step for another try");
  assert.equal(await step.submitAutofillPairingCode(native.applePasswords.code), true);
  assert.equal(currentPasswordManager(profile), "apple");
  assert.equal(useOnboarding.getState().step, "home");
  assert.deepEqual(useOnboarding.getState().picked.autofill, ["Fills and saves logins with Apple Passwords"]);
  useOnboarding.setState({ windowId: null });
});

test("S11: skipping while Pairing cancels it, leaves the Password manager as it was, and declines the offer", async () => {
  const profile = await onboardingOn();
  step.toggleAutofillOffer("applePasswords");
  await step.continueAutofillStep();
  step.skipAutofillStep();
  await flush();
  assert.ok(native.applePasswords.calls.includes("cancelPairing"));
  assert.equal(useApplePasswords.getState().pairing, null);
  assert.equal(currentPasswordManager(profile), "ardia");
  assert.equal(useOnboarding.getState().step, "home");
  const again = await onboardingOn({ fresh: false });
  assert.deepEqual(offers.openAutofillOffers(again), [], "the Me card offered beside it is declined too");
  useOnboarding.setState({ windowId: null });
});
