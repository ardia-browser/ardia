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

  public private(set) var awaitsReload = false
  public private(set) var isReloading = false

  public init() {}

  public mutating func processEnded(shown: Bool) -> Step {
    if isReloading, shown {
      isReloading = false
      awaitsReload = false
      return .showFailure
    }
    isReloading = false
    awaitsReload = true
    return shown ? .reload : .wait
  }

  public func pageShown() -> Step {
    awaitsReload ? .reload : .wait
  }

  public mutating func reloadStarted() {
    guard awaitsReload else { return }
    awaitsReload = false
    isReloading = true
  }

  public mutating func loadFinished() -> PageProcessOutcome? {
    guard isReloading else { return nil }
    isReloading = false
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
