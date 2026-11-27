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
    if isReloading {
      isReloading = false
      awaitsReload = false
      return .showFailure
    }
    awaitsReload = true
    return shown ? beginReload() : .wait
  }

  public mutating func pageShown() -> Step {
    awaitsReload ? beginReload() : .wait
  }

  public mutating func navigationAsked() {
    if awaitsReload { _ = beginReload() }
  }

  public mutating func loadFinished() -> PageProcessOutcome? {
    guard isReloading else { return nil }
    isReloading = false
    return .recovered
  }

  public mutating func loadFailed() {
    isReloading = false
  }

  private mutating func beginReload() -> Step {
    awaitsReload = false
    isReloading = true
    return .reload
  }
}
