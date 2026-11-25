import CoreGraphics

public enum PageLastFrameRule {
  public static let kept = 4
  public static let sizeTolerance: CGFloat = 1

  public static func usable(savedDocument: Int, savedSize: CGSize, document: Int, size: CGSize) -> Bool {
    savedDocument == document && abs(savedSize.width - size.width) <= sizeTolerance && abs(savedSize.height - size.height) <= sizeTolerance && size.width > 0 && size.height > 0
  }

  public static func trimmed<T>(_ frames: [T], adding frame: T) -> [T] {
    Array((frames + [frame]).suffix(kept))
  }
}
