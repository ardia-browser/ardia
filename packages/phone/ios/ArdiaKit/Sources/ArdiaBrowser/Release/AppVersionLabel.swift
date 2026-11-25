import Foundation

public enum AppVersionLabel {
  public static let testFlightReceiptName = "sandboxReceipt"

  public static func text(releaseVersion: String, build: String, isDebug: Bool, receiptName: String?) -> String {
    guard !isDebug, let release = ReleaseVersion(releaseVersion) else {
      return String(localized: "Ardia Dev (\(build))")
    }
    guard receiptName == testFlightReceiptName else {
      return String(localized: "Ardia \(release.appleVersion) (\(build))")
    }
    if let nightly = release.nightly {
      return String(localized: "Ardia \(release.appleVersion) Nightly \(nightly) (\(build))")
    }
    return String(localized: "Ardia \(release.appleVersion) Nightly (\(build))")
  }
}

struct ReleaseVersion {
  let appleVersion: String
  let nightly: Int?

  init?(_ text: String) {
    guard let match = text.wholeMatch(of: /(\d+\.\d+\.\d+)(?:-nightly\.(\d+))?/) else { return nil }
    appleVersion = String(match.1)
    if let number = match.2 {
      guard let value = Int(number) else { return nil }
      nightly = value
    } else {
      nightly = nil
    }
  }
}
