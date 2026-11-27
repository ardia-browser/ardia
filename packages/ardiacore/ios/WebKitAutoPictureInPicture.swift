import Foundation

struct WebKitAutoPictureInPicture {
  static let pictureInPictureFrameLimit = 8

  enum Action: Equatable {
    case none
    case open
    case close
    case heldForFullScreen
    case closeHeldForFullScreen
  }

  struct Reported: Equatable {
    var closeAgain = false
    var heldNow = false
  }

  private(set) var seen = true
  private(set) var autoOpened = false
  private(set) var reportedActive = false
  private(set) var fullScreen = false
  private(set) var settlingFromFullScreen = false
  private(set) var seenInFullScreen = false
  var opensOverFullScreen: Bool { fullScreen && seenInFullScreen }
  private(set) var openRequests = 0
  private(set) var heldUntilBack = false
  private(set) var closeAsked = false
  private var heldWhileAway = false
  private var cancelledRequest: Int?
  private var followingTab: Int32?
  private var pictureInPictureFrames: Set<String> = []
  var pictureInPictureFrameCount: Int { pictureInPictureFrames.count }

  static func boolean(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
    return number.boolValue
  }

  static func pictureInPictureReport(_ data: [String: Any]?) -> (active: Bool, unloaded: Bool)? {
    guard let data, let active = boolean(data["active"]) else { return nil }
    guard let unloaded = data["unloaded"] else { return (active, false) }
    guard let flag = boolean(unloaded) else { return nil }
    return (active, flag)
  }

  mutating func report(_ data: [String: Any]?, from frame: String) -> (active: Bool, reported: Reported)? {
    guard let report = Self.pictureInPictureReport(data), let active = pictureInPicture(in: frame, active: report.active) else { return nil }
    return (active, reported(active: active, dismissed: !report.unloaded))
  }

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

  mutating func sight(_ nowSeen: Bool, userIn: Bool = true, inline: Bool = true, enabled: Bool, playing: Bool) -> Action {
    if heldUntilBack {
      guard nowSeen && userIn else { return .none }
      heldUntilBack = false
    }
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
      guard slipped else {
        closeAsked = false
        return .none
      }
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
    closeAsked = true
    return .close
  }

  mutating func noteRequestedClose() {
    if reportedActive { closeAsked = true }
  }

  mutating func requestedCloseFailed() {
    closeAsked = false
  }

  mutating func pictureInPicture(in frame: String, active: Bool) -> Bool? {
    if active {
      guard pictureInPictureFrames.contains(frame) || pictureInPictureFrames.count < Self.pictureInPictureFrameLimit else { return nil }
      pictureInPictureFrames.insert(frame)
      heldUntilBack = false
      return true
    }
    guard pictureInPictureFrames.remove(frame) != nil, pictureInPictureFrames.isEmpty else { return nil }
    return false
  }

  @discardableResult
  mutating func reported(active: Bool, dismissed: Bool = true) -> Reported {
    defer {
      reportedActive = active
      closeAsked = false
    }
    var result = Reported()
    if !active && reportedActive {
      autoOpened = false
      cancelledRequest = nil
      if dismissed && !closeAsked && !seen && !heldUntilBack {
        heldUntilBack = true
        result.heldNow = true
      }
    }
    if active, cancelledRequest == openRequests, fullScreen || settlingFromFullScreen {
      cancelledRequest = nil
      result.closeAgain = true
    }
    return result
  }

  mutating func pageGone() -> Bool {
    let wasActive = reportedActive
    pictureInPictureFrames.removeAll()
    reportedActive = false
    autoOpened = false
    closeAsked = false
    return wasActive
  }
}
