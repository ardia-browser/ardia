import AppKit
import ExpoModulesCore
import UniformTypeIdentifiers
import ServiceManagement

public class FileDropModule: Module, FileDropNative {
  static func devDrag(_ windowId: String, _ action: String, _ x: Double, _ y: Double, _ payload: [String: Any]?) -> String {
    #if DEBUG
    return DevDragSession.act(windowId: windowId, action: action, x: x, y: y, payload: payload ?? [:])
    #else
    return "debug builds only"
    #endif
  }

  static func devLastFileDrag() -> [String] {
    #if DEBUG
    return FileDropView.lastFileDrag.map(\.path)
    #else
    return []
    #endif
  }

  public func definition() -> ModuleDefinition {
    Name(Self.moduleName)

    View(FileDropView.self) {
      Events("onDropUpdate")
      Prop("accepts") { (view: FileDropView, accepts: String?) in
        view.accepts = accepts ?? "links"
      }
      Prop("enabled") { (view: FileDropView, enabled: Bool?) in
        view.enabled = enabled ?? true
      }
    }

    Self.devDragFunction

    Self.devLastFileDragFunction
  }
}
