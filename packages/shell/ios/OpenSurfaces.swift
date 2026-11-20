import AppKit
import ArdiaCore

final class OpenSurfaces: NSObject {
  static let shared = OpenSurfaces()
  static let capturedLifetime: TimeInterval = 60

  enum Problem: Error {
    case missing(String)
    case refused(String)
  }

  private struct Captured {
    let link: String
    let items: [Any]
  }

  private final class Tracked {
    let id: String
    let kind: String
    let captured: Captured
    let tab: String?
    let window: String?
    let openedAt = Date()
    init(id: String, kind: String, captured: Captured, tab: String?, window: String?) {
      self.id = id
      self.kind = kind
      self.captured = captured
      self.tab = tab
      self.window = window
    }
    var expired: Bool { Date().timeIntervalSince(openedAt) > OpenSurfaces.capturedLifetime }
  }

  var send: ((String, [String: Any]) -> Void)?
  var capturesPageMenus = false {
    didSet { if !capturesPageMenus { dropCaptured { _ in true } } }
  }
  private var open: [Tracked] = []
  private var next = 0
  private var observers: [NSObjectProtocol] = []

  func start() {
    guard observers.isEmpty else { return }
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: Notification.Name("ArdiaPageMenuCaptured"), object: nil, queue: nil) { [weak self] in
        self?.captured($0.object as? [String: Any])
      },
    ]
  }

  private func newId(_ prefix: String) -> String {
    next += 1
    return "\(prefix)\(next)"
  }

  private func dropCaptured(_ matching: (Tracked) -> Bool) {
    let dropped = open.filter(matching)
    open.removeAll { tracked in dropped.contains { $0 === tracked } }
    for tracked in dropped { send?("menuDropped", ["id": tracked.id, "kind": tracked.kind]) }
  }

  private func captured(_ box: [String: Any]?) {
    guard let box, capturesPageMenus, let tab = box["tab"] as? String, let window = WindowManager.shared.id(of: box["window"] as? NSWindow) else { return }
    dropCaptured { _ in true }
    let menu = Captured(link: box["link"] as? String ?? "", items: box["items"] as? [Any] ?? [])
    let tracked = Tracked(id: newId("m"), kind: "page", captured: menu, tab: tab, window: window)
    open.append(tracked)
    send?("menuOpened", describe(tracked))
  }

  static func ref(of item: NSMenuItem) -> String {
    var titles: [String] = []
    var current: NSMenuItem? = item
    while let entry = current {
      titles.insert(staticTitle(entry), at: 0)
      current = entry.parent
    }
    let identity: String
    if let command = item as? CommandItem {
      identity = "cmd:" + (command.arg.map { "\(command.command):\($0)" } ?? command.command)
    } else if let action = item.action {
      identity = "sel:" + NSStringFromSelector(action)
    } else {
      identity = "none"
    }
    return identity + "@" + titles.joined(separator: "\u{1F}")
  }

  static func staticTitle(_ item: NSMenuItem) -> String {
    (item as? CommandItem)?.defaultTitle ?? (item as? StandardItem)?.defaultTitle ?? item.title
  }

  private static func capturedRows(_ items: [Any], path: [Int]) -> [[String: Any]] {
    items.enumerated().compactMap { index, raw in
      guard let item = raw as? [String: Any], item["hidden"] as? Bool != true else { return nil }
      var row: [String: Any] = [
        "path": path + [index], "title": item["title"] ?? "", "enabled": item["enabled"] ?? false, "checked": item["checked"] ?? false,
        "separator": item["separator"] ?? false, "command": item["id"] ?? 0,
      ]
      if let submenu = item["submenu"] as? [Any] { row["submenu"] = capturedRows(submenu, path: path + [index]) }
      return row
    }
  }

  private func describe(_ tracked: Tracked) -> [String: Any] {
    var out: [String: Any] = ["id": tracked.id, "kind": tracked.kind, "openedAt": tracked.openedAt.timeIntervalSince1970 * 1000]
    if let tab = tracked.tab { out["tab"] = tab }
    if let window = tracked.window { out["window"] = window }
    out["items"] = Self.capturedRows(tracked.captured.items, path: [])
    out["link"] = tracked.captured.link
    out["captured"] = true
    return out
  }

  func list() -> [[String: Any]] {
    dropCaptured { $0.expired }
    return open.map(describe)
  }

  private func find(_ id: String) throws -> Tracked {
    dropCaptured { $0.expired }
    guard let tracked = open.first(where: { $0.id == id }) else { throw Problem.missing("There's no open menu with that id; menus.open lists them.") }
    return tracked
  }

  static let nativeItemsNeedVisible =
    "A background Ardia runs no native menu item (Minimize, Zoom and the like), and run refuses every command there, so menus.runBar runs nothing in it."
  static let privateWindowOpen = "A private window is open, so the ardia command doesn't use the menu bar until it closes."

  func dismiss(_ id: String) throws {
    let tracked = try find(id)
    dropCaptured { $0 === tracked }
  }
}

enum MenuCatalog {
  enum Target { case none, menuTarget, other }

  private(set) static var rows: [[String: Any]] = []
  private static var actions: [String: (action: Selector, title: String, target: Target)] = [:]

