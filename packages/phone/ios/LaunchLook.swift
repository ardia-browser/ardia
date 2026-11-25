import ArdiaDesign
import Foundation

struct LaunchThemeLook: Equatable {
  var look: ThemeLook
  var dark: Bool
}

enum LaunchLook {
  static let key = "ardia.phone.launchLook"
  static let themeLooksKey = "themeLooks"
  static let lightSlot = "light"
  static let darkSlot = "dark"

  struct Recalled: Equatable {
    var colors = LookColors()
    var lightThemeLook: LaunchThemeLook?
    var darkThemeLook: LaunchThemeLook?

    func drawn(appDark: Bool) -> (colors: LookColors, dark: Bool?) {
      guard let theme = appDark ? (darkThemeLook ?? lightThemeLook) : (lightThemeLook ?? darkThemeLook) else {
        return (colors, nil)
      }
      var colors = colors
      colors.themeLook = theme.look
      return (colors, theme.dark)
    }
  }

  static func remember(_ colors: LookColors, drawnDark: Bool, appDark: Bool, in defaults: UserDefaults = .standard) {
    guard !colors.isIncognito else { return }
    let previous = recalled(from: defaults)
    var base = colors.withoutThemeLook
    base.themeColors = base.themeColors ?? []
    var next = previous.colors == base ? previous : Recalled(colors: base)
    if let look = colors.themeLook {
      let theme = LaunchThemeLook(look: look, dark: drawnDark)
      if appDark { next.darkThemeLook = theme } else { next.lightThemeLook = theme }
    } else {
      next.lightThemeLook = nil
      next.darkThemeLook = nil
    }
    guard next != previous || defaults.object(forKey: key) == nil else { return }
    defaults.set(saved(next), forKey: key)
  }

  static func saved(_ recalled: Recalled) -> [String: Any] {
    let colors = recalled.colors
    var saved: [String: Any] = ["themeColors": colors.themeColors ?? []]
    if let color = colors.color { saved["color"] = color }
    if let darkThemeColors = colors.darkThemeColors { saved["darkThemeColors"] = darkThemeColors }
    var themeLooks: [String: Any] = [:]
    if let light = recalled.lightThemeLook { themeLooks[lightSlot] = slot(light) }
    if let dark = recalled.darkThemeLook { themeLooks[darkSlot] = slot(dark) }
    if !themeLooks.isEmpty { saved[themeLooksKey] = themeLooks }
    return saved
  }

  static func recalled(from defaults: UserDefaults = .standard) -> Recalled {
    let saved = defaults.dictionary(forKey: key) ?? [:]
    let colors = LookColors(color: saved["color"] as? String, themeColors: saved["themeColors"] as? [String], darkThemeColors: saved["darkThemeColors"] as? [String])
    let themeLooks = saved[themeLooksKey] as? [String: Any] ?? [:]
    return Recalled(colors: colors, lightThemeLook: theme(themeLooks[lightSlot]), darkThemeLook: theme(themeLooks[darkSlot]))
  }

  private static func slot(_ theme: LaunchThemeLook) -> [String: Any] {
    ["look": theme.look.dictionary, "dark": theme.dark]
  }

  private static func theme(_ value: Any?) -> LaunchThemeLook? {
    guard let slot = value as? [String: Any], let look = ThemeLook(sanitizing: slot["look"]) else { return nil }
    return LaunchThemeLook(look: look, dark: slot["dark"] as? Bool ?? false)
  }
}
