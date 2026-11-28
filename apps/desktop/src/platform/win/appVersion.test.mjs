import assert from "node:assert/strict";
import { test } from "node:test";
import { appVersionOf } from "../appVersion.win.ts";
import { appVersionOf as desktopAppVersionOf } from "../appVersion.desktop.ts";
import { builtAppVersion } from "../../../vite.shared.ts";

test("Windows reports the version its UI was built as, not the Chromium version its shell sends", () => {
  assert.equal(appVersionOf("158.0.8127.88", "0.2.50"), "0.2.50");
  assert.equal(appVersionOf("158.0.8127.88", "0.2.50-nightly.3"), "0.2.50-nightly.3");
  assert.equal(appVersionOf("0.2.50", null), "0.2.50", "an unstamped build keeps what the host says");
  assert.equal(desktopAppVersionOf("0.2.50"), "0.2.50", "Linux and the Mac keep the version their host reports");
});

test("the UI is stamped with ARDIA_APP_VERSION when the release gives one, and with the project's marketing version otherwise", () => {
  const project = () => "\t\t\t\tMARKETING_VERSION = 0.2.49;\n";
  assert.equal(builtAppVersion({ ARDIA_APP_VERSION: "0.2.50-nightly.2" }, project), "0.2.50-nightly.2");
  assert.equal(builtAppVersion({ ARDIA_APP_VERSION: " " }, project), "0.2.49");
  assert.equal(builtAppVersion({}, () => 'MARKETING_VERSION = "1.2.3";'), "1.2.3");
  assert.throws(() => builtAppVersion({}, () => "nothing here"), /no MARKETING_VERSION/);
  assert.match(builtAppVersion({}), /^\d+\.\d+\.\d+/, "the real project has a marketing version");
});
