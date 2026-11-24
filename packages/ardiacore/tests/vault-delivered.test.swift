import Foundation
import Testing

private let timingBudgets = ProcessInfo.processInfo.environment["ARDIA_PERF_BUDGETS"] == "1"

private func code(_ text: String, sender: String = "+15550100", source: VaultDeliveredSource = .messages) -> String? {
  VaultDeliveredExtractor.extract(text, sender: sender, source: source)?.code
}

@Suite("Codes in messages")
struct VaultDeliveredExtractionTests {
  @Test("Finds the code in real-world shapes", arguments: [
    ("Your Example verification code is 482913.", "482913"),
    ("482913 is your Instagram code. Don't share it.", "482913"),
    ("[Amazon] 482913 is your one-time password. Do not share it with anyone.", "482913"),
    ("G-482913 is your Google verification code.", "482913"),
    ("Your WhatsApp code: 482-913\nYou can also tap this link to verify your phone: v.whatsapp.com/482913", "482913"),
    ("Your Uber code: 4829. Never share this code. Reply STOP ASAP to 89203 to unsubscribe.", "4829"),
    ("BofA: Your code is 482913. Call 800-432-1000 if you didn't request it.", "482913"),
    ("Use 482 913 to sign in to Example. It expires in 10 minutes.", "482913"),
    ("Your one-time code is 482913 for a purchase of USD 49.99 at SHOP.", "482913"),
    ("Your security code is A7K2Q9", "A7K2Q9"),
    ("PayPal: Your security code is: 482913. Your code expires in 10 minutes. Please don't reply.", "482913"),
    ("Dear customer, your OTP is 48291376. Valid for 5 minutes.", "48291376"),
    ("Your Microsoft account phone verification code is 4829", "4829"),
    ("Votre code de vérification est 482913", "482913"),
    ("Ihr Bestätigungscode lautet 482913", "482913"),
    ("Tu código de verificación es 482913", "482913"),
    ("O seu código de verificação é 482913", "482913"),
    ("Il tuo codice di verifica è 482913", "482913"),
    ("Je verificatiecode is 482913", "482913"),
    ("Din engångskod är 482913", "482913"),
    ("Twój kod weryfikacyjny to 482913", "482913"),
    ("Ваш код подтверждения: 482913", "482913"),
    ("您的验证码是482913，5分钟内有效。", "482913"),
    ("認証コード：482913", "482913"),
    ("인증번호 [482913]을 입력해주세요", "482913"),
    ("Doğrulama kodunuz 482913", "482913"),
    ("Your code is ４８２９１３", "482913"),
    ("Your verification code is 2023", "2023"),
  ])
  func finds(text: String, expected: String) {
    #expect(code(text) == expected)
  }

  @Test("Refuses numbers that are not codes", arguments: [
    "Your order #482913 has shipped.",
    "Your package with tracking code 1Z999AA10123456784 is on its way.",
    "Call us at 555-123-4567 to get your code.",
    "Your code balance is $4829.13",
    "Use code SAVE20 for 20% off your next order",
    "Promo code 482913 gets you 10% off",
    "Your appointment on 11/23/2026 at 10:30. Confirmation code: 4829",
    "Your flight booking code is K7X9QZ",
    "Your code expires at 10:30 on 2026-11-23",
    "Hi! See you at 4829 Main Street tomorrow.",
    "Meeting moved to room 4829, bring the code",
    "Your verification code is ready. Ref 482913.",
    "Login from 192.168.10.24 detected. Code reset.",
    "Here is the code: https://example.com/verify?token=482913",
    "Your verification code was sent in 2019 to card ending in 4829",
    "Code 1234 5678 9012",
    "Your account security code: XXXX1234",
    "Your code worth 500 points: 482913pts",
    "Thanks for your order! Order number 48291376",
    "Reply 1234 to confirm",
    "Your account number is 48291376. Your code is in the app.",
    "Customer 482913: your code is on its way",
    "Invoice 482913 is ready, code attached",
    "Ticket 4829 opened. We will send a code",
    "Member ID 48291376 verification pending",
    "Your code is ready. Order 482913",
    "Your PIN reminder: we will never ask for it. Call 4829 for help",
    "PIN changed on 4829",
    "",
    "482913",
  ])
  func refuses(text: String) {
    #expect(code(text) == nil)
  }

