import Foundation
import Testing
@testable import ArdiaBrowser

@Suite struct LoadCommitTests {
  @Test func `a load that starts has not committed until WebKit commits it`() {
    #expect(!PageLoadCommit.after(loading: true, wasLoading: false, committed: true))
    #expect(!PageLoadCommit.after(loading: true, wasLoading: true, committed: false))
    #expect(PageLoadCommit.after(loading: true, wasLoading: true, committed: true), "the commit came during the load")
  }

  @Test func `a load that stops or fails before it commits leaves the page it was showing committed`() {
    #expect(PageLoadCommit.after(loading: false, wasLoading: true, committed: false))
    #expect(PageLoadCommit.after(loading: false, wasLoading: false, committed: true))
  }

  @Test func `a URL change while nothing loads is a same-document route, and one during a load is not`() {
    #expect(PageLoadCommit.sameDocument(loading: false, hadURL: true), "pushState, replaceState or a hash route")
    #expect(!PageLoadCommit.sameDocument(loading: true, hadURL: true), "a provisional load keeps the page it shows until it commits")
    #expect(!PageLoadCommit.sameDocument(loading: false, hadURL: false), "the first URL")
  }
}
