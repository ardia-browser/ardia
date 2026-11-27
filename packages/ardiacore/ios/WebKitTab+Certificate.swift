import CryptoKit
import Foundation
import Security
import WebKit

final class WebKitCertificates {
  typealias StoreID = WebKitStores.StoreID

  static let preloadedSuffixes: Set<String> = [
    "android", "app", "bank", "boo", "channel", "chrome", "dad", "day", "dev", "eat", "esq", "fly", "foo", "gle", "gmail",
    "google", "hangout", "ing", "insurance", "meet", "meme", "mov", "new", "nexus", "page", "phd", "play", "prof", "rsvp",
    "search", "youtube", "zip",
  ]

  private static let errorChecks: [(name: String, keys: [String])] = [
    ("revoked", ["Revocation", "RevocationResponseRequired"]),
    ("authorityInvalid", ["AnchorTrusted", "MissingIntermediate", "IssuerCommonName", "BlackListedLeaf", "GrayListedLeaf"]),
    ("nameMismatch", ["SSLHostname"]),
    ("certificateTransparency", ["CTRequired"]),
    ("weakSignature", ["SignatureHashAlgorithms", "WeakSignature"]),
    ("dateInvalid", ["TemporalValidity", "ValidLeaf", "ValidIntermediates", "ValidRoot"]),
    ("validityTooLong", ["ValidityPeriodMaximums"]),
    ("nameConstraint", ["NameConstraints", "PermittedSubtrees", "ExcludedSubtrees"]),
    ("weakKey", ["KeySize", "WeakKeySize", "WeakLeaf", "WeakIntermediates", "WeakRoot"]),
  ]

  private static let displayOrder = [
    "nameMismatch", "dateInvalid", "authorityInvalid", "revoked", "invalid", "weakSignature", "weakKey", "nameConstraint", "validityTooLong",
    "certificateTransparency",
  ]

  private static let primaryOrder = [
    "invalid", "revoked", "authorityInvalid", "nameMismatch", "certificateTransparency", "nameConstraint", "weakSignature", "weakKey",
    "dateInvalid", "validityTooLong",
  ]

  private static let evaluator = DispatchQueue(label: "ardia.webkit.trust", qos: .userInitiated)
  private static let files = DispatchQueue(label: "ardia.webkit.transport-security", qos: .utility)

  private var policies: [StoreID: WebKitCertificatePolicy] = [:]
  private var pendingSaves: [StoreID: DispatchWorkItem] = [:]
  private var unreadable = Set<StoreID>()

  init() {
    WebKitPreloadedHSTS.warm()
  }

  static func fingerprint(_ trust: SecTrust) -> String? {
    guard let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first else { return nil }
    return SHA256.hash(data: SecCertificateCopyData(leaf) as Data).map { String(format: "%02X", $0) }.joined(separator: ":")
  }

  static func errorNames(_ trust: SecTrust, failed: Bool) -> [String] {
    guard failed else { return [] }
    let result = SecTrustCopyResult(trust) as? [String: Any] ?? [:]
    let details = result["TrustResultDetails"] as? [[String: Any]] ?? []
    let failing = Set(details.flatMap { entry in entry.compactMap { key, value in (value as? Bool) == false ? key : nil } })
    let names = Set(errorChecks.filter { !failing.isDisjoint(with: $0.keys) }.map(\.name))
    return names.isEmpty ? ["invalid"] : displayOrder.filter(names.contains)
  }

  static func primaryError(_ errors: [String]) -> String {
    primaryOrder.first(where: errors.contains) ?? errors.first ?? "invalid"
  }

  static func extendedValidation(_ trust: SecTrust) -> Bool {
    let result = SecTrustCopyResult(trust) as? [String: Any] ?? [:]
    return (result[kSecTrustExtendedValidation as String] as? Bool) == true
  }

  static func evaluate(_ trust: SecTrust, done: @escaping ([String]) -> Void) {
    let box = WebKitTrustBox(trust)
    evaluator.async {
      SecTrustEvaluateAsyncWithError(box.trust, evaluator) { evaluated, trusted, _ in
        let errors = errorNames(evaluated, failed: !trusted)
        DispatchQueue.main.async { done(errors) }
      }
    }
  }

  func allows(_ store: StoreID, host: String, fingerprint: String, errors: [String]) -> Bool {
    guard !requiresSecureTransport(host, store: store) else { return false }
    return change(store) { $0.admits(host: host, fingerprint: fingerprint, errors: errors, now: Date()) }
  }

  func hasException(_ store: StoreID, host: String) -> Bool {
    policy(store).hasException(host: host, now: Date())
  }

