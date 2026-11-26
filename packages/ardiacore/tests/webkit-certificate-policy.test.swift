import Foundation
import Testing

struct CertificateExceptions {
  let now = Date(timeIntervalSince1970: 1_800_000_000)

  @Test func `a proceed covers the same host, certificate and errors`() {
    var policy = WebKitCertificatePolicy()
    policy.allow(host: "Self-Signed.example", fingerprint: "AA", errors: ["authorityInvalid"], now: now)
    let result1 = policy.admits(host: "self-signed.example", fingerprint: "AA", errors: ["authorityInvalid"], now: now)
    #expect(result1)
    let result2 = policy.admits(host: "self-signed.example", fingerprint: "BB", errors: ["authorityInvalid"], now: now)
    #expect(!result2)
    let result3 = policy.admits(host: "other.example", fingerprint: "AA", errors: ["authorityInvalid"], now: now)
    #expect(!result3)
  }

  @Test func `a new error on the same certificate asks again`() {
    var policy = WebKitCertificatePolicy()
    policy.allow(host: "a.example", fingerprint: "AA", errors: ["nameMismatch"], now: now)
    let result4 = policy.admits(host: "a.example", fingerprint: "AA", errors: ["nameMismatch", "dateInvalid"], now: now)
    #expect(!result4)
    let result5 = policy.admits(host: "a.example", fingerprint: "AA", errors: ["nameMismatch", "revoked"], now: now)
    #expect(!result5)
  }

  @Test(arguments: [["revoked"], ["invalid"], ["authorityInvalid", "revoked"], []])
  func `fatal errors can never be bypassed`(errors: [String]) {
    var policy = WebKitCertificatePolicy()
    policy.allow(host: "a.example", fingerprint: "AA", errors: errors, now: now)
    #expect(!WebKitCertificatePolicy.overridable(errors))
    #expect(!policy.hasException(host: "a.example", now: now))
    let result6 = policy.admits(host: "a.example", fingerprint: "AA", errors: errors, now: now)
    #expect(!result6)
  }

  @Test func `a proceed expires after a week like Chromium's`() {
    var policy = WebKitCertificatePolicy()
    policy.allow(host: "a.example", fingerprint: "AA", errors: ["dateInvalid"], now: now)
    let later = now.addingTimeInterval(WebKitCertificatePolicy.exceptionLifetime + 1)
    let result7 = policy.admits(host: "a.example", fingerprint: "AA", errors: ["dateInvalid"], now: later)
    #expect(!result7)
  }

  @Test func `a page loaded through a proceed keeps its errors after the proceed expires`() {
    var policy = WebKitCertificatePolicy()
    #expect(policy.bypassedErrors(host: "a.example", fingerprint: "AA") == nil)
    policy.allow(host: "a.example", fingerprint: "AA", errors: ["nameMismatch"], now: now)
    let result8 = policy.admits(host: "a.example", fingerprint: "AA", errors: ["nameMismatch"], now: now)
    #expect(result8)
    let later = now.addingTimeInterval(WebKitCertificatePolicy.exceptionLifetime + 1)
    let result9 = policy.admits(host: "a.example", fingerprint: "AA", errors: ["nameMismatch"], now: later)
    #expect(!result9)
    #expect(policy.bypassedErrors(host: "A.example", fingerprint: "AA") == ["nameMismatch"])
    #expect(policy.bypassedErrors(host: "a.example", fingerprint: nil) == ["nameMismatch"])
    #expect(policy.bypassedErrors(host: "a.example", fingerprint: "BB") == nil)
    #expect(policy.hasException(host: "a.example", now: later))
  }
}

struct DynamicTransportSecurity {
  let now = Date(timeIntervalSince1970: 1_800_000_000)

