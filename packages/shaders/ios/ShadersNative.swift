import ExpoModulesCore

protocol AreaLightNative {
  static func debugSnapshot(_ dir: String) -> [[String: Any]]
}

extension AreaLightNative {
  static var moduleName: String { "ArdiaAreaLight" }

  static var debugSnapshotFunction: AnyDefinition {
    AsyncFunction("debugSnapshot") { (dir: String) -> [[String: Any]] in Self.debugSnapshot(dir) }.runOnQueue(.main)
  }
}

protocol WindowBackdropNative {
  static func holdKeyLook(_ on: Bool)
}

extension WindowBackdropNative {
  static var moduleName: String { "ArdiaWindowBackdrop" }

  static var holdKeyLookFunction: AnyDefinition {
    AsyncFunction("holdKeyLook") { (on: Bool) in Self.holdKeyLook(on) }.runOnQueue(.main)
  }
}

protocol MeadowNative {
  static func debugState() -> [String: Any]
  static func debugEval(_ script: String, _ promise: Promise)
}

extension MeadowNative {
  static var moduleName: String { "ArdiaMeadow" }

  static var debugStateFunction: AnyDefinition {
    AsyncFunction("debugState") { () -> [String: Any] in Self.debugState() }.runOnQueue(.main)
  }

  static var debugEvalFunction: AnyDefinition {
    AsyncFunction("debugEval") { (script: String, promise: Promise) in Self.debugEval(script, promise) }.runOnQueue(.main)
  }
}
