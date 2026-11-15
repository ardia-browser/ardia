import Foundation

enum IconStyle {
  static let defaultsKey = "AppleIconAppearanceTheme"

  static func restylesIcons(theme: String?) -> Bool {
    guard let theme else { return false }
    return theme.hasPrefix("Tinted") || theme.hasPrefix("Clear")
  }

  static let devBundleIcon = "AppIcon-Dev"

  static func shown(saved: String, theme: String?, bundleIcon: String? = nil) -> String {
    bundleIcon == devBundleIcon || restylesIcons(theme: theme) ? "default" : saved
  }

  static var bundleIcon: String? { Bundle.main.object(forInfoDictionaryKey: "CFBundleIconName") as? String }

  static var systemTheme: String? { UserDefaults.standard.string(forKey: defaultsKey) }
}

final class IconStyleWatcher: NSObject {
  private let defaults: UserDefaults
  private let onChange: () -> Void

  init(_ defaults: UserDefaults = .standard, onChange: @escaping () -> Void) {
    self.defaults = defaults
    self.onChange = onChange
    super.init()
    defaults.addObserver(self, forKeyPath: IconStyle.defaultsKey, options: [], context: nil)
  }

  deinit {
    defaults.removeObserver(self, forKeyPath: IconStyle.defaultsKey)
  }

  override func observeValue(forKeyPath keyPath: String?, of object: Any?, change: [NSKeyValueChangeKey: Any]?, context: UnsafeMutableRawPointer?) {
    DispatchQueue.main.async { [weak self] in self?.onChange() }
  }
}
