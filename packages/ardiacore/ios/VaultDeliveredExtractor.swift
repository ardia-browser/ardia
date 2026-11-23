import Foundation

enum VaultDeliveredSource: String, Sendable {
  case messages
  case mail
}

struct VaultDeliveredExtraction: Equatable, Sendable {
  var code: String
  var boundDomain: String?
  var iframeDomain: String?
  var site: String?

  var bound: Bool { boundDomain != nil }
}

enum VaultDeliveredExtractor {
  static let longestText = 8192
  static let scannedText = 2048
  static let strongReach = 48
  static let codeReach = 32
  static let weakReach = 8
  static let refusalTouch = 4
  static let lettersReach = 30
  static let yearReach = 12
  static let refusalReach = 48
  static let mostSpots = 64
  static let mostCandidates = 32
  static let window = 80
  static let longestSender = 120

  private enum Edge {
    case word
    case compound
    case anywhere
  }

  private struct Term {
    let folded: [Character]
    let edge: Edge
    let reach: Int
  }

  private struct Spot {
    let range: Range<Int>
    let reach: Int
  }

  private static let strongWords = [
    "otp", "2fa", "mfa", "passcode", "one-time", "one time", "two-factor", "verify", "verification", "authentication", "sign-in", "sign in",
    "log in", "login", "security code", "senha", "clave", "verifica", "einmalpasswort", "mot de passe", "verificacion", "verificacao",
    "verificatie", "weryfikacyjny", "пароль", "kennwort", "sifre", "ओटीपी",
  ]

  private static let strongAnywhere = [
    "验证码", "驗證碼", "校验码", "動態碼", "动态码", "认证码", "認証コード", "確認コード", "ワンタイム", "パスコード", "인증번호", "인증 번호", "인증코드", "인증 코드",
    "bestatigung", "sicherheitscode", "verifizierung", "engangskod", "verifieringskod", "dogrulama", "التحقق",
  ]

  private static let keywords: [Term] =
    terms(strongWords, .word, strongReach) + terms(strongAnywhere, .anywhere, strongReach)
    + terms(["kod", "kodu", "код", "codice", "קוד", "رمز", "कोड", "security"], .word, codeReach)
    + terms(["code", "codes", "codigo", "kode", "koden", "kodun", "kodas"], .compound, codeReach)
    + terms(["pin", "tan"], .word, weakReach)

  private static let automation: [Term] =
    terms(strongWords, .word, 0) + terms(strongAnywhere, .anywhere, 0)
    + terms([
      "do not share", "don't share", "dont share", "never share", "not share", "expire", "expires", "valid for", "ne le partagez",
      "nicht weiter", "no compartas", "no lo compartas", "nao compartilhe", "non condividere", "请勿", "不要告诉", "有効期限", "타인에게",
    ], .anywhere, 0)

  private static let nearbyRefusals: [Term] = terms([
    "order", "tracking", "track", "invoice", "receipt", "ref", "reference", "account", "acct", "ending in", "ends in", "promo", "coupon",
    "discount", "voucher", "referral", "zip", "postal", "postcode", "barcode", "gate", "seat", "room", "ext", "extension", "ticket", "tel",
    "call", "fax", "reply", "stop", "pedido", "bestellung", "commande", "member", "customer", "flight", "booking",
  ], .word, 0) + terms(["订单", "注文"], .anywhere, 0)

  private static let messageRefusals: [Term] = terms([
    "appointment", "reservation", "booking", "itinerary", "flight", "shipped", "tracking", "delivery", "parcel", "promo", "coupon",
    "discount", "voucher", "unsubscribe from our", "gift card", "off your", "sale",
  ], .word, 0) + terms(["% off"], .anywhere, 0)

  private static let currencyWords: Set<String> = [
    "usd", "eur", "gbp", "jpy", "inr", "cad", "aud", "chf", "cny", "rmb", "rub", "brl", "mxn", "krw", "sek", "nok", "dkk", "pln", "try", "zar",
    "hkd", "sgd", "nzd", "rs", "kr", "zl",
  ]

