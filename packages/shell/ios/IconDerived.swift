import AppKit
import ArdiaCore

final class IconImage {
  let image: CGImage
  init(_ image: CGImage) { self.image = image }
}

final class IconDerived<Value: AnyObject> {
  private let kind: String
  private let cache = NSCache<NSString, Value>()

  init(_ kind: String) { self.kind = kind }

  func value(for source: IconSource) -> Value? {
    if let address = source.storedAddress { return ArdiaFaviconStore.derived(address, kind: kind) as? Value }
    return cache.object(forKey: source.key as NSString)
  }

  func set(_ value: Value, for source: IconSource) {
    if let address = source.storedAddress { return ArdiaFaviconStore.setDerived(value, for: address, kind: kind) }
    cache.setObject(value, forKey: source.key as NSString)
  }
}

enum StoredIcons {
  private final class Box { var png: Data? }
  private static let queue = DispatchQueue(label: "com.ardia.shell.stored-icons", qos: .userInitiated)
  private static var waiting: [String: [() -> Void]] = [:]
  private static var failedAt: [String: Date] = [:]
  private static let retryAfter: TimeInterval = 10
  private static let longestWait: DispatchTimeInterval = .seconds(5)

  static func image(_ address: String) -> CGImage? {
    if Thread.isMainThread { return nil }
    let box = Box()
    let done = DispatchSemaphore(value: 0)
    ArdiaFaviconStore.load(address) { png in
      box.png = png
      done.signal()
    }
    guard done.wait(timeout: .now() + longestWait) == .success, let png = box.png else { return nil }
    return NSImage(data: png)?.cgImage(forProposedRect: nil, context: nil, hints: nil)
  }

  static func prepare(_ source: IconSource, kind: String, then redraw: @escaping () -> Void) {
    let key = "\(kind) \(source.key)"
    if let failed = failedAt[key], Date().timeIntervalSince(failed) < retryAfter { return }
    if waiting[key] != nil { return waiting[key]!.append(redraw) }
    waiting[key] = [redraw]
    queue.async {
      let ready = render(source, kind: kind)
      DispatchQueue.main.async {
        let views = waiting.removeValue(forKey: key) ?? []
        guard ready else {
          if failedAt.count >= 512 { failedAt.removeAll() }
          failedAt[key] = Date()
          return
        }
        failedAt.removeValue(forKey: key)
        views.forEach { $0() }
      }
    }
  }

  private static func render(_ source: IconSource, kind: String) -> Bool {
    if kind == "template" { return TemplateIcon.of(source) != nil }
    guard let blurred = BlurredIcon.of(source) else { return false }
    return GlassGlow.of(source, blurred: blurred.plain) != nil
  }
}
