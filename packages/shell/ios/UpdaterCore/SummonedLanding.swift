import Foundation

enum SummonedLanding {
  struct Listed: Equatable {
    let number: Int
    let owner: Int32
    let layer: Int
  }

  static func needsRaise(own: Int32, frontmost: Int32?) -> Bool {
    guard let frontmost else { return false }
    return frontmost != own
  }

  static func inFront(_ number: Int, own: Int32, frontmost: Int32?, frontToBack list: [Listed]) -> Bool {
    guard let ours = list.first(where: { $0.number == number && $0.owner == own }) else { return false }
    for listed in list where listed.layer == ours.layer {
      if listed.number == number && listed.owner == own { return true }
      if needsRaise(own: own, frontmost: frontmost), listed.owner == frontmost { return false }
    }
    return false
  }
}
