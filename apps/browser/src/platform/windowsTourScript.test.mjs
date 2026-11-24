import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const source = readFileSync(new URL("../../../../scripts/windows/tour.ps1", import.meta.url), "utf8");
const paramBlock = /^param\(([\s\S]*?)^\)/m.exec(source);
const paramNames = [...(paramBlock?.[1] ?? "").matchAll(/\]\s*\$(\w+)/g)].map((m) => m[1]);

const setupEnd = source.indexOf('if (-not ([System.Management.Automation.PSTypeName]"ArdiaTour").Type)');
const setup = source.slice(0, setupEnd);

const listsIn = (text) => [...text.matchAll(/^\$script:(\w+) = \[System\.Collections\.Generic\.List\[string\]\]::new\(\)/gm)].map((m) => m[1]);
const lists = listsIn(setup);
const allLists = listsIn(source);

const found = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
const hasPwsh = !found.error && found.status === 0;

test("none of tour.ps1's lists has the name of one of its parameters", () => {
  assert.ok(paramNames.includes("App") && paramNames.includes("Required"), `parameters read: ${paramNames.join(", ")}`);
  assert.ok(setupEnd > 0 && lists.includes("FailedStops") && lists.includes("RequiredFailures"), `lists found: ${allLists.join(", ")}`);
  const shadowing = allLists.filter((name) => paramNames.some((param) => param.toLowerCase() === name.toLowerCase()));
  assert.deepEqual(shadowing, [], "a $script: list named like a parameter is the parameter itself, and takes its type");
});

test("tour.ps1 keeps -Required, and every list it starts accepts an Add", { skip: !hasPwsh && "pwsh is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "ardia-tour-"));
  try {
    const script = join(dir, "tour-setup.ps1");
    writeFileSync(
      script,
      [setup, ...lists.map((name) => `$script:${name}.Add("probe")`), 'Write-Output "required=$($Required -join ",")"'].join("\n"),
    );
    const ran = spawnSync(
      "pwsh",
      ["-NoProfile", "-File", script, "-App", "Ardia.exe", "-Out", join(dir, "out"), "-Required", "peek-tabs"],
      { encoding: "utf8" },
    );
    assert.equal(ran.status, 0, `${ran.stdout}${ran.stderr}`);
    assert.match(ran.stdout, /^required=peek-tabs$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const tailStart = source.indexOf("if ($Only.Count) {");

function runTourTail(dir, partsScript, extraArgs = []) {
  const script = join(dir, "tour-tail.ps1");
  writeFileSync(
    script,
    [
      setup,
      'function Write-Tour { Set-Content -LiteralPath $tourFile -Value ($script:Lines -join "`n") }',
      "function Stop-TourPages {}",
      "function Stop-Ardia($Session) {}",
      partsScript,
      source.slice(tailStart),
    ].join("\n"),
  );
  return spawnSync("pwsh", ["-NoProfile", "-File", script, "-App", "Ardia.exe", "-Out", join(dir, "out"), ...extraArgs], {
    encoding: "utf8",
  });
}

test("a failed required stop lets the tour finish, write tour.md and required-failed.txt, and exit 1", { skip: !hasPwsh && "pwsh is not installed" }, () => {
  assert.ok(tailStart > setupEnd, "the tail of tour.ps1 starts at its -Only filter");
  const dir = mkdtempSync(join(tmpdir(), "ardia-tour-"));
  try {
    const later = join(dir, "later-part-ran");
    const ran = runTourTail(
      dir,
      [
        "$tours = @(",
        '  @{ Name = "first-run"; Run = { $script:FailedStops.Add("05 First run under load") }; Required = $true },',
        '  @{ Name = "typing"; Run = { throw "typing broke" }; Required = $true },',
        `  @{ Name = "later"; Run = { Set-Content -LiteralPath '${later}' -Value ran } }`,
        ")",
      ].join("\n"),
      ["-Required", "peek-tabs"],
    );
    assert.equal(ran.status, 1, `${ran.stdout}${ran.stderr}`);
    assert.ok(existsSync(later), "the part after the failures still ran");
    assert.ok(existsSync(join(dir, "out", "tour.md")), "tour.md was written");
    const failed = readFileSync(join(dir, "out", "required-failed.txt"), "utf8").trim().split(/\r?\n/);
    assert.deepEqual(failed, ["05 First run under load", "the typing part stopped early: typing broke", "peek-tabs: not run"]);
    const errors = ran.stdout.split(/\r?\n/).filter((line) => line.startsWith("::error::required tour stop failed: "));
    assert.equal(errors.length, 3, ran.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tour whose required stops all pass exits 0 and writes no required-failed.txt", { skip: !hasPwsh && "pwsh is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "ardia-tour-"));
  try {
    const ran = runTourTail(dir, '$tours = @(@{ Name = "first-run"; Run = { $script:Lines.Add("- fine") }; Required = $true })');
    assert.equal(ran.status, 0, `${ran.stdout}${ran.stderr}`);
    assert.ok(existsSync(join(dir, "out", "tour.md")));
    assert.ok(!existsSync(join(dir, "out", "required-failed.txt")));
    assert.doesNotMatch(ran.stdout, /::error::/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
