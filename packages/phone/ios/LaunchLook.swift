import ArdiaDesign
import Foundation

struct LaunchSlot: Equatable {
  var look: ThemeLook?
  var dark: Bool
}

enum LaunchLook {
  static let key = "ardia.phone.launchLook"
  static let themeLooksKey = "themeLooks"
  static let lightSlot = "light"
  static let darkSlot = "dark"

  struct Recalled: Equatable {
    var colors = LookColors()
    var light: LaunchSlot?
    var dark: LaunchSlot?

    func drawn(appDark: Bool) -> (colors: LookColors, dark: Bool?) {
      guard let slot = appDark ? (dark ?? light) : (light ?? dark) else {
        return (colors, nil)
      }
      var colors = colors
      colors.themeLook = slot.look
      return (colors, slot.dark)
    }

    func drawsTheSameSpace(as other: Recalled) -> Bool {
      [false, true].allSatisfy { appDark in
        let mine = drawn(appDark: appDark)
        let theirs = other.drawn(appDark: appDark)
        return mine.colors.withoutThemeLook == theirs.colors.withoutThemeLook
          && (mine.colors.themeLook == nil) == (theirs.colors.themeLook == nil)
          && (mine.dark ?? appDark) == (theirs.dark ?? appDark)
      }
    }
  }

  @discardableResult
  static func remember(_ next: Recalled, in defaults: UserDefaults = .standard) -> Bool {
    guard !next.colors.isIncognito else { return false }
    let stored = recalled(saved: saved(next))
    guard stored != recalled(from: defaults) || defaults.object(forKey: key) == nil else { return false }
    defaults.set(saved(stored), forKey: key)
    return true
  }

  static func saved(_ recalled: Recalled) -> [String: Any] {
    let colors = recalled.colors
    var saved: [String: Any] = ["themeColors": colors.themeColors ?? []]
    if let color = colors.color { saved["color"] = color }
    if let darkThemeColors = colors.darkThemeColors { saved["darkThemeColors"] = darkThemeColors }
    var themeLooks: [String: Any] = [:]
    if let light = recalled.light { themeLooks[lightSlot] = slot(light) }
    if let dark = recalled.dark { themeLooks[darkSlot] = slot(dark) }
    if !themeLooks.isEmpty { saved[themeLooksKey] = themeLooks }
    return saved
  }

  static func recalled(saved: [String: Any]) -> Recalled {
    let colors = LookColors(color: saved["color"] as? String, themeColors: saved["themeColors"] as? [String], darkThemeColors: saved["darkThemeColors"] as? [String])
    let themeLooks = saved[themeLooksKey] as? [String: Any] ?? [:]
    return Recalled(colors: colors, light: slot(themeLooks[lightSlot]), dark: slot(themeLooks[darkSlot]))
  }

  static func recalled(from defaults: UserDefaults = .standard) -> Recalled {
    recalled(saved: defaults.dictionary(forKey: key) ?? [:])
  }

  private static func slot(_ slot: LaunchSlot) -> [String: Any] {
    var saved: [String: Any] = ["dark": slot.dark]
    if let look = slot.look { saved["look"] = look.dictionary }
    return saved
  }

  private static func slot(_ value: Any?) -> LaunchSlot? {
    guard let slot = value as? [String: Any], let dark = slot["dark"] as? Bool else { return nil }
    return LaunchSlot(look: ThemeLook(sanitizing: slot["look"]), dark: dark)
  }
}
