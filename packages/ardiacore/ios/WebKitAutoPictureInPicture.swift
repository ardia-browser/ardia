struct WebKitAutoPictureInPicture {
  enum Action: Equatable {
    case none
    case open
    case close
    case heldForFullScreen
    case closeHeldForFullScreen
  }

  private(set) var seen = true
  private(set) var autoOpened = false
  private(set) var reportedActive = false
  private(set) var fullScreen = false
  private(set) var settlingFromFullScreen = false
  private(set) var openRequests = 0
  private var heldWhileAway = false
  private var followingTab: Int32?

  mutating func pageFullScreen(_ on: Bool, tab: Int32) {
    if tab != followingTab {
      followingTab = tab
      settlingFromFullScreen = false
    } else if on == fullScreen {
      return
    } else {
      settlingFromFullScreen = !on && (fullScreen || settlingFromFullScreen)
    }
    fullScreen = on
  }

  mutating func answered(_ request: Int, opened: Bool) {
    if request == openRequests && !opened { autoOpened = false }
  }

  mutating func sight(_ nowSeen: Bool, enabled: Bool, playing: Bool) -> Action {
    if nowSeen {
      settlingFromFullScreen = false
      heldWhileAway = false
    }
    let held = !nowSeen && (fullScreen || settlingFromFullScreen)
    let slipped = held && autoOpened
    let action = follow(nowSeen || held, enabled: enabled, playing: playing)
    guard held, !heldWhileAway else { return action }
    if action == .close && slipped {
      heldWhileAway = true
      return .closeHeldForFullScreen
    }
    guard action == .none, enabled, playing else { return action }
    heldWhileAway = true
    return .heldForFullScreen
  }

  private mutating func follow(_ nowSeen: Bool, enabled: Bool, playing: Bool) -> Action {
    guard nowSeen != seen else { return .none }
    seen = nowSeen
    if !nowSeen {
      guard enabled, playing else { return .none }
      autoOpened = true
      openRequests += 1
      return .open
    }
    guard autoOpened || reportedActive else { return .none }
    autoOpened = false
    return .close
  }

  mutating func reported(active: Bool) {
    if !active && reportedActive { autoOpened = false }
    reportedActive = active
  }
}
