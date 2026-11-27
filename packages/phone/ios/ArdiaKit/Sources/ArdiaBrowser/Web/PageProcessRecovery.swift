import Foundation

public enum PageProcessOutcome: String, Sendable {
  case gone
  case recovered
  case failed
}

public struct PageProcessRecovery: Equatable, Sendable {
  public enum Step: Equatable, Sendable {
    case wait
    case reload
    case showFailure
  }

  public static let retryWindow: TimeInterval = 60

  public private(set) var awaitsReload = false
  public private(set) var isReloading = false
  public private(set) var showsFailure = false
  private var recoveredAt: TimeInterval?
  private var committedHost: String?

  public init() {}

  public mutating func processEnded(shown: Bool, at now: TimeInterval) -> Step {
    let diedRightAfterRecovery = recoveredAt.map { now - $0 < Self.retryWindow } ?? false
    if shown, isReloading || diedRightAfterRecovery {
      isReloading = false
      awaitsReload = false
      recoveredAt = nil
      showsFailure = true
      return .showFailure
    }
    isReloading = false
    awaitsReload = true
    return shown ? .reload : .wait
  }

  public func pageShown() -> Step {
    awaitsReload ? .reload : .wait
  }

  public func loadsWhenMadeLive(shown: Bool) -> Bool {
    !showsFailure && (!awaitsReload || shown)
  }

  public mutating func reloadStarted() {
    guard awaitsReload else { return }
    awaitsReload = false
    isReloading = true
  }

  public mutating func personReloaded() {
    recoveredAt = nil
    guard showsFailure else { return }
    showsFailure = false
    awaitsReload = true
  }

  public mutating func personOpened() {
    recoveredAt = nil
    showsFailure = false
  }

  public mutating func pageCommitted(host: String?) {
    if host != committedHost { recoveredAt = nil }
    committedHost = host
  }

  public mutating func loadFinished(at now: TimeInterval) -> PageProcessOutcome? {
    guard isReloading else { return nil }
    isReloading = false
    recoveredAt = now
    return .recovered
  }

  public mutating func loadFailed() {
    isReloading = false
  }
}

@MainActor
enum WebViewCallbackRoute {
  static func owner<Owner: AnyObject, View: AnyObject>(_ owner: Owner?, of view: View, current: (Owner) -> View?) -> Owner? {
    guard let owner, let live = current(owner), live === view else { return nil }
    return owner
  }
}
