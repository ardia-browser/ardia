import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HOSTILE_VALUES } from "../../../scripts/security/hostile-inputs.mjs";

const guard = fileURLToPath(new URL("../ios/ArdiaLoginListReport.mm", import.meta.url));
const ios = fileURLToPath(new URL("../ios/", import.meta.url));

const DRIVER = `
#import <Foundation/Foundation.h>
#import "ArdiaLoginListReport.h"
int main() {
  @autoreleasepool {
    NSData *input = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
    NSArray *lines = [[[NSString alloc] initWithData:input encoding:NSUTF8StringEncoding] componentsSeparatedByString:@"\\n"];
    NSMutableArray *out = [NSMutableArray array];
    for (NSString *line in lines) {
      if (!line.length) continue;
      id message = [NSJSONSerialization JSONObjectWithData:[line dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
      NSDictionary *report = ArdiaLoginListReport(message);
      if (!report) { [out addObject:NSNull.null]; continue; }
      NSMutableDictionary *seen = [report mutableCopy];
      if (!report[@"rect"]) { [out addObject:seen]; continue; }
      NSRect rect = [report[@"rect"] rectValue];
      seen[@"rect"] = @[ @(rect.origin.x), @(rect.origin.y), @(rect.size.width), @(rect.size.height) ];
      [out addObject:seen];
    }
    NSData *json = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
    fwrite(json.bytes, 1, json.length, stdout);
  }
  return 0;
}
`;

function reports(messages) {
  const dir = mkdtempSync(join(tmpdir(), "login-list-report-"));
  try {
    const driver = join(dir, "driver.mm");
    const binary = join(dir, "driver");
    writeFileSync(driver, DRIVER);
    const built = spawnSync("xcrun", ["clang++", "-std=c++20", "-fobjc-arc", "-Wall", "-Werror", "-framework", "Foundation", "-framework", "AppKit", "-I", ios, guard, driver, "-o", binary], { encoding: "utf8", timeout: 60_000 });
    assert.equal(built.status, 0, built.stderr || String(built.error));
    const ran = spawnSync(binary, [], { input: messages.map((m) => JSON.stringify(m) ?? "null").join("\n"), encoding: "utf8", timeout: 20_000 });
    assert.equal(ran.status, 0, ran.stderr);
    return JSON.parse(ran.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SHOW = { event: "show", token: "3", field: "username", typed: "ada", x: 10, y: 20, width: 300, height: 30 };
const KEYS = ["down", "up", "enter", "escape", "tab"];
const LIMIT = 1e6;

const withinContract = (report) =>
  report === null ||
  (["show", "input", "key", "hide", "passwordInput"].includes(report.event) &&
    (report.event === "hide" || /^[0-9]{1,16}$/.test(report.token)) &&
    (report.event !== "key" || KEYS.includes(report.key)) &&
    (!["show", "input"].includes(report.event) ||
      (["username", "password"].includes(report.field) &&
        typeof report.typed === "string" &&
        report.typed.length <= 200 &&
        (report.field === "username" || report.typed === "") &&
        report.rect.every((n) => Number.isFinite(n) && Math.abs(n) <= LIMIT) &&
        report.rect[2] >= 1 &&
        report.rect[3] >= 1)));

test("a Login list field report keeps its event, token, field, typed value and rect", { skip: process.platform !== "darwin" }, () => {
  const [show, typing, password, key, hide, passwordInput] = reports([
    SHOW,
    { ...SHOW, event: "input", typed: "ad" },
    { ...SHOW, field: "password", typed: "fixture-pw-ada-1" },
    { event: "key", token: "3", key: "down" },
    { event: "hide" },
    { event: "passwordInput", token: "3", typed: "fixture-pw-ada-1" },
  ]);
  assert.deepEqual(show, { event: "show", token: "3", field: "username", typed: "ada", rect: [10, 20, 300, 30] });
  assert.deepEqual(typing, { event: "input", token: "3", field: "username", typed: "ad", rect: [10, 20, 300, 30] });
  assert.equal(password.typed, "", "a password field's value is never kept");
  assert.deepEqual(key, { event: "key", token: "3", key: "down" });
  assert.deepEqual(hide, { event: "hide" });
  assert.deepEqual(passwordInput, { event: "passwordInput", token: "3" }, "typing a password keeps nothing of it");
});

test("B1: every hostile value in every field of a Login list report is refused or kept within the report's contract", { skip: process.platform !== "darwin" }, () => {
  const messages = [];
  for (const { value } of HOSTILE_VALUES) {
    messages.push(value);
    for (const name of [...Object.keys(SHOW), "key"]) {
      messages.push({ ...SHOW, [name]: value });
      messages.push({ event: "key", token: "3", key: "down", [name]: value });
    }
  }
  const seen = reports(messages);
  assert.equal(seen.length, messages.length);
  const broken = seen.map((report, i) => [report, messages[i]]).filter(([report]) => !withinContract(report));
  assert.deepEqual(broken.slice(0, 5), []);
  assert.ok(seen.some((r) => r?.event === "show"), "some reports still go through, so the check above ran on real ones");
  for (const typed of seen.filter((r) => r?.typed !== undefined).map((r) => r.typed)) assert.ok(typed.length <= 200);
});
