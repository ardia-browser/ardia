import Foundation

public enum PhoneTestBuild {
  public static let isOn = (Bundle.main.object(forInfoDictionaryKey: "ArdiaTestBuild") as? String)?.uppercased() == "YES"

  public static func flag(_ key: String) -> Bool {
    isOn && UserDefaults.standard.bool(forKey: key)
  }

  static let argumentPrefixes = ["Ardia", "Browse"]

  public static var isDemo: Bool { flag("ArdiaDemo") || flag("ArdiaSyncDemo") }

  public static var launchArguments: [String: Any] {
    arguments(UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain), allowed: isOn)
  }

  static func arguments(_ domain: [String: Any], allowed: Bool) -> [String: Any] {
    guard allowed else { return [:] }
    var passed: [String: Any] = [:]
    for (key, value) in domain where argumentPrefixes.contains(where: key.hasPrefix) {
      if let converted = argumentValue(value) { passed[key] = converted }
    }
    return passed
  }

  static func argumentValue(_ value: Any) -> Any? {
    switch value {
    case let number as NSNumber:
      return CFGetTypeID(number) == CFBooleanGetTypeID() ? number.boolValue : number.doubleValue
    case let text as String:
      switch text.lowercased() {
      case "yes", "true": return true
      case "no", "false": return false
      default: return text
      }
    default:
      return nil
    }
  }
}

func onMain(_ work: @escaping @MainActor () -> Void) {
  if Thread.isMainThread {
    MainActor.assumeIsolated(work)
  } else {
    DispatchQueue.main.async { MainActor.assumeIsolated(work) }
  }
}