  @Test func `a domain-bound last line binds the code and wins over the text`() throws {
    let found = try #require(VaultDeliveredExtractor.extract("Your Example code is 482913.\n\n@example.com #482913", sender: "+15550100", source: .messages))
    #expect(found.code == "482913")
    #expect(found.boundDomain == "example.com")
    #expect(found.iframeDomain == nil)
    #expect(found.site == "example.com")
  }

  @Test func `an iframe domain after a percent or a second at sign is kept`() throws {
    let apple = try #require(VaultDeliveredExtractor.extract("123456 is your code\n@shop.example #123456 %pay.example.org", sender: "", source: .messages))
    #expect(apple.boundDomain == "shop.example")
    #expect(apple.iframeDomain == "pay.example.org")
    #expect(VaultDeliveredExtractor.extract("@login.bank.com #A1B2C3 @widget.bank-pay.com", sender: "", source: .messages) == nil)
  }

  @Test func `mail never yields a bound code, whatever its last line says`() {
    let mail = VaultDeliveredExtractor.extract("Your Bank code is 482913\n@bank.com #482913", sender: "security@evil.com", source: .mail)
    #expect(mail?.bound != true)
    #expect(mail?.boundDomain == nil)
    #expect(mail?.site != "bank.com")
  }

  @Test func `a personal sender needs a message that reads as automated`() {
    #expect(code("My locker code is 4829", sender: "+1 (555) 010-0199") == nil)
    #expect(code("the gate code is 4829", sender: "friend@gmail.com", source: .mail) == nil)
    #expect(code("Your Example code is 482913. Don't share it.", sender: "+1 (555) 010-0199") == "482913")
    #expect(code("Your verification code is 482913", sender: "+15550100199") == "482913")
    #expect(code("My locker code is 4829", sender: "72975") == "4829")
  }

