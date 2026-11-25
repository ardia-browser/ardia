import Foundation

@MainActor
public final class PageSummarySwitch {
  public static let enabledKey = "pageSummaries.enabled"

  private let defaults: UserDefaults
  public private(set) var revision = 0

  public init(defaults: UserDefaults) {
    self.defaults = defaults
  }

  public var isOn: Bool { defaults.bool(forKey: Self.enabledKey) }

  public func turn(_ on: Bool) {
    revision += 1
    defaults.set(on, forKey: Self.enabledKey)
  }

  public func isCurrent(_ asked: Int) -> Bool {
    asked == revision && isOn
  }
}
