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
  private(set) var seenInFullScreen = false
  var opensOverFullScreen: Bool { fullScreen && seenInFullScreen }
  private(set) var openRequests = 0
  private var heldWhileAway = false
  private var cancelledRequest: Int?
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
    seenInFullScreen = false
  }

  mutating func answered(_ request: Int, opened: Bool) {
    guard request == openRequests, !opened else { return }
    autoOpened = false
    if cancelledRequest == request { cancelledRequest = nil }
  }

  mutating func sight(_ nowSeen: Bool, inline: Bool = true, enabled: Bool, playing: Bool) -> Action {
    if nowSeen && (inline || !settlingFromFullScreen) {
      settlingFromFullScreen = false
      heldWhileAway = false
      seenInFullScreen = fullScreen
      if !fullScreen { cancelledRequest = nil }
    }
    let held = !nowSeen && ((fullScreen && !seenInFullScreen) || settlingFromFullScreen)
    let slipped = held && autoOpened
    let action = follow(nowSeen || held, enabled: enabled, playing: playing)
    guard held, !heldWhileAway else { return action }
    if action == .close {
      heldWhileAway = true
      guard slipped else { return .none }
      cancelledRequest = openRequests
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
      guard enabled, playing, !reportedActive else { return .none }
      autoOpened = true
      openRequests += 1
      return .open
    }
    guard autoOpened || reportedActive else { return .none }
    autoOpened = false
    return .close
  }

  @discardableResult
  mutating func reported(active: Bool) -> Bool {
    if !active && reportedActive {
      autoOpened = false
      cancelledRequest = nil
    }
    reportedActive = active
    guard active, cancelledRequest == openRequests, fullScreen || settlingFromFullScreen else { return false }
    cancelledRequest = nil
    return true
  }
}