  @Test func `hostile messages are bounded work`() {
    let shapes = [
      "code " + String(repeating: "!1234", count: 1700), String(repeating: "code ", count: 1700), "code " + String(repeating: "1234 ", count: 1700),
      String(repeating: "verification 482913 order ", count: 320), "code " + String(repeating: "é", count: 8000), "验证码" + String(repeating: "码1", count: 4000),
      "code " + String(repeating: "a", count: 8000) + " 482913", "code " + String(repeating: "AB12CD ", count: 1200),
      "code " + String(repeating: "x/", count: 4000) + " 482913", String(repeating: "\u{202E}code 12\u{2028}", count: 900),
    ]
    let clock = ContinuousClock()
    for shape in shapes {
      let text = String(shape.prefix(8192))
      let took = clock.measure { _ = VaultDeliveredExtractor.extract(text, sender: "+15550100", source: .messages) }
      #expect(took < .seconds(2), "\(text.prefix(24)) took \(took)")
      if timingBudgets { #expect(took < .milliseconds(50), "\(text.prefix(24)) took \(took)") }
    }
  }

  @Test("A broken domain-bound line yields nothing", arguments: [
    "Your code is 482913\n@ #482913", "Your code is 482913\n@example #482913", "Your code is 482913\n@127.0.0.1 #482913",
    "Your code is 482913\n@example.com #48", "Your code is 482913\n@example.com #482913 extra words", "Your code is 482913\n@exa_mple.com #482913",
    "Your code is 482913\n@example.com #482913 %", "Your code is 482913\n@ex\u{202E}ample.com #482913", "Your code is 482913\n@com #482913",
    "Your code is 482913\n@example.com #4829<13",
  ])
  func brokenBound(text: String) {
    #expect(VaultDeliveredExtractor.extract(text, sender: "", source: .messages) == nil)
  }

  @Test func `a handle on the last line is not a bound attempt`() {
    #expect(code("Your Example code is 482913\n@examplesupport thanks") == "482913")
  }

  @Test func `mail takes its site from the sender unless the sender is a mailbox provider`() {
    let bank = VaultDeliveredExtractor.extract("Your sign-in code\nUse 615273 to sign in.", sender: "no-reply@accounts.bank.co.uk", source: .mail)
    #expect(bank?.site == "bank.co.uk")
    #expect(bank?.bound == false)
    let personal = VaultDeliveredExtractor.extract("Your code is 615273", sender: "friend@gmail.com", source: .mail)
    #expect(personal?.site == nil)
  }

  @Test func `a text names its site when exactly one domain appears`() {
    #expect(VaultDeliveredExtractor.extract("Your example.com code is 482913", sender: "+1", source: .messages)?.site == "example.com")
    #expect(VaultDeliveredExtractor.extract("Your code is 482913. Visit https://help.example.com/x", sender: "+1", source: .messages)?.site == "example.com")
    #expect(VaultDeliveredExtractor.extract("Your code is 482913 for a.com or b.org", sender: "+1", source: .messages)?.site == nil)
  }

  @Test func `hostile values never crash and only ever yield a short ASCII code`() {
    for (id, value) in hostileInputs() {
      for wrapped in [value, "Your code is 482913 \(value)", "\(value)\n@example.com #482913", "Your verification code is \(value)"] {
        if let found = VaultDeliveredExtractor.extract(wrapped, sender: value, source: .mail) {
          #expect((4...10).contains(found.code.count), "\(id)")
          #expect(found.code.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) }, "\(id)")
        }
      }
      let sender = VaultDeliveredExtractor.cleanedSender(value)
      #expect(sender.unicodeScalars.count <= VaultDeliveredExtractor.longestSender, "\(id)")
      #expect(!sender.unicodeScalars.contains { [.control, .format, .lineSeparator, .paragraphSeparator].contains($0.properties.generalCategory) }, "\(id)")
    }
  }

  @Test func `a very long message is read only up to its limit`() {
    let filler = String(repeating: "lorem ipsum ", count: 2000)
    #expect(code(filler + "Your code is 482913") == nil)
    #expect(code("Your code is 482913 " + filler) == "482913")
  }

  private func hostileInputs() -> [(String, String)] {
    guard let json = ProcessInfo.processInfo.environment["ARDIA_HOSTILE_INPUTS"], let pairs = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [[String]]
    else { return [("rtl", "a\u{202E}b"), ("nul", "a\u{0}b"), ("crlf", "a\r\nb"), ("long", String(repeating: "9", count: 100_000))] }
    return pairs.compactMap { $0.count == 2 ? ($0[0], $0[1]) : nil }
  }
}

@Suite("Where a delivered code may fill")
struct VaultDeliveredOriginTests {
  private func entry(bound: String?, iframe: String? = nil) -> VaultDeliveredCode {
    VaultDeliveredCode(
      id: "delivered.x", source: .messages, sender: "+1", site: bound, boundDomain: bound, iframeDomain: iframe, code: "482913", receivedAt: Date(),
      expiresAt: Date().addingTimeInterval(300), messageKey: "messages/1")
  }

  @Test("A code bound to bank.com fills on bank.com and its subdomains", arguments: [
    "https://bank.com", "https://www.bank.com", "https://login.bank.com", "https://bank.com:8443",
  ])
  func boundFills(origin: String) {
    #expect(entry(bound: "bank.com").fills(frame: origin, top: origin, userChose: false))
  }

  @Test("A code bound to bank.com never fills elsewhere, even when chosen", arguments: [
    "https://bank-login.evil.com", "https://evil.com", "https://bank.com.evil.com", "https://evilbank.com", "https://bank.co",
    "https://xn--bnk-sla.com", "https://evil.com/bank.com", "https://evil.com?bank.com", "https://bank.com@evil.com", "not a url", "",
  ])
  func boundRefuses(origin: String) {
    #expect(!entry(bound: "bank.com").fills(frame: origin, top: origin, userChose: true))
  }

