import assert from "node:assert/strict";
import { test } from "node:test";

const native = await import("../../test-native/index.ts");
const { PLATFORM_FEATURES } = await import("../../lib/platformFeatures.ts");
const { useBrowser } = await import("../browser/store.ts");
const { usePlugins } = await import("../plugins/store.ts");
const ap = await import("../site/applePasswords.ts");
const { loadApplePasswords } = ap;
const { setMeCardFor, useMeCard } = await import("../site/meCard.ts");
const { useApplePasswords } = await import("../site/applePasswords.ts");
const { currentPasswordManager } = await import("../site/passwordManager.ts");
const { activeSteps, questionsFor, startOnboarding, STEPS, useOnboarding } = await import("./onboarding.ts");
const offers = await import("./autofillOffers.ts");
const step = await import("./autofillStep.ts");
const { forgetOnboardingProgress } = await import("./onboardingDocument.ts");
const { currentEngineProfile: engine } = await import("../browser/current.ts");

usePlugins.setState({ scanned: true });
const S = () => useBrowser.getState();
const flush = () => new Promise((r) => setImmediate(r));
const MAC = { systemPasswordManagers: PLATFORM_FEATURES.systemPasswordManagers, meCard: PLATFORM_FEATURES.meCard };

async function onboardingOn({ apple = "notConnected", features = MAC, fresh = true } = {}) {
  Object.assign(PLATFORM_FEATURES, features);
  native.applePasswords.state = apple;
  native.applePasswords.calls.length = 0;
  native.applePasswords.pairOutcome = "awaitingCode";
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
  assert.equal(useMeCard.getState().entries[engine(profile)]?.length, 1);
  assert.equal(useOnboarding.getState().step, "home");
  assert.deepEqual(useOnboarding.getState().picked.autofill, ["Fills forms from your Me card"]);
  await setMeCardFor(engine(profile), false);
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
  assert.equal(await step.submitAutofillPairingCode(ap.pairingCodeSecret("111111")), false);
  assert.match(useApplePasswords.getState().pairing?.error ?? "", /didn't match/);
  assert.equal(useOnboarding.getState().step, "autofill", "a wrong code stays on the step for another try");
  assert.equal(await step.submitAutofillPairingCode(ap.pairingCodeSecret(native.applePasswords.code)), true);
  assert.equal(currentPasswordManager(profile), "apple");
  assert.equal(useOnboarding.getState().step, "home");
  assert.deepEqual(useOnboarding.getState().picked.autofill, ["Fills and saves logins with Apple Passwords"]);
  useOnboarding.setState({ windowId: null });
});

test("S11: skipping while Pairing cancels it, leaves the Password manager as it was, and leaves the Apple Passwords offer open for next time", async () => {
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
  assert.deepEqual(offers.openAutofillOffers(again), ["applePasswords"], "a cancelled Pairing isn't an answer; the Me card offered beside it is declined");
  useOnboarding.setState({ windowId: null });
});

test("S11: a wrong code and then Skip leaves the Apple Passwords offer open for next time", async () => {
  const profile = await onboardingOn({ apple: "notConnected" });
  step.toggleAutofillOffer("applePasswords");
  step.toggleAutofillOffer("meCard");
  native.contacts.card = { name: "Ada Lovelace", organization: "", emails: ["ada@example.test"], phones: [], addresses: [] };
  await step.continueAutofillStep();
  assert.equal(await step.submitAutofillPairingCode(ap.pairingCodeSecret("111111")), false);
  step.skipAutofillStep();
  await flush();
  const again = await onboardingOn({ fresh: false });
  assert.deepEqual(offers.openAutofillOffers(again), ["applePasswords"]);
  await setMeCardFor(engine(profile), false);
  native.contacts.card = null;
  useOnboarding.setState({ windowId: null });
});

test("S11: a Pairing that fails moves on without Apple Passwords, keeps the Me card accepted beside it, and offers Apple Passwords again next time", async () => {
  const profile = await onboardingOn();
  native.applePasswords.pairOutcome = "failed";
  native.contacts.card = { name: "Ada Lovelace", organization: "", emails: ["ada@example.test"], phones: [], addresses: [] };
  step.toggleAutofillOffer("applePasswords");
  step.toggleAutofillOffer("meCard");
  await step.continueAutofillStep();
  assert.equal(useApplePasswords.getState().pairing?.step, "failed");
  step.finishAutofillPairing();
  await flush();
  assert.equal(currentPasswordManager(profile), "ardia");
  assert.equal(useOnboarding.getState().step, "home");
  assert.deepEqual(useOnboarding.getState().picked.autofill, ["Fills forms from your Me card"], "only what took effect is listed as picked");
  const again = await onboardingOn({ fresh: false });
  assert.deepEqual(offers.openAutofillOffers(again), ["applePasswords"], "the failed offer stays open; the accepted Me card doesn't return");
  await setMeCardFor(engine(profile), false);
  native.contacts.card = null;
  useOnboarding.setState({ windowId: null });
});

