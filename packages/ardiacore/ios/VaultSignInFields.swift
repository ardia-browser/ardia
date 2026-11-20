import Foundation

struct VaultSignInFields: Sendable {
  var email: String? = nil
  var password: String? = nil
  var code: String? = nil
  var method: String? = nil
  var server: String? = nil
  var clientId: String? = nil
  var clientSecret: String? = nil
  var account: String? = nil
}
