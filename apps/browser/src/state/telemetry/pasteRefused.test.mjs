import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
Object.assign(stub.appInfo, { appVersion: "0.3.0", appBuild: "300", osVersion: "26.1.0", arch: "arm64", isolatedInstance: false });
stub.docs.set("telemetry.json", JSON.stringify({ version: 99, sharing: true, installId: "paste", decidedAt: 1, askDoneAt: 1, crashCursor: 0, lastVersion: null, sessionOpen: false }));
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
client.loadChoice();
after(() => client.setSharing(false, "settings"));
const { flushLocal } = await import("./localStore.ts");
const { watchPasteRefused } = await import("./pasteRefused.ts");
watchPasteRefused();

const queued = () => {
  client.saveQueueNow();
  return JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[],"logs":[]}').events.filter((e) => e.event === "paste_refused");
};
const local = () => {
  flushLocal();
  return stub.telemetryLocal.records().filter((r) => r.event === "paste_refused");
};

const KNOWN_TYPES = [
  "public.utf8-plain-text", "public.utf16-plain-text", "public.utf16-external-plain-text", "public.plain-text", "public.utf8-tab-separated-values-text",
  "public.html", "public.rtf", "public.url", "public.url-name", "public.file-url", "public.png", "public.jpeg", "public.tiff", "public.heic",
  "com.adobe.pdf", "com.apple.webarchive", "com.apple.flat-rtfd", "org.chromium.web-custom-data", "org.chromium.source-url",
  "NSStringPboardType", "NSFilenamesPboardType", "NeXT TIFF v4.0 pasteboard type", "NeXT Rich Text Format v1.0 pasteboard type", "NeXT RTFD pasteboard type",
  "Apple PNG pasteboard type", "Apple PDF pasteboard type", "Apple HTML pasteboard type", "Apple URL pasteboard type", "Apple Web Archive pasteboard type",
  "CorePasteboardFlavorType 0x75743136", "CorePasteboardFlavorType 0x75747874", "CorePasteboardFlavorType 0x6675726C", "CorePasteboardFlavorType 0x75726C20",
  "CorePasteboardFlavorType 0x75726C6E", "CorePasteboardFlavorType 0x4A504547", "CorePasteboardFlavorType 0x54455854",
  "text/plain", "text/html", "text/uri-list", "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "application/rtf",
];

test("a paste that finds no text records its reason, the pasteboard's type names, the OS, the layout and the gate flag", () => {
  stub.emitAppEvent({ type: "pasteRefused", epoch: client.consentEpoch(), reason: "no_text", gateOpen: true, layout: "com.apple.keylayout.US", types: ["public.rtf", "NeXT TIFF v4.0 pasteboard type", "public.png"] });
  const [event] = queued();
  assert.equal(queued().length, 1);
  assert.equal(event.properties.reason, "no_text");
  assert.equal(event.properties.type_ids, "public.rtf,NeXT TIFF v4.0 pasteboard type,public.png");
  assert.equal(event.properties.$os_version, "26.1.0");
  assert.equal(event.properties.keyboard_layout, "com.apple.keylayout.US");
  assert.equal(event.properties.gate_open, true);
  assert.equal(local().length, 1);
  assert.equal(local()[0].properties.type_ids, event.properties.type_ids);
});

test("a keystroke the focus gate dropped records the reason and what was dropped, without type names", () => {
  stub.emitAppEvent({ type: "pasteRefused", epoch: client.consentEpoch(), reason: "deadline", gateOpen: false, layout: "com.apple.keylayout.German", dropped: 2 });
  const event = queued().at(-1);
  assert.equal(event.properties.reason, "deadline");
  assert.equal(event.properties.gate_open, false);
  assert.equal(event.properties.dropped, 2);
  assert.equal("edit" in event.properties, false);
  assert.equal(event.properties.keyboard_layout, "com.apple.keylayout.German");
  assert.equal("type_ids" in event.properties, false);
});

