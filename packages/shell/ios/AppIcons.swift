import AppKit

enum AppIcons {
  struct Variant {
    let id: String
    let name: String
    var flat = false
  }

  static let defaultsKey = "ACAppIcon"
  static func changedNotification(bundleId: String) -> Notification.Name { .init("\(bundleId).AppIconChanged") }

  static let variants: [Variant] = [
    Variant(id: "default", name: "Default"),
    Variant(id: "midnight", name: "Midnight"),
    Variant(id: "daylight", name: "Daylight"),
    Variant(id: "plum", name: "Plum"),
    Variant(id: "ocean", name: "Ocean"),
    Variant(id: "mono", name: "Mono"),
    Variant(id: "noir", name: "Noir"),
    Variant(id: "default-flat", name: "Default", flat: true),
    Variant(id: "midnight-flat", name: "Midnight", flat: true),
    Variant(id: "daylight-flat", name: "Daylight", flat: true),
    Variant(id: "plum-flat", name: "Plum", flat: true),
    Variant(id: "ocean-flat", name: "Ocean", flat: true),
    Variant(id: "mono-flat", name: "Mono", flat: true),
    Variant(id: "noir-flat", name: "Noir", flat: true),
  ]

  static var current: String {
    let id = UserDefaults.standard.string(forKey: defaultsKey) ?? "default"
    return variants.contains { $0.id == id } ? id : "default"
  }

  private static var styleWatcher: IconStyleWatcher?

  static func restore() {
    if styleWatcher == nil { styleWatcher = IconStyleWatcher { apply() } }
    if shown != "default" { apply() }
  }

  static func set(_ id: String, announce: Bool) {
    guard variants.contains(where: { $0.id == id }) else { return }
    UserDefaults.standard.set(id, forKey: defaultsKey)
    apply()
    if announce, let bundleId = Bundle.main.bundleIdentifier {
      DistributedNotificationCenter.default().postNotificationName(
        changedNotification(bundleId: bundleId), object: nil, userInfo: ["icon": id], deliverImmediately: true)
    }
  }

  static var shown: String { IconStyle.shown(saved: current, theme: IconStyle.systemTheme, bundleIcon: IconStyle.bundleIcon) }

  private static func apply() {
    let bundleImageBeforeAnyOverride = ApplicationIconName.bundleImage
    let id = shown
    let custom = id == "default" ? nil : image(id, size: 512)
    NSApp.applicationIconImage = custom
    if !ApplicationIconName.register(custom ?? bundleImageBeforeAnyOverride) {
      NSLog("Ardia: couldn't name the \(id) app icon \(ApplicationIconName.name); Chromium's Dock tile draws the bundle icon")
    }
  }

  private static var cache: [String: NSImage] = [:]
  private static var previewCache: [String: String] = [:]

  static var base: NSImage = NSImage(named: "AppIcon") ?? NSWorkspace.shared.icon(forFile: Bundle.main.bundlePath) {
    didSet {
      cache.removeAll()
      previewCache.removeAll()
    }
  }

  static var imageNamed: (String) -> NSImage? = { NSImage(named: $0) } {
    didSet {
      cache.removeAll()
      previewCache.removeAll()
    }
  }

  static func image(_ id: String, size: CGFloat) -> NSImage? {
    let key = "\(id)@\(size)"
    if let hit = cache[key] { return hit }
    guard variants.contains(where: { $0.id == id }) else { return nil }
    let artwork = id == "default" ? base : imageNamed("AppIcon-\(id)") ?? base
    let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
      artwork.draw(in: rect)
      return true
    }
    cache[key] = image
    return image
  }

  static func preview(_ id: String, size: CGFloat) -> String? {
    let key = "\(id)@\(size)"
    if let hit = previewCache[key] { return hit }
    guard let image = image(id, size: size * 2),
          let tiff = image.tiffRepresentation,
          let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return nil }
    let encoded = "data:image/png;base64,\(png.base64EncodedString())"
    previewCache[key] = encoded
    return encoded
  }
}
