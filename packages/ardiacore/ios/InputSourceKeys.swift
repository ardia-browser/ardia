import AppKit
import Carbon.HIToolbox

public enum InputSourceKeys {
  static let keyCodes: Set<UInt16> = [UInt16(kVK_JIS_Eisu), UInt16(kVK_JIS_Kana)]
  static let processKeyBindings = NSSelectorFromString("processInputKeyBindings:")
  private static let lock = NSLock()
  private static var webKitTabKeys = 0

  public static func consume(_ event: NSEvent) -> Bool {
    guard keyCodes.contains(event.keyCode), NSTextInputContext.responds(to: processKeyBindings) else { return false }
    typealias ProcessKeyBindings = @convention(c) (AnyClass, Selector, NSEvent) -> ObjCBool
    let process = unsafeBitCast(NSTextInputContext.method(for: processKeyBindings), to: ProcessKeyBindings.self)
    _ = process(NSTextInputContext.self, processKeyBindings, event)
    return true
  }

  static func consumeInWebKitTab(_ event: NSEvent) -> Bool {
    guard consume(event) else { return false }
    lock.lock()
    webKitTabKeys += 1
    lock.unlock()
    return true
  }

  public static func takeWebKitTabKeys() -> Int {
    lock.lock()
    defer { lock.unlock() }
    let taken = webKitTabKeys
    webKitTabKeys = 0
    return taken
  }
}
