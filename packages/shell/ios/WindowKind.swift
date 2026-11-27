import ExpoModulesCore

enum WindowKind: String, Enumerable {
  case browser
  case small
  case settings
  case `import`
  case intro

  var isBrowser: Bool { self == .browser || self == .small }
}
