import CoreGraphics

public enum MenuPreviewShape {
  public static func radius(given: CGFloat?, own: CGFloat, child: CGFloat, size: CGSize) -> CGFloat {
    let largest = min(size.width, size.height) / 2
    guard let given else { return min(max(own, child), largest) }
    return min(max(given, 0), largest)
  }
}
