import XCTest
@testable import ArdiaUpdaterCore

final class LocalReportLinesTests: XCTestCase {
  func testAReportLeavesOutCountsRecordedWhileSharingWasOffAndKeepsEverythingElse() {
    let lines = [
      #"{"at":1,"kind":"event","sent":false,"event":"usage_counts","uuid":"a","distinct_id":null,"properties":{"tabs_opened":3}}"#,
      #"{"at":2,"kind":"event","sent":true,"event":"usage_counts","uuid":"b","distinct_id":"id","properties":{"tabs_opened":1}}"#,
      #"{"at":3,"kind":"event","sent":false,"event":"tab_presses","uuid":"c","distinct_id":null,"properties":{"presses":4}}"#,
      #"{"at":4,"kind":"event","sent":false,"event":"page_process_gone","uuid":"d","distinct_id":null,"properties":{"reason":"crashed"}}"#,
      #"{"at":5,"kind":"log","sent":false,"level":"error","message":"boom","attributes":{}}"#,
      #"{"at":6,"kind":"event","sent":false,"event":"report_sheet_opened","uuid":"e","distinct_id":null,"properties":{"note":"\"sent\":false,\"event\":\"usage_counts\""}}"#,
    ]
    let filtered = LocalReportLines.withoutUnsentCounts(Data((lines.joined(separator: "\n") + "\n").utf8))
    let kept = String(decoding: filtered.data, as: UTF8.self).split(separator: "\n").map(String.init)
    XCTAssertEqual(kept, [lines[1], lines[3], lines[4], lines[5]])
    XCTAssertEqual(filtered.lines, 4)
  }

  func testALastLineWithoutANewlineIsKeptWhole() {
    let line = #"{"at":7,"kind":"event","sent":true,"event":"usage_counts","uuid":"f","distinct_id":"id","properties":{}}"#
    let filtered = LocalReportLines.withoutUnsentCounts(Data(line.utf8))
    XCTAssertEqual(String(decoding: filtered.data, as: UTF8.self), line + "\n")
    XCTAssertEqual(filtered.lines, 1)
  }

  func testOnlyATopLevelUnsentCountIsLeftOutWhateverItsKeyOrderOrSpacing() {
    let lines = [
      #"{"event":"usage_counts","sent":false,"at":1,"kind":"event"}"#,
      #"{ "at": 2, "kind": "event", "sent": false, "event": "tab_presses" }"#,
      #"{"at":3,"kind":"event","sent":true,"event":"report_sheet_opened","properties":{"sent":false,"event":"usage_counts"}}"#,
      #"{"at":4,"kind":"event","sent":false,"event":"report_sheet_opened","properties":{"event":"usage_counts"}}"#,
      "not json",
    ]
    let filtered = LocalReportLines.withoutUnsentCounts(Data((lines.joined(separator: "\n") + "\n").utf8))
    let kept = String(decoding: filtered.data, as: UTF8.self).split(separator: "\n").map(String.init)
    XCTAssertEqual(kept, [lines[2], lines[3], lines[4]])
  }
}

