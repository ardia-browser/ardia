import AppKit
import ArdiaCore
import ExpoModulesCore

public class DialogsModule: Module {
  private static var shownOnly: [(window: NSWindow, alert: NSAlert, key: String?)] = []

  public func definition() -> ModuleDefinition {
    Name("ArdiaDialogs")

    Constant("dismissesShownOnly") { true }

    AsyncFunction("confirm") { (options: ConfirmOptions, promise: Promise) in
      if let file = MenuChoice.testFile(flag: "appDialog", name: "dialog.json"),
         let answer = MenuChoice.testAnswer(dumping: options.toDictionary().merging(["kind": "confirm"]) { $1 }, to: file) {
        let words = Set(answer.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
        promise.resolve(["confirmed": words.contains("confirm"), "suppressed": words.contains("suppress")])
        return
      }
      if options.onlyIfShown && (LaunchConfig.shared.background || DialogsModule.visibleWindow(options.windowId) == nil) {
        promise.resolve(["confirmed": false, "suppressed": false, "unshown": true])
        return
      }
      let sheetWindow = DialogsModule.visibleWindow(options.windowId)
      if options.sheetOnly && sheetWindow == nil {
        promise.resolve(["confirmed": false, "suppressed": false, "unavailable": true])
        return
      }
      let alert = DialogsModule.alert(title: options.title, message: options.message)
      alert.addButton(withTitle: options.confirmTitle)
      alert.addButton(withTitle: options.cancelTitle)
      if options.destructive { alert.buttons.first?.hasDestructiveAction = true }
      if let suppression = options.suppression {
        alert.showsSuppressionButton = true
        alert.suppressionButton?.title = suppression
      }
      let answer = { (response: NSApplication.ModalResponse) in
        DialogsModule.shownOnly.removeAll { $0.alert === alert }
        promise.resolve([
          "confirmed": response == .alertFirstButtonReturn,
          "suppressed": alert.suppressionButton?.state == .on,
        ])
      }
      if options.onlyIfShown, let window = DialogsModule.visibleWindow(options.windowId) {
        DialogsModule.shownOnly.append((window, alert, options.dismissKey))
        alert.beginSheetModal(for: window, completionHandler: answer)
        return
      }
      if options.sheetOnly, let sheetWindow {
        alert.beginSheetModal(for: sheetWindow, completionHandler: answer)
        return
      }
      DialogsModule.present(alert, windowId: options.windowId, completion: answer)
    }.runOnQueue(.main)
    AsyncFunction("dismissShownOnly") { (key: String?) in
      for (window, alert, shownKey) in DialogsModule.shownOnly where key == nil || shownKey == key {
        window.endSheet(alert.window, returnCode: .alertSecondButtonReturn)
      }
    }.runOnQueue(.main)
    AsyncFunction("prompt") { (options: PromptOptions, promise: Promise) in
      if let file = MenuChoice.testFile(flag: "appDialog", name: "dialog.json"),
         let answer = MenuChoice.testAnswer(dumping: options.toDictionary().merging(["kind": "prompt"]) { $1 }, to: file) {
        promise.resolve(answer.isEmpty ? nil : answer)
        return
      }
      let alert = DialogsModule.alert(title: options.title, message: options.message)
      alert.addButton(withTitle: options.confirmTitle)
      alert.addButton(withTitle: "Cancel")
      let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
      field.stringValue = options.value
      field.placeholderString = options.placeholder
      alert.accessoryView = field
      alert.window.initialFirstResponder = field
      DialogsModule.present(alert, windowId: options.windowId) { response in
        let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        promise.resolve(response == .alertFirstButtonReturn && !text.isEmpty ? text : nil)
      }
    }.runOnQueue(.main)
    AsyncFunction("pickFiles") { (promise: Promise) in
      let panel = NSOpenPanel()
      panel.allowsMultipleSelection = true
      panel.canChooseDirectories = false
      panel.begin { response in
        promise.resolve(response == .OK ? panel.urls.map(\.absoluteString) : [])
      }
    }.runOnQueue(.main)
    AsyncFunction("pickFolder") { (current: String?, prompt: String?, promise: Promise) in
      let panel = NSOpenPanel()
      panel.canChooseFiles = false
      panel.canChooseDirectories = true
      panel.canCreateDirectories = true
      panel.allowsMultipleSelection = false
      if let prompt { panel.prompt = prompt }
      if let current { panel.directoryURL = URL(fileURLWithPath: current, isDirectory: true) }
      panel.begin { response in promise.resolve(response == .OK ? panel.url?.path : nil) }
    }.runOnQueue(.main)
  }

  static func alert(title: String, message: String) -> NSAlert {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = message
    return alert
  }

  static func visibleWindow(_ windowId: String?) -> NSWindow? {
    guard let window = windowId.flatMap({ WindowManager.shared.window($0) }), window.isVisible, !window.isMiniaturized else { return nil }
    return window
  }

  static func present(_ alert: NSAlert, windowId: String?, completion: @escaping (NSApplication.ModalResponse) -> Void) {
    if let window = visibleWindow(windowId) {
      alert.beginSheetModal(for: window, completionHandler: completion)
    } else {
      completion(alert.runModal())
    }
  }
}
