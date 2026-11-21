import Foundation

enum LaunchLook {
  static let key = "ardia.phone.launchLook"

  @MainActor private static var remembered: LookColors?

  @MainActor
  static func remember(_ colors: LookColors, in defaults: UserDefaults = .standard) {
    guard !colors.isIncognito, colors != remembered else { return }
    remembered = colors
    defaults.set(saved(colors), forKey: key)
  }

  static func saved(_ colors: LookColors) -> [String: Any] {
    var saved: [String: Any] = ["themeColors": colors.themeColors ?? []]
    if let color = colors.color { saved["color"] = color }
    if let darkThemeColors = colors.darkThemeColors { saved["darkThemeColors"] = darkThemeColors }
    return saved
  }

  static func recalled(from defaults: UserDefaults = .standard) -> LookColors {
    let saved = defaults.dictionary(forKey: key) ?? [:]
    return LookColors(color: saved["color"] as? String, themeColors: saved["themeColors"] as? [String], darkThemeColors: saved["darkThemeColors"] as? [String])
  }
}