test("a refused menu Paste records the first responder's class", () => {
  stub.emitAppEvent({ type: "pasteRefused", epoch: client.consentEpoch(), reason: "refused", gateOpen: true, responder: "NSTextView" });
  const event = queued().at(-1);
  assert.equal(event.properties.reason, "refused");
  assert.equal(event.properties.responder, "NSTextView");
});

test("a deferred reason from an older build reads as unknown, and a later refusal without a responder is still recorded", () => {
  stub.emitAppEvent({ type: "pasteRefused", epoch: client.consentEpoch(), reason: "deferred", gateOpen: true, responder: "RCTUIPlainPasteFieldEditor" });
  assert.equal(queued().at(-1).properties.reason, "unknown");
  const before = queued().length;
  stub.emitAppEvent({ type: "pasteRefused", epoch: client.consentEpoch(), reason: "refused", gateOpen: false });
  assert.equal(queued().length, before + 1);
  assert.equal(queued().at(-1).properties.reason, "refused");
  assert.equal("responder" in queued().at(-1).properties, false);
});

test("only names are kept: anything that is not a recognised type identifier becomes other, dynamic types are collapsed", () => {
  stub.emitAppEvent({
    type: "pasteRefused",
    epoch: client.consentEpoch(),
    reason: "no_text",
    gateOpen: true,
    layout: "/Users/someone/layout",
    responder: "NSTextView in /Users/someone",
    types: ["public.html", "https://example.com/a?token=secret", `dyn.${"a".repeat(40)}`, "dyn.abc", "public.data /Users/alice/private", "/Users/alice/private", "hello, world", 7, null, "public.html", "text/html", "Apple PNG pasteboard type", "CorePasteboardFlavorType 0x54455854"],
  });
  const event = queued().at(-1);
  assert.equal(event.properties.type_ids, "public.html,other,dyn,text/html,Apple PNG pasteboard type,CorePasteboardFlavorType 0x54455854");
  assert.equal(event.properties.keyboard_layout, "other");
  assert.equal(JSON.stringify(event.properties).includes("/Users/someone"), false);
  assert.equal("responder" in event.properties, false);
  assert.doesNotMatch(JSON.stringify(event), /example\.com|secret|Users|alice/);
});

test("an unknown reason is recorded as unknown and the type list is capped", () => {
  stub.emitAppEvent({ type: "pasteRefused", epoch: client.consentEpoch(), reason: "something else", gateOpen: false, types: KNOWN_TYPES.slice(0, 30) });
  const event = queued().at(-1);
  assert.equal(event.properties.reason, "unknown");
  assert.equal(event.properties.type_ids, KNOWN_TYPES.slice(0, 24).join(","));
});

test("other app events record nothing", () => {
  const before = queued().length;
  stub.emitAppEvent({ type: "dragEscape" });
  assert.equal(queued().length, before);
});

test("only standard pasteboard type names are sent: an app's own type is just other, dynamic ones are dyn whatever their length, and the offered count tells them apart from an empty pasteboard", () => {
  const longDynamic = `dyn.${"ah62d4rv4gu8y".repeat(10)}`;
  stub.emitAppEvent({ type: "pasteRefused", epoch: client.consentEpoch(), reason: "no_text", gateOpen: false, types: ["com.acme.invoice.8f3e2a1c", "com.apple.webarchive", longDynamic, "application/x-acme-account-42", "text/html", "org.chromium.web-custom-data"] });
  const event = queued().at(-1);
  assert.equal(event.properties.type_ids, "other,com.apple.webarchive,dyn,text/html,org.chromium.web-custom-data");
  assert.equal(event.properties.type_count, 6);
  assert.equal(JSON.stringify(event).includes("acme"), false);
  stub.emitAppEvent({ type: "pasteRefused", epoch: client.consentEpoch(), reason: "no_text", gateOpen: false, types: [] });
  const empty = queued().at(-1);
  assert.equal(empty.properties.type_ids, "");
  assert.equal(empty.properties.type_count, 0);
});

