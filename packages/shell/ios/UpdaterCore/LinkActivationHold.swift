import CoreGraphics

enum LinkActivationHold {
  struct Listed: Equatable {
    let number: Int
    let owner: Int32
    let layer: Int
    let bounds: CGRect
    var windowServer = false
  }

  static let overlayLayer = Int(CGWindowLevelForKey(.draggingWindow))

  static func underPointer(_ pointer: CGPoint, frontToBack list: [Listed]) -> Listed? {
    list.first { !$0.windowServer && (0..<overlayLayer).contains($0.layer) && $0.bounds.contains(pointer) }
  }

  static func leftToWindowManager(pointer: CGPoint?, own: Int32, windowManagers: Set<Int32>, frontToBack list: [Listed]) -> Bool {
    guard let pointer, !list.isEmpty else { return true }
    guard let hit = underPointer(pointer, frontToBack: list) else { return false }
    if windowManagers.contains(hit.owner) { return true }
    return hit.owner == own && list.first { $0.layer == 0 } == hit
  }
}