  @Test func `an iframe code fills its iframe only inside the bound top-level site`() {
    let code = entry(bound: "shop.example.com", iframe: "pay.example.org")
    #expect(code.fills(frame: "https://pay.example.org", top: "https://shop.example.com", userChose: false))
    #expect(code.fills(frame: "https://example.com", top: "https://example.com", userChose: false))
    #expect(!code.fills(frame: "https://pay.example.org", top: "https://evil.com", userChose: true))
    #expect(!code.fills(frame: "https://pay.example.org", top: "https://pay.example.org", userChose: true))
    #expect(!code.fills(frame: "https://example.net", top: "https://example.com", userChose: true))
  }

  @Test func `a bound code needs a known top-level origin of its own site`() {
    let code = entry(bound: "bank.com")
    #expect(!code.fills(frame: "https://bank.com", top: nil, userChose: true))
    #expect(!code.fills(frame: "https://bank.com", top: "https://evil.com", userChose: true))
    #expect(code.fills(frame: "https://login.bank.com", top: "https://www.bank.com", userChose: false))
  }

  @Test func `a bound code on a multi-part suffix compares the registrable domain`() {
    #expect(entry(bound: "login.bank.co.uk").fills(frame: "https://www.bank.co.uk", top: "https://www.bank.co.uk", userChose: false))
    #expect(!entry(bound: "login.bank.co.uk").fills(frame: "https://other.co.uk", top: "https://other.co.uk", userChose: true))
  }

  @Test func `an unbound code fills only when the person chose it`() {
    #expect(entry(bound: nil).fills(frame: "https://anything.example", top: nil, userChose: true))
    #expect(!entry(bound: nil).fills(frame: "https://anything.example", top: "https://anything.example", userChose: false))
  }
}

final class DeliveredClock: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Date
  private var pending: [VaultDeliveredRead]
  private var states: [VaultDeliveredState] = []

  init(_ start: Date, reads: [VaultDeliveredRead] = []) {
    value = start
    pending = reads
  }

  var now: Date { lock.withLock { value } }
  var announced: [VaultDeliveredState] { lock.withLock { states } }
  func advance(_ seconds: TimeInterval) { lock.withLock { value = value.addingTimeInterval(seconds) } }
  func serve(_ reads: [VaultDeliveredRead]) { lock.withLock { pending = reads } }
  func reads() -> [VaultDeliveredRead] { lock.withLock { pending } }
  func record(_ state: VaultDeliveredState) { lock.withLock { states.append(state) } }
  func store(enabled: Bool = true) async -> VaultDeliveredCodes {
    let store = VaultDeliveredCodes(
      paths: VaultDeliveredPaths(messages: nil, mailEnvelope: nil, mailRoot: nil),
      hooks: VaultDeliveredHooks(now: { self.now }, announce: { self.record($0) }, read: { _, _ in self.reads() }, watches: false))
    if enabled { _ = await store.setEnabled(true) }
    return store
  }
}

private func text(_ key: Int, _ body: String, at date: Date, sender: String = "+15550100") -> VaultDeliveredMessage {
  VaultDeliveredMessage(source: .messages, key: "messages/\(key)", sender: sender, text: body, receivedAt: date)
}

@Suite("The delivered code store")
struct VaultDeliveredStoreTests {
  let start = Date(timeIntervalSince1970: 1_800_000_000)

  @Test func `a code is offered until ten minutes after it arrived, then dropped`() async throws {
    let clock = DeliveredClock(start, reads: [VaultDeliveredRead(reach: .readable, messages: [text(1, "Your code is 482913", at: start)], watched: [])])
    let store = await clock.store()
    let first = await store.state(rescan: true)
    #expect(first.access == .on)
    let row = try #require(first.codes.first)
    #expect(row.id.hasPrefix("delivered."))
    #expect(row.expiresAt == (start.timeIntervalSince1970 + 300) * 1000)
    #expect(!row.jsonObject().keys.contains("code"))
    #expect(await store.totp(id: row.id)?.code == "482913")
    #expect(await store.totp(id: row.id)?.period == 300)
    clock.advance(299)
    #expect(await store.state(rescan: false).codes.count == 1)
    clock.advance(2)
    #expect(await store.state(rescan: false).codes.isEmpty)
    #expect(await store.totp(id: row.id) == nil)
    #expect(clock.announced.last?.codes.isEmpty == true)
  }

