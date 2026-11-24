import Darwin
import Foundation
import Security

public struct ControlPeer: Equatable {
  public enum Signer: Equatable {
    case team(String)
    case apple
    case other
  }

  public let pid: pid_t
  public let path: String?
  public let identifier: String?
  public let signer: Signer
  public let developer: String?
  public let cdhash: String?
  public let hardened: Bool
  public let bundleName: String?

  public init(pid: pid_t, path: String?, identifier: String?, signer: Signer, developer: String?, cdhash: String?, hardened: Bool, bundleName: String? = nil) {
    self.pid = pid
    self.path = path
    self.identifier = identifier
    self.signer = signer
    self.developer = developer
    self.cdhash = cdhash
    self.hardened = hardened
    self.bundleName = bundleName
  }

  public static let unknown = ControlPeer(pid: 0, path: nil, identifier: nil, signer: .other, developer: nil, cdhash: nil, hardened: false)

  public var approvalKey: String? {
    switch signer {
    case let .team(team):
      guard let identifier, !identifier.isEmpty else { return nil }
      return "team:\(team):\(identifier)"
    case .apple:
      guard let identifier, !identifier.isEmpty else { return nil }
      return "apple:\(identifier)"
    case .other:
      guard let path, let cdhash else { return nil }
      return "code:\(cdhash):\(path)"
    }
  }

  public var name: String {
    if let bundleName, !bundleName.isEmpty { return Self.plain(bundleName, limit: 64) }
    if let path { return Self.plain((path as NSString).lastPathComponent, limit: 64) }
    if let identifier { return Self.plain(identifier, limit: 64) }
    return "An unknown program"
  }

  public var signedBy: String {
    switch signer {
    case let .team(team):
      if let developer, !developer.isEmpty { return "Signed by \(Self.plain(developer, limit: 80)) (\(team))" }
      return "Signed by developer team \(team)"
    case .apple:
      return "Part of macOS, signed by Apple"
    case .other:
      return "Not signed by an identified developer"
    }
  }

  public static let codeSigningRuntime: UInt32 = 0x10000

  public static func auditToken(of fd: Int32) -> audit_token_t? {
    var token = audit_token_t()
    var length = socklen_t(MemoryLayout<audit_token_t>.size)
    guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &length) == 0, Int(length) == MemoryLayout<audit_token_t>.size else { return nil }
    return token
  }

  public static func pid(of token: audit_token_t) -> pid_t {
    pid_t(bitPattern: token.val.5)
  }

  public static func process(of token: audit_token_t) -> String {
    "\(token.val.5):\(token.val.7)"
  }

  public static func alive(_ token: audit_token_t) -> Bool {
    var copy = token
    let tokenData = withUnsafeBytes(of: &copy) { Data($0) } as CFData
    var code: SecCode?
    return SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributeAudit: tokenData] as CFDictionary, [], &code) == errSecSuccess && code != nil
  }

  public static func plain(_ text: String, limit: Int) -> String {
    let kept = String(String.UnicodeScalarView(text.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) && !CharacterSet.illegalCharacters.contains($0) && $0.properties.generalCategory != .format }))
    return kept.count > limit ? String(kept.prefix(limit - 1)) + "…" : kept
  }

  public static func resolve(_ token: audit_token_t) -> ControlPeer {
    var copy = token
    let tokenData = withUnsafeBytes(of: &copy) { Data($0) } as CFData
    var code: SecCode?
    guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributeAudit: tokenData] as CFDictionary, [], &code) == errSecSuccess, let code else {
      return ControlPeer(pid: pid(of: token), path: nil, identifier: nil, signer: .other, developer: nil, cdhash: nil, hardened: false)
    }
    return resolve(code, pid: pid(of: token))
  }

  public static func resolveSelf() -> ControlPeer {
    var code: SecCode?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return .unknown }
    return resolve(code, pid: getpid())
  }

  static func resolve(_ code: SecCode, pid: pid_t) -> ControlPeer {
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else {
      return ControlPeer(pid: pid, path: nil, identifier: nil, signer: .other, developer: nil, cdhash: nil, hardened: false)
    }
    var information: CFDictionary?
    let flags = SecCSFlags(rawValue: kSecCSSigningInformation | kSecCSDynamicInformation)
    _ = SecCodeCopySigningInformation(staticCode, flags, &information)
    let info = (information as? [String: Any]) ?? [:]
    let path = (info[kSecCodeInfoMainExecutable as String] as? URL)?.path ?? pathOf(staticCode)
    let identifier = info[kSecCodeInfoIdentifier as String] as? String
    let declaredHash = (info[kSecCodeInfoUnique as String] as? Data).map(hex)
    let codeFlags = (info[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value ?? 0
    let team = info[kSecCodeInfoTeamIdentifier as String] as? String
    let plist = info[kSecCodeInfoPList as String] as? [String: Any]
    let bundleName = path.flatMap { $0.contains(".app/Contents/MacOS/") ? (plist?["CFBundleDisplayName"] as? String ?? plist?["CFBundleName"] as? String) : nil }
    let certificates = info[kSecCodeInfoCertificates as String] as? [SecCertificate]
    let signer: Signer
    if let team, !team.isEmpty, satisfies(code, "anchor apple generic and certificate leaf[subject.OU] = \"\(team)\"") {
      signer = .team(team)
    } else if satisfies(code, "anchor apple") {
      signer = .apple
    } else {
      signer = .other
    }
    let cdhash = declaredHash.flatMap { satisfies(code, "cdhash H\"\($0)\"") ? $0 : nil }
    let developer: String? = {
      guard case .team = signer, let leaf = certificates?.first, let summary = SecCertificateCopySubjectSummary(leaf) as String? else { return nil }
      return developerName(summary)
    }()
    return ControlPeer(
      pid: pid, path: path, identifier: identifier, signer: signer, developer: developer, cdhash: cdhash,
      hardened: codeFlags & codeSigningRuntime != 0, bundleName: bundleName)
  }

  public static func developerName(_ summary: String) -> String {
    var name = summary
    if let colon = name.range(of: ": ") { name = String(name[colon.upperBound...]) }
    if name.hasSuffix(")"), let open = name.range(of: " (", options: .backwards) { name = String(name[..<open.lowerBound]) }
    return name
  }

  static func satisfies(_ code: SecCode, _ text: String) -> Bool {
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess, let requirement else { return false }
    return SecCodeCheckValidity(code, [], requirement) == errSecSuccess
  }

  static func pathOf(_ staticCode: SecStaticCode) -> String? {
    var url: CFURL?
    guard SecCodeCopyPath(staticCode, [], &url) == errSecSuccess, let url else { return nil }
    return (url as URL).path
  }

  static func hex(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
  }
}
