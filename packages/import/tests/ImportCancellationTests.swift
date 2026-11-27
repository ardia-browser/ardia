import Foundation
import XCTest
@testable import ArdiaImportCore

final class ImportCancellationTests: XCTestCase {
  private func cookies(_ count: Int) -> [Cookie] {
    (0..<count).map { Cookie(domain: ".example.com", name: "c\($0)", value: SecretBytes(Array("v\($0)".utf8))) }
  }

  func testACancelThatArrivesBeforeTheJobRegistersStillCancelsIt() {
    let jobs = ImportJobs()
    jobs.cancel("write-1")
    XCTAssertTrue(jobs.start("write-1").isCancelled)
    XCTAssertFalse(jobs.start("write-2").isCancelled)
    XCTAssertFalse(jobs.start("write-1").isCancelled, "an early cancel is used once")
  }

  func testACancelForARunningJobCancelsItAndLeavesNothingBehind() {
    let jobs = ImportJobs()
    let running = jobs.start("read-1")
    jobs.cancel("read-1")
    XCTAssertTrue(running.isCancelled)
    jobs.finish("read-1")
    XCTAssertFalse(jobs.start("read-2").isCancelled)
  }

  func testEarlyCancelsExpireAndStayBounded() {
    var clock = Date(timeIntervalSince1970: 1_000)
    let jobs = ImportJobs(now: { clock })
    jobs.cancel("old")
    clock += ImportJobs.earlyCancelLifetime + 1
    XCTAssertFalse(jobs.start("old").isCancelled)
    for i in 0...ImportJobs.earlyCancelLimit { jobs.cancel("many-\(i)") }
    XCTAssertFalse(jobs.start("many-0").isCancelled, "the oldest early cancel past the limit is dropped")
    XCTAssertTrue(jobs.start("many-\(ImportJobs.earlyCancelLimit)").isCancelled)
  }

  func testACancelledWriteSendsNoBatchAndSaysSo() async {
    let cancellation = Cancellation()
    cancellation.cancel()
    var calls: [String] = []
    let body = await ImportBatchWriter.write(cookies: cookies(3), addresses: [ImportedAddress(name: "A")], cards: [], kinds: [.cookies, .autofill],
                                             cancellation: cancellation) { call, _ in
      calls.append(call)
      return [:]
    }
    XCTAssertEqual(calls, [])
    XCTAssertEqual(body["cancelled"] as? Int, 1)
  }

  func testACancelDuringTheLastBatchIsNotReportedWhenNothingWasLeft() async {
    let cancellation = Cancellation()
    var calls: [String] = []
    let body = await ImportBatchWriter.write(cookies: cookies(2), addresses: [], cards: [], kinds: [.cookies, .autofill],
                                             cancellation: cancellation) { call, _ in
      calls.append(call)
      cancellation.cancel()
      return ["imported": 2]
    }
    XCTAssertEqual(calls, ["ac_cookies_import"])
    XCTAssertNil(body["cancelled"])
    XCTAssertEqual(body["cookies"] as? Int, 2)
  }

  func testACancelBetweenBatchesSkipsTheRestAndSaysSo() async {
    let cancellation = Cancellation()
    var calls: [String] = []
    let body = await ImportBatchWriter.write(cookies: cookies(ImportBatchWriter.cookieBatch + 1), addresses: [ImportedAddress(name: "A")], cards: [],
                                             kinds: [.cookies, .autofill], cancellation: cancellation) { call, _ in
      calls.append(call)
      cancellation.cancel()
      return [:]
    }
    XCTAssertEqual(calls, ["ac_cookies_import"])
    XCTAssertEqual(body["cancelled"] as? Int, 1)
  }
}
