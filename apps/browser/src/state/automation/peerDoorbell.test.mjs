import assert from "node:assert/strict";
import { test } from "node:test";
const { createDoorbell, doorbellOptions, answerFor, DOORBELL_CHOICES, startPeerDoorbell, plainText } = await import("./peerDoorbell.ts");
const { useControlApprovals, refreshControlApprovals, refreshExpiredApprovals, revokeApproval, approvalLine } = await import("./controlApprovals.ts");
const { takeCliCounts } = await import("../telemetry/cliCounts.ts");
const stub = await import("../../test-native/index.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

const ask = (id, extra = {}) => ({
  ask: id,
  name: "tool",
  signedBy: "Signed by X Inc (XXXXXXXXXX)",
  path: "/opt/tool",
  identifier: "com.x.tool",
  remember: true,
  deadline: Date.now() + 60_000,
  ...extra,
});

function harness() {
  const calls = { chosen: [], answers: [], dismissed: [], shown: 0, ended: [] };
  const pending = [];
  const doorbell = createDoorbell({
    choose: (options) => {
      calls.chosen.push(options);
      return new Promise((resolve) => pending.push(resolve));
    },
    answer: async (id, outcome) => {
      calls.answers.push([id, outcome]);
      return true;
    },
    dismiss: async (key) => void calls.dismissed.push(key),
    windowId: () => "w-1",
    now: () => Date.now(),
    shown: () => calls.shown++,
    ended: (outcome) => calls.ended.push(outcome),
  });
  return { doorbell, calls, pending };
}

test("the doorbell names the program beside who signed it, has no default button and Escape means Don't Allow", () => {
  const options = doorbellOptions(ask(1));
  assert.equal(options.title, "A program wants to control Ardia");
  assert.ok(options.message.startsWith("“tool”: Signed by X Inc (XXXXXXXXXX)\n/opt/tool\n\n"));
  assert.deepEqual(options.choices, ["Allow Once", "Allow for 30 Minutes", "Always Allow", "Don't Allow"]);
  assert.equal(options.cancelChoice, 3);
  assert.equal(options.noDefault, true);
  assert.equal(options.onlyIfShown, true);
  const once = doorbellOptions(ask(2, { remember: false }));
  assert.deepEqual(once.choices, ["Allow Once", "Don't Allow"]);
  assert.equal(once.cancelChoice, 1);
  assert.match(once.message, /only be allowed once/);
  const spoof = doorbellOptions(ask(3, { name: "ard\u202eia\nOK", signedBy: "Not signed by an identified developer", path: "x".repeat(400) }));
  assert.ok(spoof.message.startsWith("“ardiaOK”: Not signed by an identified developer\n"));
  assert.equal([...plainText("x".repeat(400), 300)].length, 300);
});

test("a choice maps to the socket's answer; dismissal answers nothing", () => {
  assert.equal(answerFor(ask(1), { choice: 0 }), "once");
  assert.equal(answerFor(ask(1), { choice: 1 }), "halfHour");
  assert.equal(answerFor(ask(1), { choice: 2 }), "always");
  assert.equal(answerFor(ask(1), { choice: 3 }), "deny");
  assert.equal(answerFor(ask(1, { remember: false }), { choice: 1 }), "deny");
  assert.equal(answerFor(ask(1), { choice: -1 }), null);
  assert.equal(answerFor(ask(1), { choice: 9 }), null);
  assert.equal(answerFor(ask(1), { choice: -1, unshown: true }), "unshown");
  assert.equal(DOORBELL_CHOICES.remember.length, 4);
});

test("one doorbell at a time, in order, and each is answered once", async () => {
  const { doorbell, calls, pending } = harness();
  doorbell.asked(ask(1));
  doorbell.asked(ask(2, { name: "other" }));
  assert.equal(calls.chosen.length, 1);
  assert.equal(calls.chosen[0].windowId, "w-1");
  assert.equal(calls.chosen[0].dismissKey, "peer-doorbell-1");
  assert.deepEqual(doorbell.queued, [2]);
  pending.shift()({ choice: 2 });
  await settle();
  assert.deepEqual(calls.answers, [[1, "always"]]);
  assert.equal(calls.shown, 1);
  assert.equal(calls.chosen.length, 2);
  assert.ok(calls.chosen[1].message.startsWith("“other”"));
  pending.shift()({ choice: 3 });
  await settle();
  assert.deepEqual(calls.answers, [[1, "always"], [2, "deny"]]);
  assert.equal(doorbell.showing, null);
});

test("an ask the socket ends is taken down and never answered", async () => {
  const { doorbell, calls, pending } = harness();
  doorbell.asked(ask(1));
  doorbell.asked(ask(2));
  doorbell.ended(2, "left");
  assert.deepEqual(doorbell.queued, []);
  doorbell.ended(1, "timeout");
  assert.deepEqual(calls.dismissed, ["peer-doorbell-1"]);
  pending.shift()({ choice: -1 });
  await settle();
  assert.deepEqual(calls.answers, []);
  assert.deepEqual(calls.ended, ["left", "timeout"]);
  assert.equal(calls.chosen.length, 1);
});

test("a late click after the ask ended answers nothing", async () => {
  const { doorbell, calls, pending } = harness();
  doorbell.asked(ask(1));
  doorbell.ended(1, "stopped");
  pending.shift()({ choice: 0 });
  await settle();
  assert.deepEqual(calls.answers, []);
});

test("an expired ask is skipped and nobody seeing it answers unshown", async () => {
  const { doorbell, calls, pending } = harness();
  doorbell.asked(ask(1, { deadline: Date.now() - 1 }));
  assert.equal(calls.chosen.length, 0);
  doorbell.asked(ask(2));
  pending.shift()({ choice: -1, unshown: true });
  await settle();
  assert.deepEqual(calls.answers, [[2, "unshown"]]);
  assert.equal(calls.shown, 0);
});

test("wired up: the native ask reaches the dialog, the answer reaches the socket, outcomes are counted", async () => {
  setConsentPeriod(true, "peer-doorbell-test");
  takeCliCounts();
  startPeerDoorbell();
  stub.controlPeers.chooseResult = { choice: 1 };
  stub.emitControlPeerAsk(ask(41));
  await settle();
  assert.equal(stub.controlPeers.chosen.at(-1).title, "A program wants to control Ardia");
  assert.deepEqual(stub.controlPeers.answers.at(-1), [41, "halfHour"]);
  stub.emitControlPeerAskEnded(41, "halfHour");
  stub.controlPeers.chooseResult = { choice: -1, unshown: true };
  stub.emitControlPeerAsk(ask(42));
  await settle();
  assert.deepEqual(stub.controlPeers.answers.at(-1), [42, "unshown"]);
  stub.emitControlPeerAskEnded(42, "unshown");
  stub.emitControlPeerAsk(ask(43));
  stub.emitControlPeerAskEnded(43, "timeout");
  await settle();
  const counts = takeCliCounts();
  assert.equal(counts.cli_socket_doorbells_shown, 1);
  assert.equal(counts.cli_socket_doorbell_half_hour, 1);
  assert.equal(counts.cli_socket_doorbell_unshown, 1);
  assert.equal(counts.cli_socket_doorbell_timeout, 1);
  assert.equal(counts.cli_socket_doorbell_always, 0);
});

test("approvals list, revoke and describe", async () => {
  const now = Date.now();
  stub.controlPeers.approvals = [
    { key: "team:XXXXXXXXXX:com.x.tool", name: "tool", signedBy: "Signed by X Inc (XXXXXXXXXX)", added: now },
    { key: "apple:com.apple.nc", name: "nc", signedBy: "Part of macOS, signed by Apple", added: now, until: now + 29.5 * 60_000 },
  ];
  await refreshControlApprovals();
  assert.deepEqual(useControlApprovals.getState().approvals.map((a) => a.name), ["tool", "nc"]);
  assert.equal(approvalLine(useControlApprovals.getState().approvals[0], now), "Signed by X Inc (XXXXXXXXXX) · Always allowed");
  assert.equal(approvalLine(useControlApprovals.getState().approvals[1], now), "Part of macOS, signed by Apple · Allowed for 30 more minutes");
  assert.equal(approvalLine({ ...useControlApprovals.getState().approvals[1], until: now + 30_000 }, now), "Part of macOS, signed by Apple · Allowed for 1 more minute");
  assert.equal(approvalLine({ ...useControlApprovals.getState().approvals[1], until: now - 1 }, now), "Part of macOS, signed by Apple · Expired");
  stub.controlPeers.approvals = stub.controlPeers.approvals.map((a) => (a.until ? { ...a, until: now - 1 } : a));
  await refreshExpiredApprovals(now);
  assert.equal(useControlApprovals.getState().approvals.length, 2);
  useControlApprovals.setState((s) => ({ approvals: s.approvals.map((a) => (a.until ? { ...a, until: now - 1 } : a)) }));
  stub.controlPeers.approvals = stub.controlPeers.approvals.filter((a) => !a.until);
  await refreshExpiredApprovals(now);
  assert.deepEqual(useControlApprovals.getState().approvals.map((a) => a.name), ["tool"]);
  stub.controlPeers.approvals.push({ key: "apple:com.apple.nc", name: "nc", signedBy: "Part of macOS, signed by Apple", added: now });
  await refreshControlApprovals();
  await revokeApproval("apple:com.apple.nc");
  assert.deepEqual(stub.controlPeers.revoked, ["apple:com.apple.nc"]);
  assert.deepEqual(useControlApprovals.getState().approvals.map((a) => a.name), ["tool"]);
});

test("outcomes aren't counted while sharing is off", async () => {
  setConsentPeriod(false, "peer-doorbell-test-off");
  takeCliCounts();
  stub.emitControlPeerAskEnded(99, "deny");
  assert.equal(takeCliCounts().cli_socket_doorbell_deny, 0);
});