  static func capture(_ main: NSMenu, dynamic: [NSMenu], growing: [NSMenu]) {
    actions = [:]
    rows = describe(main, path: [], dynamic: Set(dynamic.map(ObjectIdentifier.init)), growing: Set(growing.map(ObjectIdentifier.init)))
  }

  static func action(_ ref: String) -> (action: Selector, title: String, target: Target)? { actions[ref] }

  private static func representsWindow(_ item: NSMenuItem) -> Bool {
    item.target is NSWindow || item.representedObject is NSWindow
  }

  private static func describe(_ menu: NSMenu, path: [Int], dynamic: Set<ObjectIdentifier>, growing: Set<ObjectIdentifier>) -> [[String: Any]] {
    var out: [[String: Any]] = []
    for (index, item) in menu.items.enumerated() where !item.isHidden && !representsWindow(item) {
      let here = path + [index]
      if item.isSeparatorItem {
        out.append(["path": here, "title": "", "separator": true, "ref": "separator@" + here.map(String.init).joined(separator: ".")])
        continue
      }
      let title = OpenSurfaces.staticTitle(item)
      var row: [String: Any] = ["path": here, "title": title, "separator": false, "ref": OpenSurfaces.ref(of: item)]
      if let submenu = item.submenu {
        if dynamic.contains(ObjectIdentifier(submenu)) {
          row["dynamic"] = true
          row["ref"] = "dynamic@" + (row["ref"] as? String ?? title)
        } else {
          var children = describe(submenu, path: here, dynamic: dynamic, growing: growing)
          if growing.contains(ObjectIdentifier(submenu)) {
            children.append(["path": here + [submenu.numberOfItems], "title": title, "separator": false, "dynamic": true, "ref": "dynamic@list@\(title)"])
          }
          row["submenu"] = children
        }
      } else {
        if !item.keyEquivalent.isEmpty { row["key"] = item.keyEquivalent }
        if let command = item as? CommandItem {
          row["command"] = command.command
          if let arg = command.arg { row["arg"] = arg }
        } else if let action = item.action {
          row["action"] = NSStringFromSelector(action)
          let target: Target = item.target == nil ? .none : item.target === MenuTarget.shared ? .menuTarget : .other
          actions[OpenSurfaces.ref(of: item)] = (action, title, target)
        }
      }
      out.append(row)
    }
    return out
  }
}

enum MenuBarAction {
  static let allowedActions: Set<String> = [
    "undo:", "redo:", "cut:", "copy:", "paste:", "pasteAndMatchStyle:", "pasteAsPlainText:", "delete:", "selectAll:",
    "performMiniaturize:", "performZoom:", "toggleFullScreen:", "miniaturizeAll:", "arrangeWindowsInFront:", "arrangeInFront:", "toggleKeepOnTop:",
    "toggleContinuousSpellChecking:", "toggleGrammarChecking:", "toggleAutomaticSpellingCorrection:", "toggleSmartInsertDelete:",
    "toggleAutomaticQuoteSubstitution:", "toggleAutomaticDashSubstitution:", "toggleAutomaticLinkDetection:", "toggleAutomaticDataDetection:",
    "toggleAutomaticTextReplacement:", "uppercaseWord:", "lowercaseWord:", "capitalizeWord:", "startSpeaking:", "stopSpeaking:",
  ]
  static let appWideActions: Set<String> = ["miniaturizeAll:", "arrangeInFront:", "arrangeWindowsInFront:"]

  static func perform(ref: String, windowId: String) throws -> String {
    guard let entry = MenuCatalog.action(ref) else { throw OpenSurfaces.Problem.missing("There's no native menu bar item with that ref; menus.bar lists them.") }
    let title = entry.title, name = NSStringFromSelector(entry.action)
    if LaunchConfig.shared.background { throw OpenSurfaces.Problem.refused(OpenSurfaces.nativeItemsNeedVisible) }
    guard !WindowManager.shared.anyIncognitoWindow else { throw OpenSurfaces.Problem.refused(OpenSurfaces.privateWindowOpen) }
    guard allowedActions.contains(name) else {
      throw OpenSurfaces.Problem.refused("\(title) isn't an editing or window item the ardia command may choose (quitting, hiding, closing windows and updates have their own paths or stay with you).")
    }
    guard let key = NSApp.keyWindow else {
      throw OpenSurfaces.Problem.refused("No window is key, so \(title) would have no window of its own to act on.")
    }
    guard let window = WindowManager.shared.window(windowId), key === window else {
      throw OpenSurfaces.Problem.refused("\(title) acts on the key window, and that isn't the window the ardia command named.")
    }
    let target: AnyObject
    if appWideActions.contains(name) {
      switch entry.target {
      case .menuTarget where MenuTarget.shared.responds(to: entry.action): target = MenuTarget.shared
      case .none where NSApp.responds(to: entry.action): target = NSApp
      default: throw OpenSurfaces.Problem.refused("\(title) can't be sent to an explicit target.")
      }
    } else {
      guard entry.target == .none, window.responds(to: entry.action) else {
        throw OpenSurfaces.Problem.refused("\(title) can't be sent to the named window itself, only along the responder chain, so the ardia command doesn't choose it.")
      }
      target = window
    }
    guard NSApp.sendAction(entry.action, to: target, from: nil) else { throw OpenSurfaces.Problem.refused("\(title) did nothing.") }
    return title
  }
}
