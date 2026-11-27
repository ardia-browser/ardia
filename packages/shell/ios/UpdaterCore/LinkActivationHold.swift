import CoreGraphics

enum LinkActivationHold {
  struct Listed: Equatable {
    let number: Int
    let owner: Int32
    let layer: Int
    var windowServer = false
  }

  static let overlayLayer = Int(CGWindowLevelForKey(.draggingWindow))

  static func underPointer(
    frontToBack list: [Listed], refresh: () -> [Listed] = { [] }, clickedBelow: (Int) -> Int
  ) -> Listed? {
    resolve(frontToBack: list, refresh: refresh, clickedBelow: clickedBelow).hit
  }

  static func leftToWindowManager(
    own: Int32, windowManagers: Set<Int32>, frontToBack list: [Listed], refresh: () -> [Listed] = { [] }, clickedBelow: (Int) -> Int
  ) -> Bool {
    guard !list.isEmpty else { return true }
    let resolved = resolve(frontToBack: list, refresh: refresh, clickedBelow: clickedBelow)
    guard let hit = resolved.hit else { return false }
    if windowManagers.contains(hit.owner) { return true }
    return hit.owner == own && resolved.list.first { $0.layer == 0 } == hit
  }

  private static func resolve(
    frontToBack list: [Listed], refresh: () -> [Listed], clickedBelow: (Int) -> Int
  ) -> (hit: Listed?, list: [Listed]) {
    var current = list
    var refreshed = false
    var below = 0
    var seen: Set<Int> = []
    while true {
      let number = clickedBelow(below)
      guard number > 0, seen.insert(number).inserted else { return (nil, current) }
      var hit = current.first { $0.number == number }
      if hit == nil, !refreshed {
        refreshed = true
        let updated = refresh()
        if !updated.isEmpty {
          current = updated
          hit = current.first { $0.number == number }
        }
      }
      guard let hit else { return (nil, current) }
      if !hit.windowServer && (0..<overlayLayer).contains(hit.layer) { return (hit, current) }
      below = number
    }
  }
}
