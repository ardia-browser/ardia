struct VaultNewLogin: Sendable {
  private static let longestUsername = 1024

  static func cleanedUsername(_ typed: String?) -> String {
    String((typed ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(longestUsername))
  }

  var title: String
  var username: String
  var password: String
  var url: String
}