  @Test func `a filled code is removed and is not offered again by the next scan`() async throws {
    let clock = DeliveredClock(start, reads: [VaultDeliveredRead(reach: .readable, messages: [text(1, "Your code is 482913", at: start)], watched: [])])
    let store = await clock.store()
    let id = try #require(await store.state(rescan: true).codes.first?.id)
    #expect(await store.fillCode(id: id, fields: ["totp"], origin: "https://example.com", top: nil, userChose: true) == .success("482913"))
    await store.filled(id: id)
    clock.advance(3)
    #expect(await store.state(rescan: true).codes.isEmpty)
    #expect(await store.fillCode(id: id, fields: ["totp"], origin: "https://example.com", top: nil, userChose: true) == .failure(.notFound))
  }

  @Test func `fill refuses insecure pages, other fields and off-site bound codes`() async throws {
    let bound = text(1, "Your code is 482913\n@bank.com #482913", at: start)
    let clock = DeliveredClock(start, reads: [VaultDeliveredRead(reach: .readable, messages: [bound], watched: [])])
    let store = await clock.store()
    let row = try #require(await store.state(rescan: true).codes.first)
    #expect(row.bound && row.site == "bank.com")
    #expect(await store.fillCode(id: row.id, fields: ["otp"], origin: "http://bank.com", top: "http://bank.com", userChose: true) == .failure(.insecure))
    #expect(await store.fillCode(id: row.id, fields: ["password"], origin: "https://bank.com", top: "https://bank.com", userChose: true) == .failure(.notFound))
    #expect(await store.fillCode(id: row.id, fields: ["otp"], origin: "https://bank-login.evil.com", top: "https://bank-login.evil.com", userChose: true) == .failure(.originMismatch))
    #expect(await store.fillCode(id: row.id, fields: ["otp"], origin: "https://login.bank.com", top: "https://bank.com", userChose: false) == .success("482913"))
  }

  @Test func `an unbound code needs the person to choose it`() async throws {
    let clock = DeliveredClock(start, reads: [VaultDeliveredRead(reach: .readable, messages: [text(1, "Your code is 482913", at: start)], watched: [])])
    let store = await clock.store()
    let id = try #require(await store.state(rescan: true).codes.first?.id)
    #expect(await store.fillCode(id: id, fields: ["otp"], origin: "https://example.com", top: nil, userChose: false) == .failure(.originMismatch))
  }

  @Test func `old messages, repeats and non-codes are skipped, newest first`() async {
    let messages = [
      text(1, "Your code is 111111", at: start.addingTimeInterval(-700)), text(2, "Your code is 222222", at: start.addingTimeInterval(-60)),
      text(3, "Your code is 222222", at: start.addingTimeInterval(-30)), text(4, "See you at 5", at: start),
      text(5, "Your code is 333333", at: start.addingTimeInterval(-10)),
    ]
    let clock = DeliveredClock(start, reads: [VaultDeliveredRead(reach: .readable, messages: messages, watched: [])])
    let state = await clock.store().state(rescan: true)
    #expect(state.codes.count == 2)
    #expect(state.codes.map(\.receivedAt) == [start.addingTimeInterval(-10), start.addingTimeInterval(-60)].map { $0.timeIntervalSince1970 * 1000 })
  }

  @Test func `a denied source asks for access and turning off forgets everything`() async throws {
    let clock = DeliveredClock(start, reads: [.denied, VaultDeliveredRead(reach: .readable, messages: [text(1, "Your code is 482913", at: start)], watched: [])])
    let store = await clock.store(enabled: false)
    #expect(await store.state(rescan: true) == VaultDeliveredState(access: .off, codes: []))
    let on = await store.setEnabled(true)
    #expect(on.access == .needsAccess)
    #expect(on.codes.count == 1)
    let off = await store.setEnabled(false)
    #expect(off == VaultDeliveredState(access: .off, codes: []))
    #expect(clock.announced.last == off)
    clock.serve([.missing])
    #expect(await store.setEnabled(true).access == .on)
  }

