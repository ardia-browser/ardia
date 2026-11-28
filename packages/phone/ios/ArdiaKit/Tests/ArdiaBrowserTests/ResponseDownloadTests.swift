import Foundation
import Testing
@testable import ArdiaBrowser

@Suite struct ResponseDownloadTests {
  let page = URL(string: "https://files.example/reports")

  @Test func `a response the page can't show downloads, in any frame`() {
    #expect(ResponseDownload.wanted(canShow: false, mainFrame: true, disposition: nil, response: URL(string: "https://files.example/a.zip"), page: page))
    #expect(ResponseDownload.wanted(canShow: false, mainFrame: false, disposition: nil, response: URL(string: "https://ads.example/a.zip"), page: page))
  }

  @Test func `an attachment the page opens itself downloads`() {
    #expect(ResponseDownload.wanted(canShow: true, mainFrame: true, disposition: "attachment; filename=\"a.pdf\"", response: URL(string: "https://other.example/a.pdf"), page: page))
  }

  @Test func `an attachment in a frame from the page's own site downloads, as a hidden frame download`() {
    #expect(ResponseDownload.wanted(canShow: true, mainFrame: false, disposition: " Attachment; filename=\"a.pdf\"", response: URL(string: "https://FILES.example/fast/a.pdf"), page: page))
  }

  @Test func `an attachment in a frame from another site shows in the frame instead of downloading`() {
    #expect(!ResponseDownload.wanted(canShow: true, mainFrame: false, disposition: "attachment", response: URL(string: "https://ads.example/a.pdf"), page: page))
    #expect(!ResponseDownload.wanted(canShow: true, mainFrame: false, disposition: "attachment", response: nil, page: page))
  }

  @Test func `a response that is inline stays on the page`() {
    #expect(!ResponseDownload.wanted(canShow: true, mainFrame: true, disposition: "inline", response: page, page: page))
    #expect(!ResponseDownload.wanted(canShow: true, mainFrame: true, disposition: nil, response: page, page: page))
  }
}