  private static let unitWords: Set<String> = [
    "am", "pm", "min", "mins", "minute", "minutes", "h", "hr", "hrs", "hour", "hours", "sec", "secs", "second", "seconds", "day", "days", "gb", "mb",
    "kb", "km", "kg", "mi", "lb", "lbs", "points", "pts", "miles", "steps", "kcal", "ms", "m",
  ]

  static let genericMailDomains: Set<String> = [
    "gmail.com", "googlemail.com", "icloud.com", "me.com", "mac.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com",
    "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.de", "gmx.net", "web.de", "mail.com", "yandex.ru", "qq.com",
    "163.com", "126.com", "naver.com", "fastmail.com", "hey.com", "zoho.com", "tutanota.com",
  ]

  static func extract(_ text: String, sender: String, source: VaultDeliveredSource) -> VaultDeliveredExtraction? {
    VaultOffMain.check()
    let clipped = String(text.prefix(longestText))
    if source == .messages, let bound = boundAttempt(clipped) { return bound.value }
    let scanned = String(clipped.prefix(scannedText))
    guard let code = looseCode(scanned, personal: isPersonal(sender, source: source)) else { return nil }
    return VaultDeliveredExtraction(code: code, boundDomain: nil, iframeDomain: nil, site: siteHint(text: scanned, sender: sender, source: source))
  }

  static func isPersonal(_ sender: String, source: VaultDeliveredSource) -> Bool {
    if let at = sender.lastIndex(of: "@") {
      let host = sender[sender.index(after: at)...].trimmingCharacters(in: CharacterSet(charactersIn: "<> ")).lowercased()
      return genericMailDomains.contains(VaultOriginMatch.registrableDomain(host))
    }
    guard source == .messages else { return false }
    let digits = sender.filter { $0.isASCII && $0.isNumber }.count
    return digits >= 10 && sender.allSatisfy { ($0.isASCII && $0.isNumber) || "+-() .".contains($0) }
  }

  static func cleanedSender(_ sender: String) -> String {
    var kept = ""
    var spaced = false
    for scalar in sender.unicodeScalars {
      switch scalar.properties.generalCategory {
      case .control, .format, .lineSeparator, .paragraphSeparator, .surrogate, .unassigned, .privateUse:
        continue
      case .spaceSeparator:
        spaced = !kept.isEmpty
        continue
      default:
        if spaced { kept.unicodeScalars.append(" ") }
        spaced = false
        kept.unicodeScalars.append(scalar)
      }
      if kept.unicodeScalars.count >= longestSender { break }
    }
    return kept
  }

  static func domain(_ text: Substring) -> String? {
    let host = text.lowercased()
    guard host.count <= 253, host.contains("."), !host.hasPrefix("."), !host.hasSuffix("."), !host.hasPrefix("-"), !host.contains("..") else { return nil }
    guard host.utf8.allSatisfy({ ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2D || $0 == 0x2E }) else { return nil }
    guard let tld = host.split(separator: ".").last, tld.count >= 2, tld.allSatisfy({ $0.isLetter }) || tld.hasPrefix("xn--") else { return nil }
    guard host != "localhost", host.split(separator: ".").allSatisfy({ !$0.isEmpty && $0.count <= 63 && !$0.hasPrefix("-") && !$0.hasSuffix("-") }) else {
      return nil
    }
    let registrable = VaultOriginMatch.registrableDomain(host)
    guard !registrable.isEmpty, registrable.contains(".") else { return nil }
    return host
  }

  private struct BoundAttempt {
    let value: VaultDeliveredExtraction?
  }

  private static func boundAttempt(_ text: String) -> BoundAttempt? {
    guard let line = text.split(whereSeparator: \.isNewline).map({ $0.trimmingCharacters(in: .whitespaces) }).last(where: { !$0.isEmpty }) else { return nil }
    let parts = line.split(separator: " ", omittingEmptySubsequences: true)
    guard parts.count >= 2, parts[0].hasPrefix("@"), parts[1].hasPrefix("#") else { return nil }
    guard parts.count <= 3, let host = domain(parts[0].dropFirst()) else { return BoundAttempt(value: nil) }
    let code = parts[1].dropFirst()
    guard (4...10).contains(code.count), code.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { return BoundAttempt(value: nil) }
    var iframe: String?
    if parts.count == 3 {
      guard parts[2].first == "%", let embedded = domain(parts[2].dropFirst()) else { return BoundAttempt(value: nil) }
      iframe = embedded
    }
    let site = VaultOriginMatch.registrableDomain(host)
    return BoundAttempt(value: VaultDeliveredExtraction(code: String(code), boundDomain: host, iframeDomain: iframe, site: site))
  }

