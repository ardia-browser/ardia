import Foundation

struct KeyEpochs {
  private var epochs: [Int: Int] = [:]
  private var lastKey: Int?
  private var handedBack: Int?

  func epoch(of window: Int) -> Int { epochs[window] ?? 0 }

  mutating func becameKey(_ window: Int) {
    if let lastKey, lastKey != window { epochs[window, default: 0] += 1 }
    handedBack = lastKey == window ? window : nil
    lastKey = window
  }

  mutating func takeHandback(of window: Int) -> Bool {
    guard handedBack == window else { return false }
    handedBack = nil
    return true
  }
}
