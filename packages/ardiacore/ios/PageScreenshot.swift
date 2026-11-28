import AppKit

enum PageScreenshot {
  static let noPage: [String: Any] = ["ok": false, "reason": "noPage"]
  static let noPicture: [String: Any] = ["ok": false, "reason": "noPicture"]
  static let unencodable: [String: Any] = ["ok": false, "reason": "unencodable"]
  static let unwritable: [String: Any] = ["ok": false, "reason": "unwritable"]

  static func copy(_ picture: CGImage?, backingScale: CGFloat) -> [String: Any] {
    guard let picture, picture.width > 0, picture.height > 0 else { return noPicture }
    guard let image = NSBitmapImageRep(cgImage: picture).converting(to: .sRGB, renderingIntent: .default) else { return unencodable }
    let scale = max(backingScale, 1)
    image.size = NSSize(width: CGFloat(image.pixelsWide) / scale, height: CGFloat(image.pixelsHigh) / scale)
    guard let png = image.representation(using: .png, properties: [:]), let tiff = image.tiffRepresentation else { return unencodable }
    let board = NSPasteboard.general
    board.clearContents()
    guard board.setData(png, forType: .png), board.setData(tiff, forType: .tiff) else { return unwritable }
    return ["ok": true, "width": image.pixelsWide, "height": image.pixelsHigh]
  }
}