  private struct Candidate {
    let start: Int
    let end: Int
    let code: String
    let letters: Bool
  }

  private static func looseCode(_ text: String, personal: Bool) -> String? {
    var cache: [Character: (plain: Character, folded: Character)] = [:]
    var plain: [Character] = []
    var folded: [Character] = []
    plain.reserveCapacity(text.count)
    folded.reserveCapacity(text.count)
    for character in text {
      if let known = cache[character] {
        plain.append(known.plain)
        folded.append(known.folded)
        continue
      }
      let width = widthFolded(character)
      let both = (plain: width, folded: Self.folded(width))
      if cache.count < 4096 { cache[character] = both }
      plain.append(both.plain)
      folded.append(both.folded)
    }
    guard spots(of: messageRefusals, in: folded, most: 1).isEmpty else { return nil }
    let keys = spots(of: keywords, in: folded, most: mostSpots)
    guard !keys.isEmpty else { return nil }
    if personal, spots(of: automation, in: folded, most: 1).isEmpty { return nil }
    let refusals = spots(of: nearbyRefusals, in: folded, most: mostSpots)
    var best: (distance: Int, code: String)?
    var tied = false
    var checked = 0
    for candidate in candidates(plain) {
      guard let (distance, key) = reached(candidate, keys) else { continue }
      if !candidate.letters, candidate.code.count == 4, let year = Int(candidate.code), (1900...2099).contains(year), distance > yearReach { continue }
      guard checked < mostCandidates else { break }
      checked += 1
      guard admissible(candidate, plain: plain, folded: folded) else { continue }
      let keyApart = breaks(plain, between: candidate, key.range, newlines: false)
      let refused = refusals.contains { refusal in
        let near = gap(candidate, refusal.range)
        guard near <= refusalReach, !breaks(plain, between: candidate, refusal.range, newlines: true) else { return false }
        return near <= refusalTouch || near < distance || keyApart
      }
      guard !refused else { continue }
      if let current = best {
        if distance < current.distance {
          best = (distance, candidate.code)
          tied = false
        } else if distance == current.distance, candidate.code != current.code {
          tied = true
        }
      } else {
        best = (distance, candidate.code)
      }
    }
    guard let best, !tied else { return nil }
    return best.code
  }

  private static func reached(_ candidate: Candidate, _ keys: [Spot]) -> (Int, Spot)? {
    var nearest: (Int, Spot)?
    for key in keys {
      let distance = gap(candidate, key.range)
      let reach = candidate.letters ? min(key.reach, lettersReach) : key.reach
      guard distance <= reach, distance < (nearest?.0 ?? Int.max) else { continue }
      nearest = (distance, key)
    }
    return nearest
  }

  private static func breaks(_ plain: [Character], between candidate: Candidate, _ spot: Range<Int>, newlines: Bool) -> Bool {
    let low = min(candidate.end, spot.upperBound)
    let high = max(candidate.start, spot.lowerBound)
    guard low < high else { return false }
    var index = low
    while index < min(high, low + window) {
      let character = plain[index]
      if newlines, character.isNewline { return true }
      if "。！？".contains(character) { return true }
      if ".!?".contains(character), index + 1 < plain.count, plain[index + 1].isWhitespace { return true }
      index += 1
    }
    return false
  }

