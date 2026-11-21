import AppKit

@main
enum KeyEquivalentMatchTest {
  static var failures = 0

  static func check(_ ok: Bool, _ what: String) {
    if !ok {
      print("FAIL \(what)")
      failures += 1
    }
  }

  static func main() {
    let m: (String, NSEvent.ModifierFlags, String, String, NSEvent.ModifierFlags) -> Bool = { KeyEquivalentMatch.matches(key: $0, mask: $1, typed: $2, unshifted: $3, pressed: $4) }
    check(m("q", [.command], "q", "q", [.command]), "⌘Q")
    check(!m("q", [.command], "Q", "q", [.command, .shift]), "⌘Q is not ⇧⌘Q")
    check(m("Q", [.command], "Q", "q", [.command, .shift]), "an uppercase key equivalent means Shift")
    check(!m("Q", [.command], "q", "q", [.command]), "⇧⌘Q is not ⌘Q")
    check(m("Q", [.command, .shift], "Q", "q", [.command, .shift]), "uppercase with Shift in the mask too")
    check(m("q", [.command, .shift], "Q", "q", [.command, .shift]), "lowercase with Shift in the mask")
    check(m(",", [.command], ",", ",", [.command]), "⌘,")
    check(!m(",", [.command], "<", ",", [.command, .shift]), "⌘, is not ⇧⌘,")
    check(m(",", [.command, .shift], "<", ",", [.command, .shift]), "⇧⌘, by its unshifted key")
    check(m("<", [.command], "<", ",", [.command, .shift]), "a shifted symbol as the key equivalent")
    check(!m("<", [.command], ",", ",", [.command]), "the shifted symbol needs Shift")
    check(m("q", [.command, .option], "q", "q", [.command, .option]), "⌥⌘Q")
    check(!m("q", [.command, .option], "q", "q", [.command]), "⌥⌘Q is not ⌘Q")
    check(!m("q", [.command], "q", "q", [.command, .control]), "⌃⌘Q is not ⌘Q")
    check(m("q", [.command], "q", "q", [.command, .capsLock, .function, .numericPad]), "locks and device flags do not count")
    check(!m("", [.command], "", "", [.command]), "no key equivalent matches nothing")
    check(!m("q", [.command], "", "", [.command]), "an event with no characters matches nothing")
    let menuKey = { (key: String, mods: NSEvent.ModifierFlags) -> (String, NSEvent.ModifierFlags) in
      guard mods.contains(.shift), key.count == 1, let scalar = key.unicodeScalars.first, ("a"..."z").contains(scalar) else { return (key, mods) }
      return (key.uppercased(), mods.subtracting(.shift))
    }
    let rebound = menuKey("q", [.command, .shift])
    check(rebound.0 == "Q" && rebound.1 == [.command], "the menu drops Shift into the letter's case")
    check(m(rebound.0, rebound.1, "Q", "q", [.command, .shift]), "Quit rebound to ⇧⌘Q runs on ⇧⌘Q")
    check(!m(rebound.0, rebound.1, "q", "q", [.command]), "and no longer on ⌘Q")
    exit(failures == 0 ? 0 : 1)
  }
}
