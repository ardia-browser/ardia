import AppKit

final class WindowWatcher: NSView {
  var changed: ((Bool) -> Void)?

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    changed?(window != nil)
  }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

final class WeakLookup<Value: AnyObject> {
  private let table = NSMapTable<NSString, Value>.strongToWeakObjects()

  subscript(key: String) -> Value? {
    get { table.object(forKey: key as NSString) }
    set { table.setObject(newValue, forKey: key as NSString) }
  }
}

extension PageBinding {
  private static var issued = 0

  static func fresh(plugin: String, approved: String, run: Int) -> PageBinding {
    issued += 1
    return PageBinding(plugin: plugin, approved: approved, run: run, view: "b\(issued)")
  }
}
