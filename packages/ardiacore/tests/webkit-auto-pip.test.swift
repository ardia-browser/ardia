import Foundation
import Testing

struct AutoPictureInPictureRule {
  typealias Action = WebKitAutoPictureInPicture.Action

  @Test func `leaving a playing tab opens once and returning closes once`() {
    var rule = WebKitAutoPictureInPicture()
    #expect(rule.sight(false, enabled: true, playing: true) == .open)
    #expect(rule.sight(false, enabled: true, playing: true) == .none)
    #expect(rule.sight(true, enabled: true, playing: true) == .close)
    #expect(rule.sight(true, enabled: true, playing: true) == .none)
  }

  @Test func `nothing opens with the setting off or nothing playing`() {
    var off = WebKitAutoPictureInPicture()
    #expect(off.sight(false, enabled: false, playing: true) == .none)
    #expect(off.sight(true, enabled: false, playing: true) == .none)
    var idle = WebKitAutoPictureInPicture()
    #expect(idle.sight(false, enabled: true, playing: false) == .none)
    #expect(idle.sight(true, enabled: true, playing: false) == .none)
  }

  @Test func `a picture in picture the person closed doesn't reopen while away`() {
    var rule = WebKitAutoPictureInPicture()
    #expect(rule.sight(false, enabled: true, playing: true) == .open)
    rule.reported(active: true)
    rule.reported(active: false)
    #expect(rule.sight(false, enabled: true, playing: true) == .none)
    #expect(rule.sight(true, enabled: true, playing: true) == .none)
    #expect(rule.sight(false, enabled: true, playing: true) == .open)
  }

  @Test func `returning ends one the page reports open even with the setting off`() {
    var rule = WebKitAutoPictureInPicture()
    rule.reported(active: true)
    #expect(rule.sight(false, enabled: false, playing: true) == .none)
    #expect(rule.sight(true, enabled: false, playing: true) == .close)
  }

  @Test func `leave and return before the page reports still pair up`() {
    var rule = WebKitAutoPictureInPicture()
    #expect(rule.sight(false, enabled: true, playing: true) == .open)
    #expect(rule.sight(true, enabled: true, playing: true) == .close)
    rule.reported(active: false)
    #expect(rule.sight(false, enabled: true, playing: true) == .open)
  }

  @Test func `a page entering its own full screen keeps its video instead of popping it out`() {
    var rule = WebKitAutoPictureInPicture()
    rule.pageFullScreen(true, tab: 1)
    #expect(rule.sight(false, enabled: true, playing: true) == .heldForFullScreen)
    #expect(rule.sight(false, enabled: true, playing: true) == .none)
    rule.pageFullScreen(false, tab: 1)
    #expect(rule.sight(false, enabled: true, playing: true) == .none)
    #expect(rule.sight(true, enabled: true, playing: true) == .none)
    #expect(rule.sight(false, enabled: true, playing: true) == .open)
  }

  @Test func `leaving a page shown full screen keeps it full screen, as Chromium does`() {
    var rule = WebKitAutoPictureInPicture()
    rule.pageFullScreen(true, tab: 1)
    #expect(rule.sight(true, enabled: true, playing: true) == .none)
    #expect(rule.sight(false, enabled: true, playing: true) == .heldForFullScreen)
    #expect(rule.sight(true, enabled: true, playing: true) == .none)
    #expect(rule.sight(false, enabled: true, playing: true) == .heldForFullScreen)
  }

  @Test func `a pop out that slipped ahead of full screen closes once the page reports it`() {
    var rule = WebKitAutoPictureInPicture()
    #expect(rule.sight(false, enabled: true, playing: true) == .open)
    rule.answered(rule.openRequests, opened: true)
    rule.pageFullScreen(true, tab: 1)
    #expect(rule.sight(false, enabled: true, playing: true) == .closeHeldForFullScreen)
    #expect(rule.sight(false, enabled: true, playing: true) == .none)
    #expect(rule.sight(false, enabled: true, playing: false) == .none)
  }