  func allow(_ store: StoreID, host: String, fingerprint: String, errors: [String]) {
    guard !requiresSecureTransport(host, store: store) else { return }
    change(store) { $0.allow(host: host, fingerprint: fingerprint, errors: errors, now: Date()) }
  }

  func bypassedErrors(_ store: StoreID, host: String, fingerprint: String?) -> [String]? {
    policy(store).bypassedErrors(host: host, fingerprint: fingerprint)
  }

  func forget(_ store: StoreID) {
    policies.removeValue(forKey: store)
  }

  func forgetTransportSecurity(profile: String, since: Date? = nil, done: @escaping (String?) -> Void = { _ in }) {
    let store = WebKitHub.shared.stores.id(of: profile)
    pendingSaves.removeValue(forKey: store)?.cancel()
    var kept: [String: WebKitTransportSecurity]?
    if let since {
      let unread = readAgainIfUnreadable(store, clearingSince: since)
      change(store) { $0.forget(since: since) }
      if let unread { return done(unread) }
      kept = policies[store]?.savedTransportSecurity(now: Date()) ?? [:]
    } else {
      unreadable.remove(store)
      policies[store] = WebKitCertificatePolicy(transportSecurity: [:])
    }
    guard let file = Self.file(for: store) else { return done(nil) }
    Self.files.async {
      let error = WebKitCertificatePolicy.SavedList.write(kept, to: file)
      DispatchQueue.main.async { done(error) }
    }
  }

  func noteTransportSecurity(_ header: String, host: String, fingerprint: String?, store: StoreID) {
    let name = WebKitCertificatePolicy.normalizedHost(host)
    guard !name.isEmpty, !WebKitPreloadedHSTS.isIPAddress(name) else { return }
    let changed = change(store) { $0.noteHeader(header, host: name, fingerprint: fingerprint, now: Date()) }
    if changed { scheduleSave(store) }
  }

  func requiresSecureTransport(_ host: String, store: StoreID) -> Bool {
    let name = WebKitCertificatePolicy.normalizedHost(host)
    if let last = name.split(separator: ".").last, Self.preloadedSuffixes.contains(String(last)) { return true }
    if WebKitPreloadedHSTS.requiresHTTPS(name) { return true }
    return policy(store).requiresHTTPS(host: name, now: Date())
  }

  private func policy(_ store: StoreID) -> WebKitCertificatePolicy {
    if let known = policies[store] { return known }
    var loaded = WebKitCertificatePolicy(awaitingSavedList: true)
    do {
      loaded = WebKitCertificatePolicy(transportSecurity: try Self.load(store))
    } catch {
      unreadable.insert(store)
    }
    policies[store] = loaded
    return loaded
  }

  private func readAgainIfUnreadable(_ store: StoreID, clearingSince since: Date) -> String? {
    _ = policy(store)
    guard unreadable.contains(store) else { return nil }
    do {
      let saved = try Self.load(store)
      unreadable.remove(store)
      change(store) { $0.adoptSaved(saved, now: Date(), clearingSince: since) }
      return nil
    } catch {
      return (error as? WebKitCertificatePolicy.SavedList.Unreadable)?.message ?? "couldn't read the HSTS list"
    }
  }

  private func change<T>(_ store: StoreID, _ body: (inout WebKitCertificatePolicy) -> T) -> T {
    var current = policy(store)
    let result = body(&current)
    policies[store] = current
    return result
  }

  private static func file(for store: StoreID) -> URL? {
    guard case .profile(let name) = store, !ArdiaHost.dataDirectory.isEmpty else { return nil }
    let hex = name.utf8.map { String(format: "%02X", $0) }.joined()
    return URL(fileURLWithPath: ArdiaHost.dataDirectory).appendingPathComponent("WebKit Transport Security").appendingPathComponent("p\(hex).json")
  }

  private static func load(_ store: StoreID) throws -> [String: WebKitTransportSecurity] {
    guard let file = file(for: store) else { return [:] }
    return try WebKitCertificatePolicy.SavedList.read(file)
  }

  private func scheduleSave(_ store: StoreID) {
    guard let file = Self.file(for: store), pendingSaves[store] == nil else { return }
    let save = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.pendingSaves.removeValue(forKey: store)
      guard !self.unreadable.contains(store), let entries = self.policies[store]?.savedTransportSecurity(now: Date()) else { return }
      Self.files.async { _ = WebKitCertificatePolicy.SavedList.write(entries, to: file) }
    }
    pendingSaves[store] = save
    DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: save)
  }
}

