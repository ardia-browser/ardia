import AppKit

struct WebKitPageBackdrop {
  var color: NSColor?
  var awaitingFirstPaint = false

  func layerColor(visible: Bool) -> CGColor? { visible ? color?.cgColor : nil }

  func uncovers(_ painted: CGColor?, visible: Bool) -> Bool { painted != nil && !visible }

  var pageDrawsBackground: Bool { !(awaitingFirstPaint && color != nil) }
}