  private static func candidates(_ plain: [Character]) -> [Candidate] {
    var found: [Candidate] = []
    var index = 0
    while index < plain.count {
      guard isASCIIAlnum(plain[index]) else {
        index += 1
        continue
      }
      var end = index
      while end < plain.count, isASCIIAlnum(plain[end]) { end += 1 }
      let run = String(plain[index..<end])
      let digits = run.allSatisfy(\.isNumber)
      if digits, run.count == 3, end + 4 <= plain.count, plain[end] == " " || plain[end] == "-" {
        var second = end + 1
        while second < plain.count, isASCIIAlnum(plain[second]) { second += 1 }
        let tail = String(plain[(end + 1)..<second])
        if tail.count == 3, tail.allSatisfy(\.isNumber) {
          found.append(Candidate(start: index, end: second, code: run + tail, letters: false))
          index = second
          continue
        }
      }
      if digits, (4...8).contains(run.count) {
        found.append(Candidate(start: index, end: end, code: run, letters: false))
      } else if !digits, isLetterCode(run) {
        found.append(Candidate(start: index, end: end, code: run, letters: true))
      }
      index = end
    }
    return found
  }

  private static func isLetterCode(_ run: String) -> Bool {
    guard (6...8).contains(run.count) else { return false }
    let letters = run.filter(\.isLetter)
    guard letters.allSatisfy(\.isUppercase), Set(letters).count >= 2, run.contains(where: \.isNumber) else { return false }
    return true
  }

  private static func admissible(_ candidate: Candidate, plain: [Character], folded: [Character]) -> Bool {
    let start = candidate.start
    let end = candidate.end
    let before = at(plain, start - 1)
    let beforeTwo = at(plain, start - 2)
    let after = at(plain, end)
    let afterTwo = at(plain, end + 1)
    if before?.isCased == true || after?.isCased == true { return false }
    let googleStyle = !candidate.letters && candidate.code.count == 6 && before == "-" && (beforeTwo == "G" || beforeTwo == "g")
      && !(at(plain, start - 3).map { isASCIIAlnum($0) || $0.isCased } ?? false)
    if let before, !googleStyle {
      if "#@+$=&?/\\*%".contains(before) { return false }
      if ".,:-_".contains(before), let beforeTwo, isASCIIAlnum(beforeTwo) { return false }
      if before.isWhitespace, let beforeTwo, beforeTwo.isASCII, beforeTwo.isNumber { return false }
    }
    if let after {
      if "@=&%/\\+".contains(after) { return false }
      if ".,:-_".contains(after), let afterTwo, isASCIIAlnum(afterTwo) { return false }
      if after.isWhitespace, let afterTwo, afterTwo.isASCII, afterTwo.isNumber { return false }
    }
    if isCurrency(nearest(plain, from: start - 1, step: -1)) || isCurrency(nearest(plain, from: end, step: 1)) { return false }
    if let word = word(folded, before: start), currencyWords.contains(word) { return false }
    if let word = word(folded, after: end), currencyWords.contains(word) || unitWords.contains(word) { return false }
    return !inLink(plain, start: start, end: end)
  }

  private static func inLink(_ plain: [Character], start: Int, end: Int) -> Bool {
    var low = start
    while low > 0, start - low < window, !plain[low - 1].isWhitespace { low -= 1 }
    var high = end
    while high < plain.count, high - end < window, !plain[high].isWhitespace { high += 1 }
    let word = String(plain[low..<high])
    return word.contains("://") || word.contains("@") || word.contains("/") || word.contains("=") || word.contains("?") || word.contains("&")
      || word.lowercased().hasPrefix("www.")
  }

  private static func gap(_ candidate: Candidate, _ spot: Range<Int>) -> Int {
    if spot.upperBound <= candidate.start { return candidate.start - spot.upperBound }
    if spot.lowerBound >= candidate.end { return spot.lowerBound - candidate.end }
    return 0
  }

  private static func at(_ characters: [Character], _ index: Int) -> Character? {
    characters.indices.contains(index) ? characters[index] : nil
  }

  private static func nearest(_ characters: [Character], from index: Int, step: Int) -> Character? {
    var cursor = index
    var looked = 0
    while characters.indices.contains(cursor), looked < 2 {
      if !characters[cursor].isWhitespace { return characters[cursor] }
      cursor += step
      looked += 1
    }
    return nil
  }

  private static func isCurrency(_ character: Character?) -> Bool {
    character?.unicodeScalars.first?.properties.generalCategory == .currencySymbol
  }