  @Test func `a picture in picture opened before full screen is closed but not counted as a held pop out`() {
    var rule = WebKitAutoPictureInPicture()
    rule.reported(active: true)
    #expect(rule.sight(false, enabled: false, playing: true) == .none)
    rule.pageFullScreen(true, tab: 1)
    #expect(rule.sight(false, enabled: true, playing: true) == .close)
    #expect(rule.sight(false, enabled: true, playing: true) == .heldForFullScreen)
  }

  @Test func `the hold lasts until the window is seen again after full screen ends`() {
    var rule = WebKitAutoPictureInPicture()
    rule.pageFullScreen(true, tab: 1)
    rule.pageFullScreen(false, tab: 1)
    #expect(rule.settlingFromFullScreen)
    #expect(rule.sight(false, enabled: true, playing: true) == .heldForFullScreen)
    rule.pageFullScreen(true, tab: 1)
    rule.pageFullScreen(false, tab: 1)
    #expect(rule.sight(false, enabled: true, playing: true) == .none)
    #expect(rule.sight(true, enabled: true, playing: true) == .none)
    #expect(!rule.settlingFromFullScreen)
  }

  @Test func `a full screen hold counts only when the pop out would have happened`() {
    var off = WebKitAutoPictureInPicture()
    off.pageFullScreen(true, tab: 1)
    #expect(off.sight(false, enabled: false, playing: true) == .none)
    var idle = WebKitAutoPictureInPicture()
    idle.pageFullScreen(true, tab: 1)
    #expect(idle.sight(false, enabled: true, playing: false) == .none)
    #expect(idle.sight(false, enabled: true, playing: true) == .heldForFullScreen)
  }

  @Test func `a tab that was never in full screen pops out as before`() {
    var rule = WebKitAutoPictureInPicture()
    rule.pageFullScreen(false, tab: 1)
    #expect(!rule.settlingFromFullScreen)
    #expect(rule.sight(false, enabled: true, playing: true) == .open)
  }

  @Test func `an automatic open the page answered as not opened is neither closed nor counted when full screen follows`() {
    var rule = WebKitAutoPictureInPicture()
    #expect(rule.sight(false, enabled: true, playing: true) == .open)
    rule.answered(rule.openRequests, opened: false)
    rule.pageFullScreen(true, tab: 1)
    #expect(rule.sight(false, enabled: true, playing: false) == .none)
    #expect(rule.sight(false, enabled: true, playing: true) == .heldForFullScreen)
  }

  @Test func `an answer to an older automatic open leaves the newer one alone`() {
    var rule = WebKitAutoPictureInPicture()
    #expect(rule.sight(false, enabled: true, playing: true) == .open)
    let older = rule.openRequests
    #expect(rule.sight(true, enabled: true, playing: true) == .close)
    #expect(rule.sight(false, enabled: true, playing: true) == .open)
    rule.answered(older, opened: false)
    #expect(rule.autoOpened)
    #expect(rule.sight(true, enabled: true, playing: true) == .close)
  }

  @Test func `a view adopted after its full screen ended while parked starts without the hold`() {
    var rule = WebKitAutoPictureInPicture()
    rule.pageFullScreen(true, tab: 1)
    rule.pageFullScreen(false, tab: 1)
    #expect(rule.settlingFromFullScreen)
    rule.pageFullScreen(false, tab: 2)
    #expect(!rule.settlingFromFullScreen)
    #expect(rule.sight(false, enabled: true, playing: true) == .open)
  }

  @Test func `a view adopted while still in full screen keeps the hold`() {
    var rule = WebKitAutoPictureInPicture()
    rule.pageFullScreen(true, tab: 1)
    rule.pageFullScreen(true, tab: 2)
    #expect(rule.fullScreen)
    #expect(rule.sight(false, enabled: true, playing: true) == .heldForFullScreen)
    rule.pageFullScreen(false, tab: 2)
    #expect(rule.settlingFromFullScreen)
  }
}
