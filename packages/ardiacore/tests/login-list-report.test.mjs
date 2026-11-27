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

const TICKET_DRIVER = `
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
      id ticket = [message isKindOfClass:NSDictionary.class] ? ((NSDictionary *)message)[@"ticket"] : nil;
      [out addObject:ArdiaLoginListTicket(ticket) ?: NSNull.null];
    }
    NSData *json = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
    fwrite(json.bytes, 1, json.length, stdout);
  }
  return 0;
}
`;

function reports(messages, source = DRIVER) {
  const dir = mkdtempSync(join(tmpdir(), "login-list-report-"));
  try {
    const driver = join(dir, "driver.mm");
    const binary = join(dir, "driver");
    writeFileSync(driver, source);
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
      (["username", "password", "code", "newPassword"].includes(report.field) &&
        (report.field === "newPassword"
          ? [report.maxLength, report.minLength].every((n) => Number.isInteger(n) && n >= 0 && n <= 1024) && !("pattern" in report)
          : !("maxLength" in report || "minLength" in report || "pattern" in report)) &&
        typeof report.typed === "string" &&
        report.typed.length <= 200 &&
        (report.field === "username" || report.typed === "") &&
        report.rect.every((n) => Number.isFinite(n) && Math.abs(n) <= LIMIT) &&
        report.rect[2] >= 1 &&
        report.rect[3] >= 1)));

test("a Login list field report keeps its event, token, field, typed value and rect", { skip: process.platform !== "darwin" }, () => {
  const [show, typing, password, code, key, hide, passwordInput, signIn, claimed, identifier] = reports([
    SHOW,
    { ...SHOW, event: "input", typed: "ad" },
    { ...SHOW, field: "password", typed: "fixture-pw-ada-1" },
    { ...SHOW, field: "code", typed: "135790" },
    { event: "key", token: "3", key: "down" },
    { event: "hide" },
    { event: "passwordInput", token: "3", typed: "fixture-pw-ada-1" },
    { ...SHOW, signIn: true },
    { ...SHOW, field: "password", signIn: true },
    { ...SHOW, field: "identifier", signIn: true },
  ]);
  assert.deepEqual(identifier, { event: "show", token: "3", field: "identifier", signIn: true, typed: "ada", rect: [10, 20, 300, 30] }, "a username-first step's field keeps its typed value and signs in");
  assert.deepEqual(show, { event: "show", token: "3", field: "username", signIn: false, typed: "ada", rect: [10, 20, 300, 30] });
  assert.deepEqual(typing, { event: "input", token: "3", field: "username", signIn: false, typed: "ad", rect: [10, 20, 300, 30] });
  assert.equal(signIn.signIn, true, "a username field on a sign-in form says so");
  assert.ok(!("signIn" in claimed), "only a username field carries whether its form signs in");
  assert.equal(password.typed, "", "a password field's value is never kept");
  assert.deepEqual(code, { event: "show", token: "3", field: "code", typed: "", rect: [10, 20, 300, 30] }, "a code field's value is never kept");
  assert.deepEqual(key, { event: "key", token: "3", key: "down" });
  assert.deepEqual(hide, { event: "hide" });
  assert.deepEqual(passwordInput, { event: "passwordInput", token: "3" }, "typing a password keeps nothing of it");
});

test("a new-password field report keeps its maxlength and minlength, bounded, never its pattern, and nothing typed", { skip: process.platform !== "darwin" }, () => {
  const NEW = { ...SHOW, field: "newPassword", typed: "fixture-pw-new", maxLength: 20, minLength: 8, pattern: "[A-Za-z0-9-]+" };
  const [kept, huge, odd, password] = reports([NEW, { ...NEW, maxLength: 1e9, minLength: -4, pattern: "x".repeat(513) }, { ...NEW, maxLength: true, minLength: "8", pattern: 7 }, { ...SHOW, field: "password", maxLength: 20, pattern: "x" }]);
  assert.deepEqual(kept, { event: "show", token: "3", field: "newPassword", typed: "", maxLength: 20, minLength: 8, rect: [10, 20, 300, 30] });
  assert.deepEqual([huge.maxLength, huge.minLength, "pattern" in huge], [1024, 0, false], "lengths are clamped and a pattern is never kept");
  assert.deepEqual([odd.maxLength, odd.minLength], [0, 0], "values of the wrong kind count as unset");
  assert.ok(!("maxLength" in password || "pattern" in password), "only a new-password field carries the field's rules");
});

test("B1: every hostile value in every field of a Login list report is refused or kept within the report's contract", { skip: process.platform !== "darwin" }, () => {
  const messages = [];
  for (const { value } of HOSTILE_VALUES) {
    messages.push(value);
    for (const name of [...Object.keys(SHOW), "key", "maxLength", "minLength", "pattern"]) {
      messages.push({ ...SHOW, [name]: value });
      messages.push({ ...SHOW, field: "newPassword", maxLength: 20, minLength: 8, pattern: "[a-z]+", [name]: value });
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

test("B1: every hostile value as a loginFilled ticket is refused or kept as the digit token native issued", { skip: process.platform !== "darwin" }, () => {
  const messages = [{ ticket: "7", filled: true }, { ticket: "1234567890123456", filled: false }];
  for (const { value } of HOSTILE_VALUES) {
    messages.push(value, { ticket: value, filled: true });
    for (const wrapped of [`7${typeof value === "string" ? value : ""}`, `${typeof value === "string" ? value : ""}7`]) messages.push({ ticket: wrapped, filled: true });
  }
  messages.push({ ticket: "12345678901234567", filled: true }, { ticket: "-7", filled: true }, { ticket: "7.0", filled: true }, { ticket: "\uff17", filled: true });
  const seen = reports(messages, TICKET_DRIVER);
  assert.equal(seen.length, messages.length);
  assert.deepEqual(seen.slice(0, 2), ["7", "1234567890123456"], "a ticket native issued still goes through, so the check below ran on real ones");
  const broken = seen.map((ticket, i) => [ticket, messages[i]]).filter(([ticket, message]) => ticket !== null && !(/^[0-9]{1,16}$/.test(ticket) && String(message.ticket).includes(ticket)));
  assert.deepEqual(broken.slice(0, 5), []);
  assert.deepEqual(seen.slice(-4), [null, null, null, null], "a 17-digit, signed, decimal or full-width ticket is refused");
});
