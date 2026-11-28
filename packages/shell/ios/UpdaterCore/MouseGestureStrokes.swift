import Foundation

struct MouseGestureStrokes {
  enum Direction: Hashable { case left, right, up, down }

  struct Action: Equatable {
    let command: String
    let title: String
    let telemetry: String
  }

  static let stepDistance = 24.0
  static let maxStrokes = 2

  static let actions: [[Direction]: Action] = [
    [.left]: Action(command: "back", title: "Back", telemetry: "back"),
    [.right]: Action(command: "forward", title: "Forward", telemetry: "forward"),
    [.up, .down]: Action(command: "reload", title: "Reload", telemetry: "reload"),
    [.down, .right]: Action(command: "closeTab", title: "Close Tab", telemetry: "close_tab"),
    [.left, .up]: Action(command: "reopenClosedTab", title: "Reopen Closed Tab", telemetry: "reopen_closed_tab"),
    [.right, .up]: Action(command: "newTab", title: "New Tab", telemetry: "new_tab"),
    [.up, .left]: Action(command: "previousTab", title: "Previous Tab", telemetry: "previous_tab"),
    [.up, .right]: Action(command: "nextTab", title: "Next Tab", telemetry: "next_tab"),
  ]

  private(set) var points: [CGPoint]
  private(set) var directions: [Direction] = []
  private var anchor: CGPoint

  init(start: CGPoint) {
    points = [start]
    anchor = start
  }

  var isGesture: Bool { !directions.isEmpty }

  var action: Action? { directions.count <= Self.maxStrokes ? Self.actions[directions] : nil }

  @discardableResult
  mutating func add(_ point: CGPoint) -> Bool {
    guard point != points.last else { return false }
    points.append(point)
    let dx = Double(point.x - anchor.x), dy = Double(point.y - anchor.y)
    guard max(abs(dx), abs(dy)) >= Self.stepDistance else { return true }
    anchor = point
    let direction: Direction = abs(dx) >= abs(dy) ? (dx < 0 ? .left : .right) : (dy > 0 ? .up : .down)
    if directions.last != direction { directions.append(direction) }
    return true
  }
}
