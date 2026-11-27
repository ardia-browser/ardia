import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const main = readFileSync(new URL("./shellEntry.tsx", import.meta.url), "utf8");
const browserMain = readFileSync(new URL("../../browser/src/main.tsx", import.meta.url), "utf8");

test("every browser window starts the shared reader service, as the Mac app does", () => {
  assert.ok(browserMain.includes("startReader();"));
  assert.match(main, /import \{ startReader \} from "\.\.\/\.\.\/browser\/src\/state\/reader\/reader";/);
  const windowBranch = main.indexOf("if (utility) {");
  const browserWindows = main.indexOf("} else {", windowBranch);
  const started = main.indexOf("startReader();");
  const rendered = main.indexOf("createRoot(");
  assert.ok(windowBranch > 0 && browserWindows > windowBranch);
  assert.ok(started > browserWindows && started < rendered, "startReader() runs for browser windows before the UI renders");
  assert.equal(main.split("startReader();").length, 2);
});
