import Foundation

struct VaultSignInAnswer: Sendable, Equatable {
  var need: String
  var value: String?
  var entryToken: String?
  var methodId: String?
  var accountId: String?
}

struct VaultSignInFields: Sendable, Equatable {
  var method: String?
  var server: String?
  var values: [String: String] = [:]
  var secrets: [String: String] = [:]
  var answer: VaultSignInAnswer?
}
