import AppKit

enum ApplicationIconName {
  static let name = NSImage.applicationIconName

  static let bundleImage = NSImage(named: name)

  static func register(_ icon: NSImage?) -> Bool {
    let named = NSImage(named: name)
    if let icon, icon === named { return true }
    named?.setName(nil)
    return icon?.setName(name) ?? true
  }
}
