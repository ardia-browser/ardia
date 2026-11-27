import Foundation

enum ImportBatchWriter {
  static let cookieBatch = 500
  static let autofillBatch = 500

  typealias Engine = (_ call: String, _ args: SecretBytes) async -> [String: Any]

  static func write(cookies: [Cookie], addresses: [ImportedAddress], cards: [ImportedCard], kinds: Set<ImportKind>,
                    cancellation: Cancellation?, engine: Engine) async -> [String: Any] {
    var out: [String: Int] = ["cookies": 0, "cookiesRejected": 0, "cookiesExisting": 0, "addresses": 0, "cards": 0]
    var error: String?
    func skipped() -> Bool {
      guard cancellation?.isCancelled == true else { return false }
      out["cancelled"] = 1
      return true
    }
    func add(_ key: String, _ reply: [String: Any], _ field: String) {
      out[key, default: 0] += (reply[field] as? NSNumber)?.intValue ?? 0
    }
    if kinds.contains(.cookies), !cookies.isEmpty {
      let wire = CookieWire.batches(cookies, size: cookieBatch)
      out["cookiesRejected"] = wire.dropped
      for batch in wire.batches {
        if skipped() { break }
        let reply = await engine("ac_cookies_import", batch)
        if let message = reply["error"] as? String {
          error = message
          out["cookiesFailed"] = 1
          break
        }
        add("cookies", reply, "imported")
        add("cookiesRejected", reply, "rejected")
        add("cookiesExisting", reply, "existing")
      }
      wire.batches.forEach { $0.wipe() }
    }
    if kinds.contains(.autofill) {
      var start = 0
      while start < max(addresses.count, cards.count) {
        if skipped() { break }
        let batchAddresses = Array(addresses[min(start, addresses.count)..<min(start + autofillBatch, addresses.count)])
        let batchCards = Array(cards[min(start, cards.count)..<min(start + autofillBatch, cards.count)])
        start += autofillBatch
        let reply = await engine("ac_autofill_import", AutofillWire.batch(addresses: batchAddresses, cards: batchCards))
        if let message = reply["error"] as? String {
          error = error ?? message
          out["autofillFailed"] = 1
          break
        }
        add("addresses", reply, "addresses")
        add("cards", reply, "cards")
      }
    }
    var body: [String: Any] = out
    if let error { body["error"] = error }
    return body
  }
}