  @Test func `a header covers its host and, with includeSubDomains, the hosts below it`() {
    var policy = WebKitCertificatePolicy()
    let result10 = policy.noteHeader("max-age=31536000; includeSubDomains", host: "Bank.example", now: now)
    #expect(result10)
    let result11 = policy.noteHeader("max-age=600", host: "shop.example", now: now)
    #expect(result11)
    #expect(policy.requiresHTTPS(host: "bank.example", now: now))
    #expect(policy.requiresHTTPS(host: "login.bank.example", now: now))
    #expect(policy.requiresHTTPS(host: "shop.example", now: now))
    #expect(!policy.requiresHTTPS(host: "www.shop.example", now: now))
    #expect(!policy.requiresHTTPS(host: "example", now: now))
  }

  @Test func `a trailing dot names the same host for recording and checking`() {
    var policy = WebKitCertificatePolicy()
    let recorded = policy.noteHeader("max-age=600", host: "Example.com.", now: now)
    #expect(recorded)
    #expect(policy.requiresHTTPS(host: "example.com", now: now))
    #expect(policy.requiresHTTPS(host: "EXAMPLE.COM.", now: now))
    let again = policy.noteHeader("max-age=600", host: "example.com", now: now)
    #expect(!again)
  }

  @Test func `a header on a connection trusted without a bypass is recorded even while an exception exists`() {
    var policy = WebKitCertificatePolicy()
    policy.allow(host: "shop.example", fingerprint: "OLD", errors: ["authorityInvalid"], now: now)
    let admitted = policy.admits(host: "shop.example", fingerprint: "OLD", errors: ["authorityInvalid"], now: now)
    #expect(admitted)
    let throughBypass = policy.noteHeader("max-age=600", host: "shop.example", fingerprint: "OLD", now: now)
    #expect(!throughBypass)
    #expect(!policy.requiresHTTPS(host: "shop.example", now: now))
    let onFixedCertificate = policy.noteHeader("max-age=600", host: "shop.example", fingerprint: "FIXED", now: now)
    #expect(onFixedCertificate)
    #expect(policy.requiresHTTPS(host: "shop.example", now: now))
  }

  @Test func `a ranged clear forgets only the hosts seen inside the range`() {
    var policy = WebKitCertificatePolicy()
    let lastWeek = now.addingTimeInterval(-7 * 86_400)
    let oldPin = policy.noteHeader("max-age=31536000", host: "bank.example", now: lastWeek)
    #expect(oldPin)
    let newPin = policy.noteHeader("max-age=31536000", host: "shop.example", now: now)
    #expect(newPin)
    policy.forget(since: now.addingTimeInterval(-3_600))
    #expect(policy.requiresHTTPS(host: "bank.example", now: now))
    #expect(!policy.requiresHTTPS(host: "shop.example", now: now))
  }