  @Test func `a scan within two seconds of the last is not repeated`() async {
    let clock = DeliveredClock(start)
    let store = await clock.store()
    _ = await store.state(rescan: true)
    clock.serve([VaultDeliveredRead(reach: .readable, messages: [text(1, "Your code is 482913", at: start)], watched: [])])
    clock.advance(1)
    #expect(await store.state(rescan: true).codes.isEmpty)
    clock.advance(1.5)
    #expect(await store.state(rescan: true).codes.count == 1)
  }
}

@Suite("Reading Messages and Mail", .serialized)
struct VaultDeliveredReaderTests {
  let folder: String

  init() throws {
    folder = NSTemporaryDirectory() + "ardia-delivered-" + UUID().uuidString
    try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
  }

  @Test func `messages are read from text or attributedBody, recent and received only`() throws {
    let path = folder + "/chat.db"
    let now = Date()
    try VaultDeliveredFixtures.writeMessages(path, [
      VaultDeliveredFixtureText(sender: "+15550100", secondsAgo: 5, text: "Your code is 482913"),
      VaultDeliveredFixtureText(sender: "+15550101", secondsAgo: 20, text: "Код 731904 é \u{1F600}", attributed: true),
      VaultDeliveredFixtureText(sender: "+15550102", secondsAgo: 30, text: "Your code is 615273", fromMe: true),
      VaultDeliveredFixtureText(sender: "+15550103", secondsAgo: 900, text: "Your code is 999999"),
    ], now: now)
    let read = VaultMessagesReader.read(path, since: Date().addingTimeInterval(-600))
    #expect(read.reach == .readable)
    #expect(read.messages.map(\.text) == ["Your code is 482913", "Код 731904 é \u{1F600}"])
    #expect(read.messages.map(\.sender) == ["+15550100", "+15550101"])
    #expect(read.watched == [path, path + "-wal"])
    #expect(abs(read.messages[0].receivedAt.timeIntervalSince(now) + 5) < 0.001)
  }

  @Test func `mail reads subject and summary from the newest Envelope Index and skips deleted mail`() throws {
    let root = folder + "/Mail"
    try VaultDeliveredFixtures.writeMail(root + "/V9/MailData/Envelope Index", [VaultDeliveredFixtureMail(sender: "old@example.com", secondsAgo: 5, subject: "Old", summary: "")])
    let newest = root + "/V10/MailData/Envelope Index"
    try VaultDeliveredFixtures.writeMail(newest, [
      VaultDeliveredFixtureMail(sender: "noreply@example.com", secondsAgo: 10, subject: "Your sign-in code", summary: "Use 615273 to sign in."),
      VaultDeliveredFixtureMail(sender: "noreply@example.com", secondsAgo: 15, subject: "Gone", summary: "Use 111111", deleted: true),
      VaultDeliveredFixtureMail(sender: "noreply@example.com", secondsAgo: 1200, subject: "Late", summary: "Use 222222"),
      VaultDeliveredFixtureMail(sender: "noreply@example.com", secondsAgo: 12, subject: "Junk", summary: "Use 333333", mailbox: "imap://a%40b.com@imap.b.com/Junk"),
      VaultDeliveredFixtureMail(sender: "noreply@example.com", secondsAgo: 13, subject: "Spam", summary: "Use 444444", mailbox: "imap://a@b/%5BGmail%5D/Spam"),
      VaultDeliveredFixtureMail(sender: "noreply@example.com", secondsAgo: 14, subject: "Bin", summary: "Use 555555", mailbox: "local:///Deleted%20Messages/"),
    ])
    let found = VaultMailReader.envelope(root: root)
    #expect(found.path == newest)
    let read = VaultMailReader.read(newest, since: Date().addingTimeInterval(-600))
    #expect(read.messages.map(\.text) == ["Your sign-in code\nUse 615273 to sign in."])
    #expect(read.messages.first?.sender == "noreply@example.com")
    let all = VaultDeliveredCodes.readAll(VaultDeliveredPaths(messages: folder + "/none.db", mailEnvelope: nil, mailRoot: root), since: Date().addingTimeInterval(-600))
    #expect(all.map(\.reach) == [.missing, .readable])
  }

