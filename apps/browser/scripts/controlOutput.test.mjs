import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const ios = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/shell/ios");
const swiftc = process.platform === "darwin" && spawnSync("xcrun", ["--find", "swiftc"]).status === 0;

const MAIN = String.raw`
import Darwin
import Foundation

func line(_ prefix: String, _ size: Int) -> Data {
  var d = Data(prefix.utf8)
  d.append(Data(repeating: UInt8(ascii: "x"), count: max(0, size - d.count - 3)))
  d.append(Data("\"}\n".utf8))
  return d
}
func event(_ size: Int, _ tag: Int = 0) -> Data { line("{\"event\":\"e\(tag)\",\"pad\":\"", size) }
func reply(_ size: Int, id: Int) -> Data { line("{\"id\":\(id),\"result\":\"", size) }
func kept(_ size: Int, _ n: Int) -> Data { line("{\"decide\":\"d\(n)\",\"pad\":\"", size) }

func pair(sendBuffer: Int32? = nil) -> (Int32, Int32) {
  var fds: [Int32] = [0, 0]
  precondition(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0)
  if var size = sendBuffer { setsockopt(fds[0], SOL_SOCKET, SO_SNDBUF, &size, socklen_t(MemoryLayout<Int32>.size)) }
  _ = fcntl(fds[0], F_SETFL, fcntl(fds[0], F_GETFL) | O_NONBLOCK)
  var timeout = timeval(tv_sec: 10, tv_usec: 0)
  setsockopt(fds[1], SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
  return (fds[0], fds[1])
}

func drain(_ out: inout ControlOutput) -> [Data] {
  let (w, r) = pair()
  _ = fcntl(r, F_SETFL, fcntl(r, F_GETFL) | O_NONBLOCK)
  var got = Data()
  var buffer = [UInt8](repeating: 0, count: 1 << 20)
  var spins = 0
  while spins < 1_000_000 {
    let result = out.write(to: w)
    let n = read(r, &buffer, buffer.count)
    if n > 0 { got.append(contentsOf: buffer[0..<n]) }
    if result == .drained && n <= 0 { break }
    if result == .failed { break }
    spins += 1
  }
  close(w); close(r)
  return got.split(separator: 10, omittingEmptySubsequences: false).dropLast().map { Data($0) }
}

var results: [String: Any] = [:]
let mib = ControlOutput.maxLine

do {
  var out = ControlOutput()
  for i in 0..<4 { _ = out.addEvent(event(mib, i)) }
  results["replyAfterFourEvents"] = out.addReply(reply(2500, id: 1), ticket: 1)
}

do {
  var out = ControlOutput()
  var replies = 0
  while out.bytes + 4 * (mib - 64) + ControlOutput.markerRoom + 1000 <= ControlOutput.maxBytes { _ = out.addReply(reply(1000, id: replies), ticket: 0); replies += 1 }
  for i in 0..<4 { _ = out.addEvent(event(mib - 64, i)) }
  let before = out.dropped
  let made = out.addReply(reply(mib, id: 999), ticket: 0)
  results["replyEvictsEvents"] = made && out.dropped > before && out.bytes + ControlOutput.markerRoom <= ControlOutput.maxBytes
  var full = ControlOutput()
  var n = 0
  while full.addReply(reply(mib, id: n), ticket: 0) { n += 1 }
  results["replyNeverTakesMarkerRoom"] = full.bytes + ControlOutput.markerRoom <= ControlOutput.maxBytes
}

do {
  var out = ControlOutput()
  var sentReplies: [Int] = []
  var sentKept: [Int] = []
  for i in 0..<3000 {
    _ = out.addEvent(event(4000, i))
    if i % 10 == 0 { _ = out.addReply(reply(3000, id: i), ticket: i + 1); sentReplies.append(i) }
    if i % 25 == 0 { _ = out.addKept(kept(3000, i)); sentKept.append(i) }
  }
  let lines = drain(&out).map { String(decoding: $0, as: UTF8.self) }
  let gotReplies = lines.compactMap { l -> Int? in l.hasPrefix("{\"id\":") ? Int(l.dropFirst(6).prefix { $0.isNumber }) : nil }
  let gotKept = lines.compactMap { l -> Int? in l.hasPrefix("{\"decide\":\"d") ? Int(l.dropFirst(12).prefix { $0.isNumber }) : nil }
  results["repliesNeverEvicted"] = gotReplies == sentReplies
  results["decideNeverEvicted"] = gotKept == sentKept
  results["eventsDropped"] = lines.contains { $0.hasPrefix("{\"dropped\":") }
  results["everyLineComplete"] = lines.allSatisfy { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) != nil }
  results["everyLineFits"] = lines.allSatisfy { $0.utf8.count + 1 <= mib }
}

do {
  var out = ControlOutput()
  _ = out.addEvent(event(mib + 10, 0))
  _ = out.addEvent(event(100, 1))
  var n = 0
  while out.bytes + mib + ControlOutput.markerRoom <= ControlOutput.maxBytes { _ = out.addReply(reply(mib, id: n), ticket: 0); n += 1 }
  let first = drain(&out).first.map { String(decoding: $0, as: UTF8.self) } ?? ""
  results["markerWrittenWithFullReplies"] = first.hasPrefix("{\"dropped\":")
}

do {
  var out = ControlOutput()
  _ = out.addEvent(event(mib + 10, 1))
  _ = out.addEvent(event(mib, 2000))
  _ = out.addEvent(event(200, 2001))
  let lines = drain(&out)
  let full = lines.first { $0.count == mib - 1 }
  let marked = lines.first { $0.starts(with: Data("{\"dropped\":".utf8)) }
  results["fullLineLeftUnmarked"] = full.map { $0.starts(with: Data("{\"event\":".utf8)) } ?? false
  results["markerCarriedToNextEvent"] = marked.map { String(decoding: $0, as: UTF8.self).contains("e2001") } ?? false
  results["markedLinesFit"] = lines.allSatisfy { $0.count + 1 <= mib }
}

do {
  var out = ControlOutput()
  _ = out.addEvent(event(mib + 10, 1))
  results["oversizedEventDropped"] = out.isEmpty && out.dropped == 1
  _ = out.addReply(reply(mib + 10, id: 42), ticket: 7)
  let lines = drain(&out)
  let parsed = lines.first.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
  results["oversizedReplyAnswersError"] = (parsed?["id"] as? Int) == 42 && (parsed?["error"] as? [String: Any])?["code"] as? String == "failed" && (lines.first?.count ?? mib) < mib
}

do {
  let (w, r) = pair(sendBuffer: 8192)
  let queue = DispatchQueue(label: "test")
  var closedSeen = false
  var unwritten: [Int] = []
  let connection = ControlConnection(id: 1, fd: w, queue: queue, onLine: { _, _ in }, onClose: { _ in closedSeen = true }, onWritten: { unwritten += $0 })
  let head = reply(200_000, id: 1)
  queue.sync {
    connection.open()
    connection.reply(head, ticket: 1)
    connection.reply(reply(5000, id: 2), ticket: 2)
    _ = connection.event(event(5000, 3))
    results["midLineBeforeRetire"] = !connection.closed
    connection.retire()
  }
  var got = Data()
  var buffer = [UInt8](repeating: 0, count: 65536)
  while true {
    let n = read(r, &buffer, buffer.count)
    if n <= 0 { break }
    got.append(contentsOf: buffer[0..<n])
  }
  queue.sync {}
  results["retireFinishesTheLine"] = got == head
  results["retireEndsOnNewline"] = got.last == 10
  results["retireAnnouncesClose"] = closedSeen
  results["retireReportsDroppedReply"] = queue.sync { unwritten.contains(2) }
  close(r)
}

do {
  var out = ControlOutput()
  let count = 150_000
  for n in 0..<count { _ = out.addKept(kept(200, n)) }
  let started = Date()
  let lines = drain(&out)
  results["bigQueueDrainSeconds"] = Date().timeIntervalSince(started)
  results["bigQueueInOrder"] = lines.count == count && lines.enumerated().allSatisfy { index, line in
    String(decoding: line.prefix(24), as: UTF8.self).hasPrefix("{\"decide\":\"d\(index)\"")
  }
  results["bigQueueEmptied"] = out.isEmpty && out.bytes == 0
}

do {
  let bytes = Array("ab\ncd\n\nef".utf8)
  results["newlines"] = [ControlConnection.newline(in: bytes, from: 0), ControlConnection.newline(in: bytes, from: 3), ControlConnection.newline(in: bytes, from: 6),
    ControlConnection.newline(in: bytes, from: 7), ControlConnection.newline(in: bytes, from: 99)].map { $0 ?? -1 }
}

let json = try! JSONSerialization.data(withJSONObject: results, options: [.sortedKeys])
print(String(decoding: json, as: UTF8.self))
`;