private final class WebKitTrustBox: @unchecked Sendable {
  let trust: SecTrust
  init(_ trust: SecTrust) { self.trust = trust }
}

extension WebKitTab {
  static func certificate(_ trust: SecTrust) -> [String: Any]? {
    guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else { return nil }
    let keys = [kSecOIDX509V1SubjectName, kSecOIDX509V1IssuerName, kSecOIDX509V1ValidityNotBefore, kSecOIDX509V1ValidityNotAfter] as CFArray
    let values = SecCertificateCopyValues(leaf, keys, nil) as? [String: [String: Any]] ?? [:]
    func principal(_ oid: CFString) -> [String: Any] {
      let entries = values[oid as String]?[kSecPropertyKeyValue as String] as? [[String: Any]] ?? []
      func field(_ name: CFString) -> [String] {
        entries.filter { ($0[kSecPropertyKeyLabel as String] as? String) == name as String }.compactMap { $0[kSecPropertyKeyValue as String] as? String }
      }
      let common = field(kSecOIDCommonName).first ?? ""
      let organizations = field(kSecOIDOrganizationName)
      let display = common.isEmpty ? organizations.first ?? field(kSecOIDOrganizationalUnitName).first ?? "" : common
      return ["commonName": common, "displayName": display, "organizations": organizations, "country": field(kSecOIDCountryName).first ?? ""]
    }
    func date(_ oid: CFString) -> Double {
      guard let value = values[oid as String]?[kSecPropertyKeyValue as String] as? NSNumber else { return 0 }
      return (value.doubleValue + Date.timeIntervalBetween1970AndReferenceDate) * 1000
    }
    var info: [String: Any] = [
      "subject": principal(kSecOIDX509V1SubjectName), "issuer": principal(kSecOIDX509V1IssuerName),
      "validFrom": date(kSecOIDX509V1ValidityNotBefore), "validUntil": date(kSecOIDX509V1ValidityNotAfter),
      "chainLength": chain.count,
    ]
    if let print = WebKitCertificates.fingerprint(trust) { info["sha256"] = print }
    if let serial = SecCertificateCopySerialNumberData(leaf, nil) as Data? {
      info["serialNumber"] = serial.map { String(format: "%02X", $0) }.joined(separator: ":")
    }
    return info
  }

  func securityInfo() -> [String: Any] {
    guard let view = webView, let url = view.url else {
      return ["level": "none", "url": webView?.url?.absoluteString ?? "", "origin": NSNull()]
    }
    let scheme = url.scheme?.lowercased() ?? ""
    let origin = scheme == "http" || scheme == "https" ? Origins.of(url) : nil
    var info: [String: Any] = ["url": url.absoluteString, "origin": origin ?? NSNull()]
    if showingError {
      guard scheme == "https", let blocked = safety.interstitial else {
        info["level"] = scheme == "http" ? "insecure" : "none"
        return info
      }
      info["level"] = "certificateError"
      info["certificateErrors"] = blocked.errors
      info["mixedContent"] = NSNull()
      info["isEV"] = false
      if let certificate = safety.interstitial?.trust.flatMap(Self.certificate) { info["certificate"] = certificate }
      return info
    }
    switch scheme {
    case "https":
      let trust = view.serverTrust
      let errors = Self.bypassedErrors(url: url, trust: trust, profile: profile)
      info["level"] = !errors.isEmpty ? "certificateError" : view.hasOnlySecureContent ? "secure" : "mixed"
      info["certificateErrors"] = errors
      info["mixedContent"] = view.hasOnlySecureContent ? NSNull() : "displayed"
      info["isEV"] = errors.isEmpty && trust.map(WebKitCertificates.extendedValidation) == true
      if let trust, let certificate = Self.certificate(trust) { info["certificate"] = certificate }
    case "http": info["level"] = "insecure"
    case "file": info["level"] = "local"
    default: info["level"] = "none"
    }
    return info
  }

  static func bypassedErrors(url: URL, trust: SecTrust?, profile: String) -> [String] {
    guard let host = url.host?.lowercased(), !host.isEmpty else { return [] }
    let hub = WebKitHub.shared
    let store = hub.stores.id(of: profile)
    let print = trust.flatMap(WebKitCertificates.fingerprint)
    if let errors = hub.certificates.bypassedErrors(store, host: host, fingerprint: print) { return errors.isEmpty ? ["invalid"] : errors }
    if print == nil, let errors = hub.certificates.bypassedErrors(store, host: host, fingerprint: nil) { return errors.isEmpty ? ["invalid"] : errors }
    return []
  }
}
