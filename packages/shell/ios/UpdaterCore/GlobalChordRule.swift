import Foundation

enum GlobalChordRule {
  static let command: UInt32 = 0x0100
  static let shift: UInt32 = 0x0200
  static let option: UInt32 = 0x0800
  static let control: UInt32 = 0x1000

  static func isFunctionKey(_ key: String) -> Bool {
    guard key.unicodeScalars.count == 1, let scalar = key.unicodeScalars.first else { return false }
    return (0xF704...0xF726).contains(scalar.value)
  }

  static func modifiers(command: Bool, option: Bool, control: Bool, shift: Bool) -> UInt32 {
    (command ? Self.command : 0) | (option ? Self.option : 0) | (control ? Self.control : 0) | (shift ? Self.shift : 0)
  }

  static func registrable(key: String, modifiers: UInt32, function: Bool = false) -> Bool {
    if function, !isFunctionKey(key) { return false }
    return modifiers & (command | control) != 0 || isFunctionKey(key)
  }
}
