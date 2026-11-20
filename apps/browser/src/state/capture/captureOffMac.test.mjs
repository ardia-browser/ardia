import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("../../../", import.meta.url));

const featuresOf = (platform) => `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  const resolved = next(specifier, context);
  return resolved.url.endsWith("/lib/platformFeatures.ts") ? { ...resolved, url: resolved.url.replace(/platformFeatures\\.ts$/, "platformFeatures.${platform}.ts") } : resolved;
} });`;

const OFFERED = `
const { useBrowser } = await import("./src/state/browser/store.ts");
const { UNAVAILABLE_COMMANDS } = await import("./src/state/commands/commandCatalog.ts");
const { barActions } = await import("./src/state/omnibox/barActions.ts");
const S = () => useBrowser.getState();
S().hydrate({});
const w = S().createWindow({ url: "https://a.example/" });
const commands = ["capture", "captureFullPage"];
console.log(JSON.stringify({
  unavailable: commands.filter((c) => UNAVAILABLE_COMMANDS.has(c)),
  bar: commands.filter((c) => barActions(S(), w).some((a) => a.id === c)),
}));
`;

function offered(platform) {
  const hooks = platform ? ["--import", `data:text/javascript,${encodeURIComponent(featuresOf(platform))}`] : [];
  const run = spawnSync(process.execPath, ["--no-warnings", "--import", "./src/test-loader.mjs", ...hooks, "--input-type=module", "-e", OFFERED], { cwd: APP, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split("\n").at(-1));
}

test("the Mac offers Capture and Capture Full Page in the command bar", () => {
  assert.deepEqual(offered(null), { unavailable: [], bar: ["capture", "captureFullPage"] });
});

for (const platform of ["linux", "windows"]) {
  test(`${platform} doesn't offer Capture or Capture Full Page, since its pages can't capture yet`, () => {
    assert.deepEqual(offered(platform), { unavailable: ["capture", "captureFullPage"], bar: [] });
  });
}
