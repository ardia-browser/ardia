import Foundation

enum PluginDataPaths {
  static let profilesFolder = "profiles"
  private static let profilePattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]{1,64}$")

  static func isProfileId(_ text: String) -> Bool {
    let whole = NSRange(text.startIndex..., in: text)
    return profilePattern.firstMatch(in: text, range: whole)?.range == whole
  }

  static func relative(_ space: String) -> String? {
    if PluginPrograms.isKey(space) { return space == profilesFolder ? nil : space }
    let parts = space.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard parts.count == 3, parts[0] == profilesFolder, isProfileId(parts[1]), PluginPrograms.isKey(parts[2]) else { return nil }
    return parts.joined(separator: "/")
  }
}
