import ExpoModulesCore

public class AutofillModule: Module {
  public func definition() -> ModuleDefinition {
    Name(Self.calls.moduleName)
    Events(Self.calls.domain)
    Self.calls.forwardEvents(to: self)

    Self.calls.function

    AsyncFunction("saveCard") { (profile: String, card: [String: Any], numberEntry: String?, promise: Promise) in
      let reply = CallReply(promise: promise)
      var number: String?
      if let numberEntry {
        let digits = AutofillCardNumber.digits(VaultSecretEntries.value(numberEntry) ?? "")
        guard AutofillCardNumber.isComplete(digits) else { return reply.fail("ERR_INVALID_NUMBER", "invalid number") }
        number = digits
      }
      ArdiaServices.saveCard(card, number: number, profile: profile) { reply.service($0, $1) }
    }.runOnQueue(.main)
  }

  static let calls = CallTable(domain: "autofill", handlers: [
    "settings": { args, reply in
      ArdiaServices.profileToggles(profile: args.profile, set: nil) { toggles, error in
        guard let toggles = toggles as? [String: Bool] else { return reply.service(nil, error ?? "no autofill settings") }
        reply.ok(["addresses": toggles["addresses"] ?? true, "cards": toggles["cards"] ?? true])
      }
    },
    "setSettings": { args, reply in
      var values: [String: NSNumber] = [:]
      if let addresses = try args.optionalBool("addresses") { values["addresses"] = NSNumber(value: addresses) }
      if let cards = try args.optionalBool("cards") { values["cards"] = NSNumber(value: cards) }
      ArdiaServices.profileToggles(profile: args.profile, set: values) { _, error in reply.service(nil, error) }
    },
    "addresses": { args, reply in ArdiaServices.addresses(profile: args.profile) { reply.service($0, $1) } },
    "saveAddress": { args, reply in ArdiaServices.saveAddress(try args.dict("address"), profile: args.profile) { reply.service($0, $1) } },
    "cards": { args, reply in ArdiaServices.cards(profile: args.profile) { reply.service($0, $1) } },
    "remove": { args, reply in ArdiaServices.deleteAutofillEntry(try args.text("id"), profile: args.profile) { reply.service($0, $1) } },
    "revealCard": { args, reply in
      let entry = try args.text("entry")
      guard VaultSecretEntries.isToken(entry) else { throw BadCallArgs(message: "entry isn't a secret entry") }
      ArdiaServices.revealCardNumber(try args.text("id"), profile: args.profile) { result, error in
        if let error { return reply.fail("ERR_ENGINE", error) }
        let found = result as? [String: Any]
        guard let number = found?["number"] as? String, !number.isEmpty else {
          return reply.ok(["revealed": false, "declined": found?["authenticated"] as? Bool == false])
        }
        let digits = AutofillCardNumber.digits(number)
        VaultSecretEntries.set(entry, digits)
        var revealed = AutofillCardNumber.summary(digits)
        revealed["revealed"] = true
        reply.ok(revealed)
      }
    },
    "copyCard": { args, reply in
      let entry = try args.text("entry")
      let digits = AutofillCardNumber.digits(VaultSecretEntries.value(entry) ?? "")
      guard !digits.isEmpty else { return reply.ok(["copied": false]) }
      Task { reply.ok(["copied": await VaultClipboard.copy(digits), "clearsAfter": VaultClipboard.clearDelay]) }
    },
    "fill": { args, reply in
      let tabId = try args.text("tabId")
      let id = try args.text("id")
      let kind = try args.text("kind")
      guard kind == "address" || kind == "card" else { throw BadCallArgs(message: "kind isn't address or card") }
      guard kind == "card" else { return reply.ok(["filled": ArdiaHost.fillAutofillEntry(tabId: tabId, kind: kind, id: id)]) }
      guard let pin = ArdiaWebView.autofillFieldPin(ofTab: tabId) else { return reply.ok(["filled": false, "moved": true]) }
      Task { @MainActor in
        guard await VaultOwnerCheck.confirm("fill your card", touchScope: VaultTouchGrants.card(card: id, tab: tabId)) else {
          return reply.ok(["filled": false, "declined": true])
        }
        guard ArdiaWebView.autofillFieldPin(ofTab: tabId) == pin else { return reply.ok(["filled": false, "moved": true]) }
        reply.ok(["filled": ArdiaHost.fillAutofillEntry(tabId: tabId, kind: kind, id: id)])
      }
    },
    "claimMenuKeys": { args, reply in
      ArdiaHost.claimAutofillMenuKeys(tabId: try args.text("tabId"), claim: try args.bool("claim"))
      reply.ok()
    },
    "showSuggestions": { args, reply in
      reply.ok(ArdiaHost.showAutofillSuggestions(tabId: try args.text("tabId"), passwords: try args.bool("passwords")))
    },
  ])
}
