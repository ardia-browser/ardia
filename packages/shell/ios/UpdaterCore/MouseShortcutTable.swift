import Foundation

struct MouseShortcutTable {
  static let buttonKeys: [Int: String] = [2: "mouse:middle", 3: "mouse:4", 4: "mouse:5"]
  static let telemetryNames: [Int: String] = [2: "middle", 3: "button4", 4: "button5"]
  static let modifierFlags: [String: UInt] = ["shift": 1 << 17, "control": 1 << 18, "option": 1 << 19, "command": 1 << 20]
  static let modifierMask: UInt = modifierFlags.values.reduce(0, |)

  private var commands: [Int: String] = [:]

  init(_ bindings: [String: [String]] = [:]) {
    let buttons = Dictionary(uniqueKeysWithValues: Self.buttonKeys.map { ($1, $0) })
    for (id, stored) in bindings {
      guard let key = stored.first, let button = buttons[key] else { continue }
      let flags = stored.dropFirst().reduce(UInt(0)) { $0 | (Self.modifierFlags[$1] ?? 0) }
      commands[Self.slot(button: button, modifierFlags: flags)] = id
    }
  }

  var isEmpty: Bool { commands.isEmpty }

  func command(button: Int, modifierFlags: UInt) -> String? {
    guard Self.buttonKeys[button] != nil else { return nil }
    return commands[Self.slot(button: button, modifierFlags: modifierFlags)]
  }

  static func modifierNames(_ modifierFlags: UInt) -> [String] {
    ["control", "option", "shift", "command"].filter { modifierFlags & (Self.modifierFlags[$0] ?? 0) != 0 }
  }

  private static func slot(button: Int, modifierFlags: UInt) -> Int {
    button << 24 | Int((modifierFlags & modifierMask) >> 16)
  }
}
