import XCTest
@testable import ArdiaUpdaterCore

final class SparkleFailureTests: XCTestCase {
  let sparkle = SparkleFailure.sparkleDomain

  func testDownloadErrorsAreCountedAsDownloadFailures() {
    XCTAssertEqual(SparkleFailure.of(domain: sparkle, code: 2001, downloading: true), SparkleFailure(stage: .download, reason: "network"))
    XCTAssertEqual(SparkleFailure.of(domain: sparkle, code: 2000, downloading: true), SparkleFailure(stage: .download, reason: "disk"))
    XCTAssertEqual(SparkleFailure.of(domain: NSURLErrorDomain, code: -1009, downloading: true), SparkleFailure(stage: .download, reason: "network"))
  }

  func testExtractSignatureAndInstallErrorsAreCountedAsInstallFailures() {
    XCTAssertEqual(SparkleFailure.of(domain: sparkle, code: 3000, downloading: false)?.reason, "extract")
    XCTAssertEqual(SparkleFailure.of(domain: sparkle, code: 3001, downloading: false)?.reason, "signature")
    XCTAssertEqual(SparkleFailure.of(domain: sparkle, code: 3002, downloading: false)?.reason, "signature")
    XCTAssertEqual(SparkleFailure.of(domain: sparkle, code: 4005, downloading: false), SparkleFailure(stage: .install, reason: "install"))
    XCTAssertEqual(SparkleFailure.of(domain: sparkle, code: 4001, downloading: false)?.reason, "auth")
  }

  func testNoUpdateCancelsAndCheckErrorsAreNotUpdateFailures() {
    XCTAssertNil(SparkleFailure.of(domain: sparkle, code: 1001, downloading: false))
    XCTAssertNil(SparkleFailure.of(domain: sparkle, code: 4007, downloading: false))
    XCTAssertNil(SparkleFailure.of(domain: sparkle, code: 4008, downloading: false))
    XCTAssertNil(SparkleFailure.of(domain: sparkle, code: 1000, downloading: false))
    XCTAssertNil(SparkleFailure.of(domain: NSURLErrorDomain, code: -1009, downloading: false))
  }

  func testTheEventCarriesOnlyTheStageAndReason() {
    let event = SparkleFailure(stage: .install, reason: "signature").event
    XCTAssertEqual(Set(event.keys), ["type", "stage", "reason"])
  }
}
