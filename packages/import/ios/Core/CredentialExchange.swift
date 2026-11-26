import AuthenticationServices
import Foundation

public enum CredentialSourceKind: String, Codable, Sendable {
  case apple
  case onePassword
  case bitwarden
  case other

  static func of(relyingParty: String, displayName: String) -> CredentialSourceKind {
    let names = "\(relyingParty) \(displayName)".lowercased()
    if names.contains("1password") { return .onePassword }
    if names.contains("bitwarden") { return .bitwarden }
    if names.contains("apple") || names.contains("passwords") { return .apple }
    return .other
  }
}

public struct ExchangedLogin: Codable, Equatable, Hashable, Sendable {
  public var url: String
  public var username: String
  public var password: String
}

public struct ExchangedCode: Codable, Equatable, Hashable, Sendable {
  public var url: String
  public var username: String
  public var otpAuth: String
}

public struct CredentialExchangeImport: Codable, Equatable, Sendable {
  public var exporter: String
  public var source: CredentialSourceKind
  public var logins: [ExchangedLogin]
  public var codes: [ExchangedCode]
  public var passkeys: Int
  public var noSite: Int
  public var unsupported: Int
}

@available(macOS 26, *)
public enum CredentialExchange {
  public static func decode(_ data: Data) throws -> ASExportedCredentialData {
    do {
      return try JSONDecoder().decode(ASExportedCredentialData.self, from: data)
    } catch {
      throw ImportError.unsupported("This isn't credential exchange data")
    }
  }

  public static func summarize(_ data: ASExportedCredentialData) -> CredentialExchangeImport {
    var result = CredentialExchangeImport(
      exporter: data.exporterDisplayName,
      source: .of(relyingParty: data.exporterRelyingPartyIdentifier, displayName: data.exporterDisplayName),
      logins: [], codes: [], passkeys: 0, noSite: 0, unsupported: 0)
    var seenLogins = Set<ExchangedLogin>()
    var seenCodes = Set<ExchangedCode>()
    for item in data.accounts.flatMap(\.items) {
      let found = secrets(of: item)
      result.passkeys += found.passkeys
      if found.logins.isEmpty && found.codes.isEmpty {
        if found.passkeys == 0 { result.unsupported += 1 }
        continue
      }
      let sites = websites(of: item)
      if sites.isEmpty {
        result.noSite += 1
        continue
      }
      for site in sites {
        for login in found.logins {
          let entry = ExchangedLogin(url: site, username: login.username, password: login.password)
          if seenLogins.insert(entry).inserted { result.logins.append(entry) }
        }
        for code in found.codes {
          let entry = ExchangedCode(url: site, username: code.username, otpAuth: code.uri)
          if seenCodes.insert(entry).inserted { result.codes.append(entry) }
        }
      }
    }
    return result
  }

  struct ItemSecrets {
    var logins: [(username: String, password: String)] = []
    var codes: [(username: String, uri: String)] = []
    var passkeys = 0
  }

  static func secrets(of item: ASImportableItem) -> ItemSecrets {
    var found = ItemSecrets()
    var totps: [ASImportableCredential.TOTP] = []
    for credential in item.credentials {
      switch credential {
      case .basicAuthentication(let basic):
        let password = basic.password?.value ?? ""
        if !password.isEmpty { found.logins.append((basic.userName?.value ?? "", password)) }
      case .totp(let totp):
        totps.append(totp)
      case .passkey:
        found.passkeys += 1
      default:
        break
      }
    }
    let fallbackUser = found.logins.first?.username ?? ""
    for totp in totps where !totp.secret.isEmpty {
      let username = totp.userName.flatMap { $0.isEmpty ? nil : $0 } ?? fallbackUser
      if let uri = otpAuthURI(totp, username: username) { found.codes.append((username, uri)) }
    }
    return found
  }

  static func websites(of item: ASImportableItem) -> [String] {
    var seen = Set<String>()
    return (item.scope?.urls ?? []).compactMap { url -> String? in
      guard let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http", url.host?.isEmpty == false else { return nil }
      let text = url.absoluteString
      return seen.insert(text).inserted ? text : nil
    }
  }

  static func otpAuthURI(_ totp: ASImportableCredential.TOTP, username: String) -> String? {
    let issuer = totp.issuer?.trimmingCharacters(in: .whitespaces) ?? ""
    var parts = URLComponents()
    parts.scheme = "otpauth"
    parts.host = "totp"
    parts.path = "/" + (issuer.isEmpty ? username : "\(issuer):\(username)")
    var query = [URLQueryItem(name: "secret", value: Base32.encode(totp.secret))]
    if !issuer.isEmpty { query.append(URLQueryItem(name: "issuer", value: issuer)) }
    query.append(URLQueryItem(name: "algorithm", value: totp.algorithm.rawValue.uppercased()))
    query.append(URLQueryItem(name: "digits", value: String(totp.digits)))
    query.append(URLQueryItem(name: "period", value: String(totp.period)))
    parts.queryItems = query
    return parts.string
  }
}

enum Base32 {
  static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")

  static func encode(_ data: Data) -> String {
    var out = ""
    out.reserveCapacity((data.count * 8 + 4) / 5)
    var buffer: UInt32 = 0
    var bits = 0
    for byte in data {
      buffer = (buffer << 8) | UInt32(byte)
      bits += 8
      while bits >= 5 {
        bits -= 5
        out.append(alphabet[Int((buffer >> UInt32(bits)) & 31)])
      }
    }
    if bits > 0 { out.append(alphabet[Int((buffer << UInt32(5 - bits)) & 31)]) }
    return out
  }
}