let dir;
let got = {};

before(() => {
  if (!swiftc) return;
  dir = mkdtempSync(join(tmpdir(), "control-output-"));
  writeFileSync(join(dir, "main.swift"), MAIN);
  execFileSync("xcrun", ["swiftc", "-O", join(ios, "ControlOutput.swift"), join(ios, "ControlConnection.swift"), join(dir, "main.swift"), "-o", join(dir, "run")], { stdio: "pipe" });
  got = JSON.parse(execFileSync(join(dir, "run"), { encoding: "utf8", timeout: 120_000 }).trim());
});
after(() => dir && rmSync(dir, { recursive: true, force: true }));

const skip = !swiftc && "needs swiftc";

test("a reply always gets room by evicting events, and never takes the dropped marker's room", { skip }, () => {
  assert.equal(got.replyAfterFourEvents, true, "four legal-sized events don't refuse a 2,500-byte reply");
  assert.equal(got.replyEvictsEvents, true, "a reply that needs room pushes out the oldest events");
  assert.equal(got.replyNeverTakesMarkerRoom, true);
});

test("under a slow reader only events are evicted: replies and decide messages all arrive, in order", { skip }, () => {
  assert.equal(got.repliesNeverEvicted, true);
  assert.equal(got.decideNeverEvicted, true);
  assert.equal(got.eventsDropped, true, "events were dropped and marked");
  assert.equal(got.everyLineComplete, true);
  assert.equal(got.everyLineFits, true);
});

