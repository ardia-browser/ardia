import { readFileSync } from "node:fs";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { runSwiftTests } from "./swift-testing.mjs";

test("a ranged clear keeps permissions and external-app allowances chosen before the range (Swift Testing)", (t) => {
  runSwiftTests(t, "site-choices-test", ["../ios/WebKitSiteChoices.swift", "./webkit-site-choices.test.swift"]);
});

const method = (source, signature) => {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, signature);
  const body = source.indexOf(" {\n", start) + 1;
  let depth = 1, end = body + 1;
  for (; depth && end < source.length; end++) depth += Number(source[end] === "{") - Number(source[end] === "}");
  return source.slice(start, end);
};

const compile = (t, name, source) => {
  const probe = spawnSync("swiftc", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return t.skip("swiftc is not available");
  const dir = mkdtempSync(join(tmpdir(), `ardia-${name}-`));
  try {
    const file = join(dir, "main.swift"), binary = join(dir, "test");
    writeFileSync(file, source);
    const built = spawnSync("swiftc", ["-swift-version", "5", file, "-o", binary], { encoding: "utf8", timeout: 120_000 });
    assert.equal(built.status, 0, built.stderr);
    const ran = spawnSync(binary, [dir], { encoding: "utf8", timeout: 10_000 });
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const ios = (name) => readFileSync(new URL(`../ios/${name}`, import.meta.url), "utf8");

test("the saved HSTS list round-trips, is removed on an all-time clear and reports read and write failures (Swift Testing)", (t) => {
  runSwiftTests(t, "transport-security-file-test", ["../ios/WebKitCertificatePolicy.swift", "./webkit-transport-security-file.test.swift"]);
});

test("WebKit's clear hands the time range to permissions, HSTS and site data, and finishes only after the HSTS list is saved", (t) => {
  const clear = method(ios("WebKitHub.swift"), "func clearBrowsingData(profile: String");
  compile(t, "webkit-clear-range", `${ios("WebKitSiteChoices.swift")}
var log: [String] = []
var hstsDone: ((String?) -> Void)?
func describe(_ date: Date?) -> String { date.map { String(Int($0.timeIntervalSince1970)) } ?? "all" }
enum WebKitTabHistory { static func cleared(profile: String) { log.append("history") } }
final class Certificates {
  func forgetTransportSecurity(profile: String, since: Date?, done: @escaping (String?) -> Void) { log.append("hsts " + describe(since)); hstsDone = done }
}
final class DataStore { func removeData(ofTypes kinds: Set<String>, modifiedSince date: Date, completionHandler: @escaping () -> Void) { log.append("data " + String(Int(date.timeIntervalSince1970))); completionHandler() } }
final class Stores {
  func hasStore(for profile: String) -> Bool { true }
  func dataStore(for profile: String) -> DataStore { DataStore() }
  func forgetSitePermissions(of profile: String, since: Date?) { log.append("choices " + describe(since)) }
}
let WKWebsiteDataTypeDiskCache = "disk", WKWebsiteDataTypeMemoryCache = "memory", WKWebsiteDataTypeFetchCache = "fetch"
final class Hub {
  static let siteDataTypes: Set<String> = ["cookies"]
  let certificates = Certificates()
  let stores = Stores()
  ${clear}
}
func drain() { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
for (since, want, saveError) in [(1_800_000_000_000.0, "1800000000", nil), (0, "all", "couldn't save the HSTS list: full" as String?)] {
  log = []
  var replies: [String?] = []
  Hub().clearBrowsingData(profile: "p", types: ["siteData", "cache"], since: since) { replies.append($0) }
  drain()
  let data = want == "all" ? String(Int(Date.distantPast.timeIntervalSince1970)) : want
  precondition(log == ["hsts " + want, "choices " + want, "data " + data], log.joined(separator: ", "))
  precondition(replies.isEmpty, "the clear finished before the HSTS list was saved")
  hstsDone?(saveError)
  drain()
  precondition(replies.count == 1 && replies[0] == saveError, String(describing: replies))
}
log = []
var cacheReplies = 0
Hub().clearBrowsingData(profile: "p", types: ["cache"], since: 1_800_000_000_000) { precondition($0 == nil); cacheReplies += 1 }
drain()
precondition(log == ["data 1800000000"] && cacheReplies == 1, log.joined(separator: ", "))
`);
});

test("WebKit's HSTS list: a clear is on disk when it reports done, an unreadable list is never overwritten, and a clear cancels the pending save", (t) => {
  const source = ios("WebKitTab+Certificate.swift");
  const pieces = ["func forgetTransportSecurity(profile: String", "func noteTransportSecurity(", "private func policy(", "private func readAgainIfUnreadable(",
    "private func change<T>(", "private static func load(", "private func scheduleSave("].map((signature) => method(source, signature));
  compile(t, "webkit-hsts-persist", `${ios("WebKitCertificatePolicy.swift")}
import Foundation
enum StoreID: Hashable { case profile(String) }
final class Stores { func id(of profile: String) -> StoreID { .profile(profile) } }
final class WebKitHub { static let shared = WebKitHub(); let stores = Stores() }
enum WebKitPreloadedHSTS { static func isIPAddress(_ host: String) -> Bool { false } }
let folder = URL(fileURLWithPath: CommandLine.arguments[1])
final class Certificates {
  static let files = DispatchQueue(label: "files")
  var policies: [StoreID: WebKitCertificatePolicy] = [:]
  var pendingSaves: [StoreID: DispatchWorkItem] = [:]
  var unreadable = Set<StoreID>()
  static func file(for store: StoreID) -> URL? { folder.appendingPathComponent("p.json") }
  func note(_ header: String, _ host: String) { noteTransportSecurity(header, host: host, fingerprint: nil, store: .profile("p")) }
  func requires(_ host: String) -> Bool { policy(.profile("p")).requiresHTTPS(host: host, now: Date()) }
  ${pieces.join("\n  ")}
}
func spin(until done: () -> Bool, seconds: Double = 5) {
  let deadline = Date().addingTimeInterval(seconds)
  while !done() && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
}
func clear(_ certificates: Certificates, since: Date?) -> String? {
  var finished: String?? = .none
  certificates.forgetTransportSecurity(profile: "p", since: since) { finished = .some($0) }
  spin { finished != nil }
  guard let result = finished else { fatalError("the clear never finished") }
  return result
}
let now = Date()
let file = Certificates.file(for: .profile("p"))!
let day: Double = 86_400
let entry = { (observedAgo: Double) in WebKitTransportSecurity(expires: now.timeIntervalSince1970 + day, subdomains: false, observed: now.timeIntervalSince1970 - observedAgo) }
let saved = ["old.example": entry(7 * day), "revoked.example": entry(7 * day), "new.example": entry(60)]
let lastHour = now.addingTimeInterval(-3_600)
let keys = { Set((try? WebKitCertificatePolicy.SavedList.read(file))?.keys.map { $0 } ?? []) }
let lock = { (mode: Int) in try! FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: file.path) }

precondition(WebKitCertificatePolicy.SavedList.write(saved, to: file) == nil)
precondition(clear(Certificates(), since: lastHour) == nil)
precondition(keys() == ["old.example", "revoked.example"], "a ranged clear wasn't on disk when it finished: \\(keys())")
precondition(clear(Certificates(), since: nil) == nil && !FileManager.default.fileExists(atPath: file.path))

if geteuid() != 0 {
  precondition(WebKitCertificatePolicy.SavedList.write(saved, to: file) == nil)
  let before = try! Data(contentsOf: file)
  lock(0o000)
  let cold = Certificates()
  let coldRefusal = clear(cold, since: lastHour)
  precondition(coldRefusal?.hasPrefix("couldn't read the HSTS list") == true, "a cold ranged clear on an unreadable list: \\(String(describing: coldRefusal))")
  cold.note("max-age=0", "revoked.example")
  cold.note("max-age=600", "seen.example")
  spin(until: { false }, seconds: 2.4)
  lock(0o600)
  precondition(try! Data(contentsOf: file) == before, "an unreadable HSTS list was overwritten")
  precondition(clear(cold, since: lastHour) == nil, "the retry failed")
  precondition(keys() == ["old.example"], "the retry lost the older host or brought back a revoked one: \\(keys())")
  precondition(cold.requires("old.example") && !cold.requires("revoked.example") && !cold.requires("new.example"))
}

let debounced = Certificates()
debounced.note("max-age=600", "late.example")
precondition(clear(debounced, since: nil) == nil)
spin(until: { false }, seconds: 2.4)
precondition(!FileManager.default.fileExists(atPath: file.path), "a save queued before the clear wrote the list back")
`);
});
