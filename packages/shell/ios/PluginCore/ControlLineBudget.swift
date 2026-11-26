import Foundation

struct ControlLineBudget: Equatable {
  enum Mode: Equatable {
    case requests
    case messages
  }

  let mode: Mode
  let limit: Int
  private(set) var pending = 0

  init(mode: Mode, limit: Int) {
    self.mode = mode
    self.limit = limit
  }

  mutating func received() -> Bool {
    guard mode == .requests else { return true }
    pending += 1
    return pending <= limit
  }

  mutating func answered() {
    guard mode == .requests else { return }
    pending = max(0, pending - 1)
  }

  var settled: Bool { pending == 0 }
}
