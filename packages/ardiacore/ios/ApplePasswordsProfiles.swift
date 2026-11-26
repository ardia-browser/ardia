import Foundation

@objc(ApplePasswordsProfiles)
final class ApplePasswordsProfiles: NSObject {
  private static let lock = NSLock()
  private static var names: Set<String> = []

  static func set(_ profiles: [String]) {
    let chosen = Set(profiles.map { ArdiaHost.baseProfile(of: $0) })
    lock.withLock { names = chosen }
  }

  @objc(containsProfile:)
  static func contains(_ profile: String) -> Bool {
    let name = ArdiaHost.baseProfile(of: profile)
    return lock.withLock { names.contains(name) }
  }
}