test("the dropped marker always fits: it's written behind full replies, and a full-size event is left unmarked", { skip }, () => {
  assert.equal(got.markerWrittenWithFullReplies, true);
  assert.equal(got.fullLineLeftUnmarked, true, "marking a 1 MiB event would push it over the line");
  assert.equal(got.markerCarriedToNextEvent, true);
  assert.equal(got.markedLinesFit, true);
});

test("an event over the line is dropped and counted; a reply over it becomes an error for the same id", { skip }, () => {
  assert.equal(got.oversizedEventDropped, true);
  assert.equal(got.oversizedReplyAnswersError, true);
});

test("a connection that has to close finishes the line it started and leaves no partial line", { skip }, () => {
  assert.equal(got.retireFinishesTheLine, true, "only the half-written line goes out, whole");
  assert.equal(got.retireEndsOnNewline, true);
  assert.equal(got.retireAnnouncesClose, true);
  assert.equal(got.retireReportsDroppedReply, true, "the reply queued after it is reported unwritten");
});

test("a queue of 150,000 lines drains in order, all of it, in well under a second", { skip }, () => {
  assert.equal(got.bigQueueInOrder, true);
  assert.equal(got.bigQueueEmptied, true);
  assert.ok(got.bigQueueDrainSeconds < 1, `draining took ${got.bigQueueDrainSeconds} s`);
});

test("a line ends at the next newline from where the scan starts", { skip }, () => {
  assert.deepEqual(got.newlines, [2, 5, 6, -1, -1]);
});
