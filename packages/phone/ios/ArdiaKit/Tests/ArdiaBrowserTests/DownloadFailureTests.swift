import Foundation
import Testing
@testable import ArdiaBrowser

@Suite struct DownloadFailureTests {
  @Test func `a lost or missing connection reads as the network`() {
    #expect(DownloadFailure.of(URLError(.notConnectedToInternet)) == .network)
    #expect(DownloadFailure.of(URLError(.networkConnectionLost)) == .network)
    #expect(DownloadFailure.of(URLError(.timedOut)) == .network)
    #expect(DownloadFailure.of(URLError(.cannotFindHost)) == .network)
  }

  @Test func `a site that answers badly or refuses reads as the site`() {
    #expect(DownloadFailure.of(URLError(.badServerResponse)) == .server)
    #expect(DownloadFailure.of(URLError(.zeroByteResource)) == .server)
    #expect(DownloadFailure.of(URLError(.resourceUnavailable)) == .server)
    #expect(DownloadFailure.of(status: 500) == .server)
    #expect(DownloadFailure.of(status: 404) == .server)
    #expect(DownloadFailure.of(status: 200) == nil)
    #expect(DownloadFailure.of(status: 304) == nil)
  }

  @Test func `redirect loops and links the phone can't fetch keep their own reasons`() {
    #expect(DownloadFailure.of(URLError(.httpTooManyRedirects)) == .tooManyRedirects)
    #expect(DownloadFailure.of(URLError(.unsupportedURL)) == .unsupported)
  }

  @Test func `a full phone reads as out of space, even under another error`() {
    #expect(DownloadFailure.of(CocoaError(.fileWriteOutOfSpace)) == .noSpace)
    #expect(DownloadFailure.of(NSError(domain: NSPOSIXErrorDomain, code: Int(ENOSPC))) == .noSpace)
    let wrapped = NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotWriteToFile, userInfo: [NSUnderlyingErrorKey: NSError(domain: NSPOSIXErrorDomain, code: Int(ENOSPC))])
    #expect(DownloadFailure.of(wrapped) == .noSpace)
  }

  @Test func `a file that can't be written reads as storage`() {
    #expect(DownloadFailure.of(URLError(.cannotWriteToFile)) == .storage)
    #expect(DownloadFailure.of(CocoaError(.fileWriteNoPermission)) == .storage)
  }

  @Test func `an error from nowhere it knows reads as the network, as before`() {
    #expect(DownloadFailure.of(NSError(domain: "WebKitErrorDomain", code: 102)) == .network)
  }
}
