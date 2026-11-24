import AppKit

enum KeyEquivalentMatch {
  static let held: NSEvent.ModifierFlags = [.command, .shift, .option, .control]

  static func normalized(key: String, mask: NSEvent.ModifierFlags) -> (key: String, mods: NSEvent.ModifierFlags) {
    let mods = mask.intersection(held)
    guard key.count == 1, key != key.lowercased() else { return (key, mods) }
    return (key.lowercased(), mods.union(.shift))
  }

  static func matches(key: String, mask: NSEvent.ModifierFlags, typed: String, unshifted: String, pressed: NSEvent.ModifierFlags) -> Bool {
    let wanted = normalized(key: key, mask: mask)
    let pressed = pressed.intersection(held)
    guard !wanted.key.isEmpty, !typed.isEmpty else { return false }
    if wanted.mods == pressed, wanted.key == typed.lowercased() || wanted.key == unshifted.lowercased() { return true }
    let shiftedSymbol = typed != unshifted && typed.lowercased() == typed.uppercased()
    return shiftedSymbol && wanted.key == typed && wanted.mods.union(.shift) == pressed
  }

  static func matches(_ item: NSMenuItem, _ event: NSEvent) -> Bool {
    let typed = event.charactersIgnoringModifiers ?? ""
    let unshifted = event.characters(byApplyingModifiers: event.modifierFlags.intersection(.command)) ?? typed
    return matches(key: item.keyEquivalent, mask: item.keyEquivalentModifierMask, typed: typed, unshifted: unshifted, pressed: event.modifierFlags)
  }
}
