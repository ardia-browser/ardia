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

  @Test func `leaving a full-screen page's Space once it has been seen there opens automatic Picture in Picture, as #4504 wants`() {
    var rule = WebKitAutoPictureInPicture()
    rule.pageFullScreen(true, tab: 1)
    #expect(rule.sight(false, enabled: true, playing: true) == .heldForFullScreen)
    #expect(rule.sight(true, enabled: true, playing: true) == .none)
    #expect(rule.seenInFullScreen)
    #expect(rule.sight(false, enabled: true, playing: true) == .open)
    #expect(rule.sight(true, enabled: true, playing: true) == .close)
  }

  @Test func `a new full screen holds again until its own window is seen`() {
    var rule = WebKitAutoPictureInPicture()
    rule.pageFullScreen(true, tab: 1)
    #expect(rule.sight(true, enabled: true, playing: true) == .none)
    rule.pageFullScreen(false, tab: 1)
    #expect(rule.sight(true, enabled: true, playing: true) == .none)
    rule.pageFullScreen(true, tab: 1)
    #expect(!rule.seenInFullScreen)
    #expect(rule.sight(false, enabled: true, playing: true) == .heldForFullScreen)
  }

  @Test func `a late pop out reported after the full-screen window comes into sight is still closed`() {
    var rule = WebKitAutoPictureInPicture()
    #expect(rule.sight(false, enabled: true, playing: true) == .open)
    rule.pageFullScreen(true, tab: 1)
    #expect(rule.sight(false, enabled: true, playing: true) == .closeHeldForFullScreen)
    #expect(rule.sight(true, enabled: true, playing: true) == .none)
    let closes = rule.reported(active: true)
    #expect(closes)
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

  @Test func `a picture in picture the person opened before full screen is left open and not counted as a held pop out`() {
    var rule = WebKitAutoPictureInPicture()
    rule.reported(active: true)
    #expect(rule.sight(false, enabled: false, playing: true) == .none)
    rule.pageFullScreen(true, tab: 1)
    #expect(rule.sight(false, enabled: false, playing: true) == .none)
    #expect(rule.sight(false, enabled: true, playing: true) == .none)
    #expect(rule.reportedActive)
  }

  @Test func `full screen starting with automatic Picture in Picture off never closes a manual one`() {
    var rule = WebKitAutoPictureInPicture()
    #expect(rule.sight(false, enabled: false, playing: true) == .none)
    rule.reported(active: true)
    rule.pageFullScreen(true, tab: 1)
    #expect(rule.sight(false, enabled: false, playing: true) == .none)
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

  @Test func `a pop out the page reports open after full screen cancelled it is closed again, once`() {
    var rule = WebKitAutoPictureInPicture()
    #expect(rule.sight(false, enabled: true, playing: true) == .open)
    rule.pageFullScreen(true, tab: 1)
    #expect(rule.sight(false, enabled: true, playing: true) == .closeHeldForFullScreen)
    rule.answered(rule.openRequests, opened: true)
    let closes1 = rule.reported(active: true)
    #expect(closes1)
    let closes2 = rule.reported(active: true)
    #expect(!closes2)
  }

  @Test func `a picture in picture the person opens in full screen after the cancelled one ended stays open`() {
    var rule = WebKitAutoPictureInPicture()
    #expect(rule.sight(false, enabled: true, playing: true) == .open)
    rule.answered(rule.openRequests, opened: true)
    let closes3 = rule.reported(active: true)
    #expect(!closes3)
    rule.pageFullScreen(true, tab: 1)
    #expect(rule.sight(false, enabled: true, playing: true) == .closeHeldForFullScreen)
    let closes4 = rule.reported(active: false)
    #expect(!closes4)
    let closes5 = rule.reported(active: true)
    #expect(!closes5)
  }

  @Test func `a cancelled pop out the page never opened doesn't close a later one`() {
    var rule = WebKitAutoPictureInPicture()
    #expect(rule.sight(false, enabled: true, playing: true) == .open)
    rule.pageFullScreen(true, tab: 1)
    #expect(rule.sight(false, enabled: true, playing: true) == .closeHeldForFullScreen)
    rule.answered(rule.openRequests, opened: false)
    let closes6 = rule.reported(active: true)
    #expect(!closes6)
  }

  @Test func `a late report after the person is back, or once full screen is over and seen, is left alone`() {
    var rule = WebKitAutoPictureInPicture()
    #expect(rule.sight(false, enabled: true, playing: true) == .open)
    rule.pageFullScreen(true, tab: 1)
    #expect(rule.sight(false, enabled: true, playing: true) == .closeHeldForFullScreen)
    rule.pageFullScreen(false, tab: 1)
    #expect(rule.sight(true, enabled: true, playing: true) == .none)
    let closes7 = rule.reported(active: true)
    #expect(!closes7)
  }

  @Test func `leaving the Space of a full screen the page was seen in opens over it`() {
    var rule = WebKitAutoPictureInPicture()
    rule.pageFullScreen(true, tab: 1)
    #expect(!rule.opensOverFullScreen)
    #expect(rule.sight(true, enabled: true, playing: true) == .none)
    #expect(rule.sight(false, enabled: true, playing: true) == .open)
    #expect(rule.opensOverFullScreen)
  }

  @Test func `a sight change while WebKit is leaving full screen holds, even after the full screen was seen`() {
    var rule = WebKitAutoPictureInPicture()
    rule.pageFullScreen(true, tab: 1)
    #expect(rule.sight(true, enabled: true, playing: true) == .none)
    rule.pageFullScreen(false, tab: 1)
    #expect(!rule.seenInFullScreen)
    #expect(!rule.opensOverFullScreen)
    #expect(rule.sight(false, enabled: true, playing: true) == .heldForFullScreen)
    rule.pageFullScreen(false, tab: 1)
    #expect(rule.sight(false, enabled: true, playing: true) == .none)
    #expect(rule.sight(true, enabled: true, playing: true) == .none)
    #expect(rule.sight(false, enabled: true, playing: true) == .open)
  }

  @Test func `the exit hold outlasts the departing full-screen window and ends only when the inline tab is seen`() {
    var rule = WebKitAutoPictureInPicture()
    rule.pageFullScreen(true, tab: 1)
    #expect(rule.sight(true, inline: false, enabled: true, playing: true) == .none)
    rule.pageFullScreen(false, tab: 1)
    #expect(rule.sight(true, inline: false, enabled: true, playing: true) == .none)
    #expect(rule.settlingFromFullScreen)
    #expect(rule.sight(false, inline: true, enabled: true, playing: true) == .heldForFullScreen)
    #expect(rule.sight(true, inline: true, enabled: true, playing: true) == .none)
    #expect(!rule.settlingFromFullScreen)
    #expect(rule.sight(false, inline: true, enabled: true, playing: true) == .open)
  }

  @Test func `a Picture in Picture the person already has open is never taken for an automatic one, even when full screen follows`() {
    var rule = WebKitAutoPictureInPicture()
    rule.reported(active: true)
    #expect(rule.sight(false, enabled: true, playing: true) == .none)
    #expect(!rule.autoOpened)
    rule.pageFullScreen(true, tab: 1)
    #expect(rule.sight(false, enabled: true, playing: true) == .none)
    #expect(rule.sight(false, enabled: true, playing: true) == .none)
    #expect(rule.reportedActive)
  }
}
