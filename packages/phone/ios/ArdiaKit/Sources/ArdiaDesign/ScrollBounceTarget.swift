import CoreGraphics

public enum ScrollBounceTarget {
  public static let ancestorsSearched = 6
  public static let viewsSearched = 400
  public static let tolerance: CGFloat = 2
  public static let retries = 20
  public static let retryGap: Double = 0.1
  static let notOurs = ["WK", "RCT"]

  public static func matches(className: String, frame: CGRect, mine: CGRect) -> Bool {
    guard !notOurs.contains(where: className.hasPrefix), !mine.isEmpty, !frame.isEmpty else { return false }
    let sameColumn = abs(frame.minX - mine.minX) <= tolerance && abs(frame.width - mine.width) <= tolerance
    let holds = frame.minY <= mine.minY + tolerance && frame.maxY >= mine.maxY - tolerance
    return sameColumn && holds
  }
}
