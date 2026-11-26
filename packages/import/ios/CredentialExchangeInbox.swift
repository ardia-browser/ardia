import AppKit
import ArdiaCore
import AuthenticationServices
import Foundation

public final class CredentialExchangeInbox: @unchecked Sendable {
  enum Delivery {
    case token(UUID)
    case fixture(Data)
  }

  public static let shared = CredentialExchangeInbox()
  static let arrived = Notification.Name("ArdiaCredentialExchangeArrived")
  static let extensionName = "ArdiaCredentials.appex"

  private let lock = NSLock()
  private var waiting: [Delivery] = []

  public static func handles(activityType: String) -> Bool {
    guard #available(macOS 26, *) else { return false }
    return activityType == ASCredentialExchangeActivity
  }

  public static func receive(_ activity: NSUserActivity) -> Bool {
    guard handles(activityType: activity.activityType), #available(macOS 26, *) else { return false }
    let value = activity.userInfo?[ASCredentialImportToken]
    guard let token = (value as? UUID) ?? (value as? String).flatMap(UUID.init(uuidString:)) else { return false }
    shared.deliver(.token(token))
    return true
  }

  static var fixturePath: String? { LaunchConfig.shared.testValue("credentialExchangeFixture") }

  static var extensionShipped: Bool {
    guard let plugins = Bundle.main.builtInPlugInsURL else { return false }
    return FileManager.default.fileExists(atPath: plugins.appendingPathComponent(extensionName).path)
  }

  func deliver(_ delivery: Delivery) {
    lock.withLock { waiting.append(delivery) }
    NotificationCenter.default.post(name: Self.arrived, object: nil)
  }

  var pending: Int { lock.withLock { waiting.count } }

  func take() -> Delivery? {
    lock.withLock { waiting.isEmpty ? nil : waiting.removeFirst() }
  }
}
