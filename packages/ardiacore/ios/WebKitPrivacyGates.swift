import Foundation

final class WebKitHistoryGate: @unchecked Sendable {
  private var generations: [String: Int] = [:]
  private var forgotten = Set<String>()
  private let stamps = NSMapTable<AnyObject, NSNumber>.weakToStrongObjects()

  func generation(_ profile: String) -> Int { generations[profile, default: 0] }

  func advance(_ profile: String) { generations[profile, default: 0] += 1 }

  func forget(_ profile: String) {
    advance(profile)
    forgotten.insert(profile)
  }

  func keepsHistory(_ profile: String) -> Bool { !forgotten.contains(profile) }

  func stamp(_ view: AnyObject, profile: String) {
    guard stamps.object(forKey: view) == nil else { return }
    stamps.setObject(NSNumber(value: generation(profile)), forKey: view)
  }

  func generation(of view: AnyObject) -> Int? { stamps.object(forKey: view)?.intValue }

  func isCurrent(_ generation: Int?, profile: String) -> Bool {
    guard let generation, keepsHistory(profile) else { return false }
    return generation == self.generation(profile)
  }

  func isCurrent(view: AnyObject?, profile: String) -> Bool {
    guard let view else { return false }
    return isCurrent(generation(of: view), profile: profile)
  }
}

enum WebKitNotificationPolicy {
  static func shared(_ decisions: [String: [String: Bool]], origin: String, profiles: Set<String>) -> Bool? {
    let answers = profiles.union(decisions.keys).map { decisions[$0]?[origin] }
    guard answers.contains(where: { $0 != nil }) else { return nil }
    return answers.allSatisfy { $0 == true }
  }
}
