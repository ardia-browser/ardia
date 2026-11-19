import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const walk = fileURLToPath(new URL("../../../../scripts/windows/relaunch-walk.test.ps1", import.meta.url));

function findPwsh() {
  for (const candidate of [process.env.ARDIA_PWSH, "pwsh"].filter(Boolean)) {
    const probe = spawnSync(candidate, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

test("the relaunch check's during-quit cases bind every call they reach, with Windows stubbed", (t) => {
  const pwsh = findPwsh();
  if (!pwsh) {
    assert.ok(!process.env.CI, "CI has no pwsh, so the relaunch walk can't run");
    t.skip("no pwsh here; set ARDIA_PWSH to run the relaunch walk");
    return;
  }
  const run = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-File", walk], { encoding: "utf8", timeout: 240_000 });
  const output = `${run.stdout}\n${run.stderr}`;
  assert.equal(run.status, 0, output);
  assert.match(output, /walk: \d+ cases bound every call they reached/, output);
  assert.match(output, /walk: Test-LaunchWhileTheDownloadsQuestionShows reached \d+ of \d+ statement lines/, output);
  assert.match(output, /walk: Test-LaunchesDuringQuit ran every case on its own/, output);
});