test("every well-known pasteboard and MIME type on the list goes out under its own name", () => {
  for (let i = 0; i < KNOWN_TYPES.length; i += 20) {
    const types = KNOWN_TYPES.slice(i, i + 20);
    stub.emitAppEvent({ type: "pasteRefused", epoch: client.consentEpoch(), reason: "no_text", gateOpen: true, types });
    assert.equal(queued().at(-1).properties.type_ids, types.join(","));
  }
});

test("a name an app made up goes out as other, even when it looks like a standard one", () => {
  const invented = [
    "text/x-customer-alice-invoice-123456",
    "public.acme-secret-doc",
    "com.apple.someapp.internal-id-42",
    "org.chromium.acme-session-9f3a",
    "org.webkit.acme-private",
    "CorePasteboardFlavorType 0x12345678",
    "Apple Customer 42 pasteboard type",
    "NeXT Secret Ledger pasteboard type",
    "image/x-acme-scan-777",
    "application/vnd.acme.account+json",
  ];
  for (const type of invented) {
    stub.emitAppEvent({ type: "pasteRefused", epoch: client.consentEpoch(), reason: "no_text", gateOpen: true, types: ["public.html", type] });
    const event = queued().at(-1);
    assert.equal(event.properties.type_ids, "public.html,other", type);
    assert.equal(event.properties.type_count, 2, type);
    assert.equal(JSON.stringify(event.properties).includes(type), false, type);
  }
});

test("Apple's keyboard layouts and input methods go out by name, and any other layout as other, its name never sent", () => {
  for (const layout of ["com.apple.keylayout.US", "com.apple.keylayout.ABC", "com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese", "com.apple.inputmethod.SCIM.ITABC"]) {
    stub.emitAppEvent({ type: "pasteRefused", epoch: client.consentEpoch(), reason: "deadline", gateOpen: false, layout });
    assert.equal(queued().at(-1).properties.keyboard_layout, layout);
  }
  const outside = [
    "org.unknown.keylayout.JohnsLayout",
    "com.vendor.inputmethod.secret-42",
    `com.apple.keylayout.${"x".repeat(70)}`,
    "x".repeat(90),
    "com.apple.keylayout.",
    "com.apple.keylayout.US Personal",
    "com.apple.keylayoutish.US",
    "com.apple.inputmethod.Kotoeri/../../alice",
  ];
  for (const layout of outside) {
    stub.emitAppEvent({ type: "pasteRefused", epoch: client.consentEpoch(), reason: "deadline", gateOpen: false, layout });
    const event = queued().at(-1);
    assert.equal(event.properties.keyboard_layout, "other", layout);
    assert.equal(JSON.stringify(event).includes(layout), false, layout);
  }
  stub.emitAppEvent({ type: "pasteRefused", epoch: client.consentEpoch(), reason: "deadline", gateOpen: false, layout: 42 });
  assert.equal("keyboard_layout" in queued().at(-1).properties, false);
});

test("nothing is sent while sharing is off", () => {
  client.setSharing(false, "settings");
  const recorded = local().length;
  stub.emitAppEvent({ type: "pasteRefused", epoch: client.consentEpoch(), reason: "no_text", gateOpen: true, types: ["public.rtf"] });
  assert.equal(queued().length, 0);
  assert.equal(local().length, recorded + 1);
  assert.equal(local().at(-1).sent, false);
});

test("a refused paste stamped with an earlier consent period, or with no epoch, stays in the local copy and isn't sent", () => {
  client.setSharing(true, "settings");
  const earlier = client.consentEpoch();
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  assert.ok(earlier);
  assert.notEqual(earlier, client.consentEpoch());
  const before = queued().length;
  stub.emitAppEvent({ type: "pasteRefused", reason: "deadline", gateOpen: true, epoch: earlier });
  stub.emitAppEvent({ type: "pasteRefused", reason: "focus_lost", gateOpen: true });
  assert.equal(queued().length, before);
  assert.deepEqual(local().slice(-2).map((r) => [r.properties.reason, r.sent]), [["deadline", false], ["focus_lost", false]]);
  stub.emitAppEvent({ type: "pasteRefused", reason: "mouse_down", gateOpen: false, epoch: client.consentEpoch() });
  assert.equal(queued().length, before + 1);
});
