import XCTest
@testable import ArdiaUpdaterCore

final class CrashThreadTests: XCTestCase {
  private let unmarkedMain: [String: Any] = [
    "threads": [
      ["id": 1, "name": "CrRendererMain", "queue": "com.apple.main-thread", "frames": [["imageOffset": 16]]],
      ["id": 2, "name": "ThreadPoolForegroundWorker", "frames": [["imageOffset": 32]]],
    ],
  ]

  func testAReportThatIdentifiesNoFaultingThreadNamesNoCrashedThreadOrQueue() {
    XCTAssertNil(CrashThread.identified(in: unmarkedMain))
    let names = CrashThread.names(in: unmarkedMain)
    XCTAssertNil(names.thread, "an unmarked main thread was reported as the crashed thread")
    XCTAssertNil(names.queue, "an unmarked main thread's queue was reported as the crashed queue")
  }

  func testItsStackStillComesFromTheFirstThread() {
    XCTAssertEqual(CrashThread.stack(in: unmarkedMain), 0)
  }

  func testTheFaultingThreadIndexNamesTheCrashedThreadAndQueue() {
    var body = unmarkedMain
    body["faultingThread"] = 1
    XCTAssertEqual(CrashThread.identified(in: body), 1)
    XCTAssertEqual(CrashThread.stack(in: body), 1)
    let names = CrashThread.names(in: body)
    XCTAssertEqual(names.thread, "ThreadPoolForegroundWorker")
    XCTAssertNil(names.queue)
  }

  func testATriggeredThreadCountsWhenTheReportHasNoFaultingThreadIndex() {
    let body: [String: Any] = [
      "threads": [
        ["name": "CrBrowserMain", "queue": "com.apple.main-thread"],
        ["name": "Chrome_IOThread", "triggered": true],
      ],
    ]
    XCTAssertEqual(CrashThread.identified(in: body), 1)
    XCTAssertEqual(CrashThread.names(in: body).thread, "Chrome_IOThread")
  }

  func testAFaultingThreadIndexOutsideTheThreadsIsNotAnIdentification() {
    var body = unmarkedMain
    body["faultingThread"] = 7
    XCTAssertNil(CrashThread.identified(in: body))
    XCTAssertNil(CrashThread.names(in: body).thread)
    XCTAssertEqual(CrashThread.stack(in: body), 0)
  }
}
