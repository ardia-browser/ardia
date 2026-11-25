import Foundation

public enum FatalMatch {
  public static let writtenBeforeCrash: TimeInterval = 30
  public static let writtenAfterCrash: TimeInterval = 2

  public static func crash(forFileWrittenAt written: Date, among crashes: [Date]) -> Int? {
    var best: (index: Int, distance: TimeInterval)?
    for (index, crashed) in crashes.enumerated() {
      let lead = crashed.timeIntervalSince(written)
      guard lead >= -writtenAfterCrash, lead <= writtenBeforeCrash else { continue }
      if best == nil || abs(lead) < best!.distance { best = (index, abs(lead)) }
    }
    return best?.index
  }
}
