import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const has = (tool) => spawnSync(tool, ["--version"], { encoding: "utf8" }).status === 0;

test("the dev-only Mac WebUI layer: pure headers, launcher, apply.sh, engine keys and boundaries", (t) => {
  if (!has("python3")) return t.skip("python3 is unavailable");
  if (!has(process.env.CXX || "clang++") && !has("c++")) return t.skip("no C++ compiler");
  const run = spawnSync("python3", [join(here, "test_mac_layer.py")], { encoding: "utf8", timeout: 540_000 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});
