import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";

globalThis.__DEV__ = false;
const nodeRequire = createRequire(import.meta.url);
globalThis.require = (id) => (/\.png$/.test(id) ? { uri: id } : nodeRequire(id));

const native = await import("../../test-native/index.ts");
const { useBrowser } = await import("../../state/browser/store.ts");
const { usePlugins } = await import("../../state/plugins/store.ts");
const { loadApplePasswords } = await import("../../state/site/applePasswords.ts");
const { startOnboarding, useOnboarding } = await import("../../state/onboarding/onboarding.ts");
const { forgetOnboardingProgress } = await import("../../state/onboarding/onboardingDocument.ts");
const step = await import("../../state/onboarding/autofillStep.ts");
const ui = await import("../ui/index.ts");
const { OptionCard } = await import("./OptionCard.tsx");
const { StepLayout } = await import("./StepLayout.tsx");
const { AutofillStep } = await import("./AutofillStep.tsx");

usePlugins.setState({ scanned: true });
const S = () => useBrowser.getState();
const flush = () => new Promise((r) => setImmediate(r));
const LEAVES = new Set([...Object.values(ui), OptionCard]);

function render(node) {
  if (Array.isArray(node)) return node.map(render);
  if (!node || typeof node !== "object" || !("props" in node)) return node;
  if (node.type === StepLayout) return { ...node, props: { ...node.props, children: render(node.props.children), preview: null, actions: null } };
  if (typeof node.type === "function" && !LEAVES.has(node.type)) return render(mount(() => node.type(node.props)).value);
  return { ...node, props: { ...node.props, children: render(node.props.children) } };
}

function find(node, match, found = []) {
  if (Array.isArray(node)) node.forEach((n) => find(n, match, found));
  else if (node && typeof node === "object" && "props" in node) {
    if (match(node)) found.push(node);
    find(node.props.children, match, found);
  }
  return found;
}

const texts = (node) => (typeof node === "string" ? [node] : Array.isArray(node) ? node.flatMap(texts) : node?.props ? texts(node.props.children) : []);
const shown = () => render(mount(() => AutofillStep()).value);
const cards = () => find(shown(), (n) => n.type === OptionCard).map((n) => n.props.title);

async function atStep(apple) {
  forgetOnboardingProgress();
  step.resetAutofillStep();
  native.applePasswords.state = apple;
  native.contacts.status = "notDetermined";
  S().hydrate({});
  const id = S().createWindow({ url: "https://a.test/" });
  await loadApplePasswords();
  startOnboarding(id, "autofill");
  await flush();
}

test("S11: the step shows one card for each offer it can make, both unticked", async () => {
  await atStep("notConnected");
  assert.deepEqual(cards(), ["Use Apple Passwords", "Use my Me card from Contacts"]);
  assert.ok(find(shown(), (n) => n.type === OptionCard).every((n) => n.props.selected === false));
  await atStep("notEntitled");
  assert.deepEqual(cards(), ["Use my Me card from Contacts"]);
  useOnboarding.setState({ windowId: null });
});

test("S11: after accepting Apple Passwords the step asks for the Passwords app's code in place", async () => {
  await atStep("notConnected");
  step.toggleAutofillOffer("applePasswords");
  await step.continueAutofillStep();
  const tree = shown();
  assert.equal(find(tree, (n) => n.type === ui.TextField).length, 1);
  assert.match(texts(tree).join(" "), /six-digit code the Passwords app shows/);
  step.skipAutofillStep();
  useOnboarding.setState({ windowId: null });
});
