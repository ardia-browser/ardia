import AppKit
import Carbon

final class FullScreenMenuBar {
  static let shared = FullScreenMenuBar()

  private var handler: EventHandlerRef?
  private var spaceObserver: NSObjectProtocol?
  private var changed: () -> Void = {}

  var shown: Bool { NSMenu.menuBarVisible() }

  func watch(_ changed: @escaping () -> Void) {
    self.changed = changed
    guard handler == nil else { return }
    var kinds = [kEventMenuBarShown, kEventMenuBarHidden].map { EventTypeSpec(eventClass: OSType(kEventClassMenu), eventKind: UInt32($0)) }
    InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
      DispatchQueue.main.async { FullScreenMenuBar.shared.changed() }
      return OSStatus(eventNotHandledErr)
    }, kinds.count, &kinds, nil, &handler)
    spaceObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { _ in
      FullScreenMenuBar.shared.changed()
    }
  }
}