  @Test("Junk, spam and deleted mailboxes are skipped", arguments: [
    ("imap://a@b/INBOX", true), ("ews://x/Inbox", true), ("imap://a@b/Work/Codes", true), ("imap://a@b/Junk", false), ("imap://a@b/Junk%20E-mail", false),
    ("imap://a@b/%5BGmail%5D/Spam", false), ("imap://a@b/Trash/", false), ("local:///Deleted%20Items", false), ("imap://a@b/Bin", false), ("", false),
  ])
  func mailboxes(url: String, kept: Bool) {
    #expect(VaultMailReader.isInbox(url) == kept)
  }

  @Test func `the readers never write to the databases`() throws {
    let path = folder + "/chat.db"
    try VaultDeliveredFixtures.writeMessages(path, [VaultDeliveredFixtureText(sender: "+1", secondsAgo: 1, text: "Your code is 482913")])
    let before = try FileManager.default.attributesOfItem(atPath: path)[.modificationDate] as? Date
    let size = try FileManager.default.attributesOfItem(atPath: path)[.size] as? Int
    for _ in 0..<3 { _ = VaultMessagesReader.read(path, since: Date().addingTimeInterval(-600)) }
    #expect(try FileManager.default.attributesOfItem(atPath: path)[.modificationDate] as? Date == before)
    #expect(try FileManager.default.attributesOfItem(atPath: path)[.size] as? Int == size)
  }

  @Test func `an unreadable file or folder reads as needing access, an absent one as missing`() throws {
    let locked = folder + "/locked.db"
    try VaultDeliveredFixtures.writeMessages(locked, [])
    try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: locked)
    defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: locked) }
    #expect(VaultMessagesReader.read(locked, since: Date()).reach == .denied)
    #expect(VaultMessagesReader.read(folder + "/absent.db", since: Date()).reach == .missing)
    let lockedRoot = folder + "/LockedMail"
    try FileManager.default.createDirectory(atPath: lockedRoot, withIntermediateDirectories: true)
    try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: lockedRoot)
    defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: lockedRoot) }
    #expect(VaultMailReader.envelope(root: lockedRoot).reach == .denied)
    #expect(VaultMailReader.envelope(root: folder + "/NoMail").reach == .missing)
  }

  @Test func `a database with an unfamiliar schema reads as nothing`() throws {
    let path = folder + "/odd.db"
    try VaultDeliveredFixtures.writeMail(path, [])
    let read = VaultMessagesReader.read(path, since: Date())
    #expect(read.reach == .readable && read.messages.isEmpty)
  }

  @Test func `typedstream text decodes what NSArchiver wrote and refuses broken archives`() {
    for sample in ["Your code is 482913", String(repeating: "é", count: 300) + " 731904", String(repeating: "x", count: 70_000)] {
      #expect(VaultTypedStreamText.text(VaultDeliveredFixtures.attributedBody(sample)) == sample)
    }
    let good = VaultDeliveredFixtures.attributedBody("Your code is 482913")
    #expect(VaultTypedStreamText.text(Data()) == nil)
    #expect(VaultTypedStreamText.text(Data("not an archive at all".utf8)) == nil)
    #expect(VaultTypedStreamText.text(good.prefix(126)) == nil)
    var lying = [UInt8](good)
    if let plus = lying.indices.dropFirst(100).first(where: { lying[$0] == 0x2B }) { lying.replaceSubrange((plus + 1)...(plus + 5), with: [0x82, 0xFF, 0xFF, 0xFF, 0x7F]) }
    #expect(VaultTypedStreamText.text(Data(lying)) == nil)
  }
}