  private static func word(_ folded: [Character], before index: Int) -> String? {
    var end = index
    if end > 0, folded[end - 1].isWhitespace { end -= 1 }
    var start = end
    while start > 0, end - start < 32, folded[start - 1].isLetter { start -= 1 }
    return start < end ? String(folded[start..<end]) : nil
  }

  private static func word(_ folded: [Character], after index: Int) -> String? {
    var start = index
    if start < folded.count, folded[start].isWhitespace { start += 1 }
    var end = start
    while end < folded.count, end - start < 32, folded[end].isLetter { end += 1 }
    return start < end ? String(folded[start..<end]) : nil
  }

  private static func isASCIIAlnum(_ character: Character) -> Bool {
    character.isASCII && (character.isLetter || character.isNumber)
  }

  private static func widthFolded(_ character: Character) -> Character {
    guard !character.isASCII else { return character }
    let folded = String(character).folding(options: .widthInsensitive, locale: nil)
    guard folded.count == 1, let only = folded.first, isASCIIAlnum(only) else { return character }
    return only
  }

  private static func folded(_ character: Character) -> Character {
    if character.isASCII { return character.isUppercase ? Character(character.lowercased()) : character }
    let folded = String(character).folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
    if folded.count == 1, let only = folded.first { return only }
    let lowered = character.lowercased()
    return lowered.count == 1 ? lowered.first ?? character : character
  }

  private static func terms(_ list: [String], _ edge: Edge, _ reach: Int) -> [Term] {
    list.map { Term(folded: $0.map(folded), edge: edge, reach: reach) }
  }

  private static func spots(of terms: [Term], in folded: [Character], most: Int) -> [Spot] {
    var byFirst: [Character: [Term]] = [:]
    for term in terms where !term.folded.isEmpty { byFirst[term.folded[0], default: []].append(term) }
    var found: [Spot] = []
    var index = 0
    while index < folded.count, found.count < most {
      var advanced = 1
      for term in byFirst[folded[index]] ?? [] {
        let length = term.folded.count
        guard index + length <= folded.count, folded[index..<(index + length)].elementsEqual(term.folded),
          edgesHold(term.edge, folded, index, index + length)
        else { continue }
        found.append(Spot(range: index..<(index + length), reach: term.reach))
        advanced = max(advanced, length)
      }
      index += advanced
    }
    return found
  }

  private static func edgesHold(_ edge: Edge, _ folded: [Character], _ start: Int, _ end: Int) -> Bool {
    let joins = { (character: Character?) in character.map { $0.isCased || $0.isNumber } ?? false }
    switch edge {
    case .anywhere: return true
    case .compound: return !joins(at(folded, end))
    case .word: return !joins(at(folded, start - 1)) && !joins(at(folded, end))
    }
  }

  private static func siteHint(text: String, sender: String, source: VaultDeliveredSource) -> String? {
    if let from = senderDomain(sender) { return from }
    var named = Set<String>()
    for raw in text.split(whereSeparator: { $0.isWhitespace }) {
      var token = raw.trimmingCharacters(in: CharacterSet(charactersIn: "()[]{}<>.,;:!?\"'«»“”‘’"))[...]
      if let scheme = token.range(of: "://") { token = token[scheme.upperBound...] }
      if let at = token.lastIndex(of: "@") { token = token[token.index(after: at)...] }
      if let slash = token.firstIndex(where: { "/?#:".contains($0) }) { token = token[..<slash] }
      guard let host = domain(token) else { continue }
      named.insert(VaultOriginMatch.registrableDomain(host))
      if named.count > 1 { return nil }
    }
    return named.first
  }

  private static func senderDomain(_ sender: String) -> String? {
    guard let at = sender.lastIndex(of: "@") else { return nil }
    let tail = sender[sender.index(after: at)...].trimmingCharacters(in: CharacterSet(charactersIn: "<> "))
    guard let host = domain(tail[...]) else { return nil }
    let registrable = VaultOriginMatch.registrableDomain(host)
    return genericMailDomains.contains(registrable) ? nil : registrable
  }
}