test("S11: the Me card accepted in onboarding on the default profile is the one Settings shows, and Settings turns it off", async () => {
  const { useMeCardFor } = await import("../site/meCard.ts");
  const { mount } = await import("../../test-hooks.mjs");
  const browserProfile = await onboardingOn({ apple: "notEntitled" });
  const profile = engine(browserProfile);
  assert.equal(profile, "", "the default profile's engine profile");
  native.addressStores.delete(profile);
  native.contacts.card = { name: "Ada Lovelace", organization: "", emails: ["ada@example.test"], phones: [], addresses: [] };
  step.toggleAutofillOffer("meCard");
  await step.continueAutofillStep();
  for (let i = 0; i < 5; i++) await flush();
  const settingsSwitch = () => mount(() => useMeCardFor(profile)).value.on;
  assert.equal(settingsSwitch(), true, "Settings' switch is on");
  const saved = [...(native.addressStores.get(profile)?.keys() ?? [])];
  assert.equal(saved.length, 1, "the Me card's entry is in the profile's address store");
  assert.deepEqual(useMeCard.getState().entries[profile], saved, "and recorded as from Contacts under that profile");
  assert.equal(useMeCard.getState().entries[browserProfile], undefined, "nothing recorded under the browser profile's id");
  assert.deepEqual(offers.openAutofillOffers(browserProfile), [], "the offer is gone once it is on");
  await setMeCardFor(profile, false);
  assert.equal(settingsSwitch(), false);
  assert.equal(native.addressStores.get(profile)?.size ?? 0, 0, "turning it off in Settings removes the entry");
  native.contacts.card = null;
  useOnboarding.setState({ windowId: null });
});

test("S11: a Me card pick whose Contacts access is refused isn't an answer, and the Me card is offered again next time", async () => {
  await onboardingOn({ apple: "notEntitled" });
  native.contacts.answer = "denied";
  step.toggleAutofillOffer("meCard");
  await step.continueAutofillStep();
  await flush();
  assert.equal(native.contacts.requests, 1, "Contacts was asked");
  assert.equal(useOnboarding.getState().step, "home");
  assert.deepEqual(useOnboarding.getState().picked.autofill ?? [], [], "nothing that didn't take effect is listed as picked");
  native.contacts.status = "notDetermined";
  const again = await onboardingOn({ fresh: false, apple: "notEntitled" });
  assert.deepEqual(offers.openAutofillOffers(again), ["meCard"]);
  useOnboarding.setState({ windowId: null });
});

test("S11: accepting Apple Passwords while it's already connected picks it without asking for a new code", async () => {
  const profile = await onboardingOn({ apple: "connected" });
  assert.deepEqual(offers.openAutofillOffers(profile), ["applePasswords", "meCard"]);
  step.toggleAutofillOffer("applePasswords");
  await step.continueAutofillStep();
  assert.deepEqual(native.applePasswords.calls, [], "no second Pairing starts over the live connection");
  assert.equal(currentPasswordManager(profile), "apple");
  assert.equal(useOnboarding.getState().step, "home");
  assert.deepEqual(useOnboarding.getState().picked.autofill, ["Fills and saves logins with Apple Passwords"]);
  useOnboarding.setState({ windowId: null });
});

test("S11: going back while the Me card is turning on leaves the step ready to use again", async () => {
  const profile = await onboardingOn({ apple: "notEntitled" });
  native.contacts.card = { name: "Ada Lovelace", organization: "", emails: ["ada@example.test"], phones: [], addresses: [] };
  step.toggleAutofillOffer("meCard");
  const working = step.continueAutofillStep();
  assert.equal(step.useAutofillStep.getState().phase, "working");
  step.skipAutofillStep();
  assert.equal(useOnboarding.getState().step, "autofill", "Skip waits while the Me card is turning on");
  useOnboarding.setState({ step: "pins" });
  await working;
  useOnboarding.setState({ step: "autofill" });
  assert.equal(step.useAutofillStep.getState().phase, "offer", "Continue works again on return");
  assert.deepEqual(offers.openAutofillOffers(profile), [], "the Me card turned on, so it isn't offered again");
  await setMeCardFor(engine(profile), false);
  native.contacts.card = null;
  useOnboarding.setState({ windowId: null });
});