  @Test func `a ranged clear keeps hosts saved before observation times were recorded`() throws {
    let saved = try JSONDecoder().decode([String: WebKitTransportSecurity].self, from: Data(#"{"bank.example":{"expires":1900000000,"subdomains":true}}"#.utf8))
    var policy = WebKitCertificatePolicy(transportSecurity: saved)
    policy.forget(since: now.addingTimeInterval(-3_600))
    #expect(policy.requiresHTTPS(host: "login.bank.example", now: now))
  }

  @Test func `seeing a header again moves the host into a recent range`() {
    var policy = WebKitCertificatePolicy()
    let lastWeek = now.addingTimeInterval(-7 * 86_400)
    _ = policy.noteHeader("max-age=31536000", host: "bank.example", now: lastWeek)
    _ = policy.noteHeader("max-age=31536000", host: "bank.example", now: now)
    policy.forget(since: now.addingTimeInterval(-3_600))
    #expect(!policy.requiresHTTPS(host: "bank.example", now: now))
  }

  @Test func `a ranged clear forgets only certificate proceeds granted inside the range`() {
    var policy = WebKitCertificatePolicy()
    let lastWeekish = now.addingTimeInterval(-5 * 86_400)
    policy.allow(host: "old.example", fingerprint: "AA", errors: ["authorityInvalid"], now: lastWeekish)
    policy.allow(host: "new.example", fingerprint: "BB", errors: ["authorityInvalid"], now: now)
    _ = policy.admits(host: "new.example", fingerprint: "BB", errors: ["authorityInvalid"], now: now)
    policy.forget(since: now.addingTimeInterval(-3_600))
    let keptOld = policy.admits(host: "old.example", fingerprint: "AA", errors: ["authorityInvalid"], now: now)
    #expect(keptOld)
    let keptNew = policy.admits(host: "new.example", fingerprint: "BB", errors: ["authorityInvalid"], now: now)
    #expect(!keptNew)
    #expect(policy.bypassedErrors(host: "new.example", fingerprint: "BB") == nil)
  }

  @Test func `a ranged clear forgets a used proceed even after its exception expired and was pruned`() {
    var policy = WebKitCertificatePolicy()
    let granted = now.addingTimeInterval(-8 * 86_400)
    policy.allow(host: "old.example", fingerprint: "AA", errors: ["authorityInvalid"], now: granted)
    let used = policy.admits(host: "old.example", fingerprint: "AA", errors: ["authorityInvalid"], now: granted)
    #expect(used)
    let retried = policy.admits(host: "old.example", fingerprint: "AA", errors: ["authorityInvalid"], now: now)
    #expect(!retried)
    #expect(policy.exceptions["old.example"] == nil)
    #expect(policy.hasException(host: "old.example", now: now))
    policy.forget(since: now.addingTimeInterval(-28 * 86_400))
    #expect(policy.bypassedErrors(host: "old.example", fingerprint: "AA") == nil)
    #expect(!policy.hasException(host: "old.example", now: now))
    let header = policy.noteHeader("max-age=600", host: "old.example", fingerprint: "AA", now: now)
    #expect(header)
  }

  @Test func `a ranged clear keeps a used proceed granted before the range`() {
    var policy = WebKitCertificatePolicy()
    let granted = now.addingTimeInterval(-8 * 86_400)
    policy.allow(host: "old.example", fingerprint: "AA", errors: ["authorityInvalid"], now: granted)
    _ = policy.admits(host: "old.example", fingerprint: "AA", errors: ["authorityInvalid"], now: granted)
    _ = policy.admits(host: "old.example", fingerprint: "AA", errors: ["authorityInvalid"], now: now)
    policy.forget(since: now.addingTimeInterval(-3_600))
    #expect(policy.bypassedErrors(host: "old.example", fingerprint: "AA") == ["authorityInvalid"])
    #expect(policy.hasException(host: "old.example", now: now))
  }

  @Test func `clearing a recent grant keeps what an older grant for the same certificate let through`() {
    var policy = WebKitCertificatePolicy()
    let older = now.addingTimeInterval(-8 * 86_400)
    policy.allow(host: "old.example", fingerprint: "AA", errors: ["authorityInvalid"], now: older)
    _ = policy.admits(host: "old.example", fingerprint: "AA", errors: ["authorityInvalid"], now: older)
    _ = policy.admits(host: "old.example", fingerprint: "AA", errors: ["authorityInvalid"], now: now)
    policy.allow(host: "old.example", fingerprint: "AA", errors: ["authorityInvalid", "dateInvalid"], now: now)
    let regranted = policy.admits(host: "old.example", fingerprint: "AA", errors: ["authorityInvalid", "dateInvalid"], now: now)
    #expect(regranted)
    #expect(policy.bypassedErrors(host: "old.example", fingerprint: "AA") == ["authorityInvalid", "dateInvalid"])
    policy.forget(since: now.addingTimeInterval(-3_600))
    #expect(policy.bypassedErrors(host: "old.example", fingerprint: "AA") == ["authorityInvalid"])
    #expect(policy.hasException(host: "old.example", now: now))
    let current = policy.admits(host: "old.example", fingerprint: "AA", errors: ["authorityInvalid"], now: now)
    #expect(!current)
  }

  @Test func `a max-age 0 seen before the saved list could be read keeps that host out when the list is read`() {
    var policy = WebKitCertificatePolicy(awaitingSavedList: true)
    let revoked = policy.noteHeader("max-age=0", host: "bank.example", now: now)
    #expect(!revoked)
    _ = policy.noteHeader("max-age=0", host: "shop.example", now: now)
    _ = policy.noteHeader("max-age=600", host: "shop.example", now: now)
    let saved = [
      "bank.example": WebKitTransportSecurity(expires: now.timeIntervalSince1970 + 86_400, subdomains: true, observed: now.timeIntervalSince1970 - 86_400),
      "mail.example": WebKitTransportSecurity(expires: now.timeIntervalSince1970 + 86_400, subdomains: false, observed: now.timeIntervalSince1970 - 86_400),
    ]
    policy.adoptSaved(saved, now: now)
    #expect(!policy.requiresHTTPS(host: "bank.example", now: now))
    #expect(policy.requiresHTTPS(host: "mail.example", now: now))
    #expect(policy.requiresHTTPS(host: "shop.example", now: now))
    #expect(!policy.awaitingSavedList)
    #expect(policy.supersededBeforeSavedList.isEmpty)
  }

  @Test func `a host revoked before the saved list was read stays revoked after it was seen again and cleared`() {
    var policy = WebKitCertificatePolicy(awaitingSavedList: true)
    _ = policy.noteHeader("max-age=0", host: "bank.example", now: now)
    _ = policy.noteHeader("max-age=600", host: "bank.example", now: now)
    #expect(policy.supersededBeforeSavedList == ["bank.example"])
    policy.forget(since: now.addingTimeInterval(-3_600))
    let saved = ["bank.example": WebKitTransportSecurity(expires: now.timeIntervalSince1970 + 86_400, subdomains: true, observed: now.timeIntervalSince1970 - 7 * 86_400)]
    policy.adoptSaved(saved, now: now, clearingSince: now.addingTimeInterval(-3_600))
    #expect(!policy.requiresHTTPS(host: "bank.example", now: now))
  }

  @Test func `a host seen again after its revocation keeps the newer entry when the saved list is read`() {
    var policy = WebKitCertificatePolicy(awaitingSavedList: true)
    _ = policy.noteHeader("max-age=0", host: "bank.example", now: now)
    _ = policy.noteHeader("max-age=600", host: "bank.example", now: now)
    let saved = ["bank.example": WebKitTransportSecurity(expires: now.timeIntervalSince1970 + 86_400, subdomains: true, observed: now.timeIntervalSince1970 - 7 * 86_400)]
    policy.adoptSaved(saved, now: now)
    #expect(policy.transportSecurity["bank.example"]?.expires == now.timeIntervalSince1970 + 600)
    #expect(!policy.requiresHTTPS(host: "login.bank.example", now: now))
  }

  @Test func `a ranged clear while reading a full saved list never evicts an older host for a cleared one`() {
    var policy = WebKitCertificatePolicy(awaitingSavedList: true)
    _ = policy.noteHeader("max-age=31536000", host: "recent.example", now: now)
    let older = now.timeIntervalSince1970 - 7 * 86_400
    let saved = Dictionary(uniqueKeysWithValues: (0..<WebKitCertificatePolicy.dynamicHostLimit).map {
      ("h\($0).example", WebKitTransportSecurity(expires: now.timeIntervalSince1970 + 86_400, subdomains: false, observed: older))
    })
    policy.adoptSaved(saved, now: now, clearingSince: now.addingTimeInterval(-3_600))
    #expect(policy.transportSecurity.count == WebKitCertificatePolicy.dynamicHostLimit)
    #expect(Set(policy.transportSecurity.keys) == Set(saved.keys))
  }

  @Test func `a host updated before the saved list was read keeps its older saved entry out after the update is cleared`() {
    var policy = WebKitCertificatePolicy(awaitingSavedList: true)
    _ = policy.noteHeader("max-age=600", host: "bank.example", now: now)
    #expect(policy.supersededBeforeSavedList == ["bank.example"])
    policy.forget(since: now.addingTimeInterval(-3_600))
    let saved = [
      "bank.example": WebKitTransportSecurity(expires: now.timeIntervalSince1970 + 86_400, subdomains: true, observed: now.timeIntervalSince1970 - 7 * 86_400),
      "mail.example": WebKitTransportSecurity(expires: now.timeIntervalSince1970 + 86_400, subdomains: false, observed: now.timeIntervalSince1970 - 7 * 86_400),
    ]
    policy.adoptSaved(saved, now: now, clearingSince: now.addingTimeInterval(-3_600))
    #expect(!policy.requiresHTTPS(host: "bank.example", now: now))
    #expect(policy.requiresHTTPS(host: "mail.example", now: now))
  }

  @Test func `a policy loaded from its saved list records no revocations`() {
    var policy = WebKitCertificatePolicy()
    _ = policy.noteHeader("max-age=0", host: "bank.example", now: now)
    #expect(policy.supersededBeforeSavedList.isEmpty)
  }

  @Test func `max-age 0 removes the host and entries expire`() {
    var policy = WebKitCertificatePolicy()
    _ = policy.noteHeader("max-age=600", host: "a.example", now: now)
    #expect(!policy.requiresHTTPS(host: "a.example", now: now.addingTimeInterval(601)))
    _ = policy.noteHeader("max-age=600", host: "a.example", now: now)
    let result12 = policy.noteHeader("max-age=0", host: "a.example", now: now)
    #expect(result12)
    #expect(!policy.requiresHTTPS(host: "a.example", now: now))
  }

  @Test(arguments: ["", "includeSubDomains", "max-age", "max-age=abc", "max-age=-5", "max-age=5; max-age=6", "max-age=5; includeSubDomains=1"])
  func `malformed headers are ignored`(header: String) {
    var policy = WebKitCertificatePolicy()
    let result13 = policy.noteHeader(header, host: "a.example", now: now)
    #expect(!result13)
    #expect(!policy.requiresHTTPS(host: "a.example", now: now))
  }

  @Test func `a quoted max-age counts and is capped at a year`() {
    let parsed = WebKitCertificatePolicy.parse("max-age=\"99999999999\"")
    #expect(parsed?.maxAge == WebKitCertificatePolicy.maxAgeLimit)
  }

  @Test func `saved entries survive a reload and expired ones are dropped`() {
    var policy = WebKitCertificatePolicy()
    _ = policy.noteHeader("max-age=600", host: "short.example", now: now)
    _ = policy.noteHeader("max-age=86400; includeSubDomains", host: "long.example", now: now)
    let saved = policy.savedTransportSecurity(now: now.addingTimeInterval(700))
    #expect(saved.keys.sorted() == ["long.example"])
    let reloaded = WebKitCertificatePolicy(transportSecurity: saved)
    #expect(reloaded.requiresHTTPS(host: "www.long.example", now: now.addingTimeInterval(700)))
  }

  @Test func `the list keeps the hosts that expire last when it is full`() {
    var policy = WebKitCertificatePolicy()
    for index in 0...WebKitCertificatePolicy.dynamicHostLimit {
      _ = policy.noteHeader("max-age=\(1000 + index)", host: "h\(index).example", now: now)
    }
    #expect(policy.transportSecurity.count == WebKitCertificatePolicy.dynamicHostLimit)
    #expect(!policy.requiresHTTPS(host: "h0.example", now: now))
    #expect(policy.requiresHTTPS(host: "h\(WebKitCertificatePolicy.dynamicHostLimit).example", now: now))
  }
}
