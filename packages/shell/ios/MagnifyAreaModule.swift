import AppKit
import Carbon.HIToolbox
import ExpoModulesCore

public class MagnifyAreaModule: Module, MagnifyAreaNative {
  static func devMagnify(_ windowId: String, _ x: Double, _ y: Double, _ steps: [[String: Any]]) -> [String: Any] {
    #if DEBUG
    return MagnifyArea.devMagnify(windowId: windowId, x: x, y: y, steps: steps)
    #else
    return ["error": "DEV builds only"]
    #endif
  }

  public func definition() -> ModuleDefinition {
    Name(Self.moduleName)

    Self.devMagnifyFunction

    View(MagnifyArea.self) {
      Prop("enabled") { (view: MagnifyArea, on: Bool) in view.enabled = on }
      Events("onMagnify")
    }
  }
}
