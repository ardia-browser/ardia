import Foundation

struct CredentialWording: Sendable {
  let title: String
  let program: String
  let signIn: CredentialSignInSpec

  static let problems: Set<String> = [
    "wrongPassword", "wrongCredentials", "wrongCode", "badCode", "badServer", "chooseMethod", "codeOrNewDevice", "needsApiKey", "organizationKey",
    "notAccepted", "unlockNext", "signOutFirst", "signInFirst", "lockedSinceLastUnlock", "stayedLocked", "approvalTimedOut", "appUnreachable",
    "setupNeeded", "sessionLock", "extraPassword", "finishInBrowser", "didntStart", "premiumNeeded", "noVault", "unknownVault", "cantPrepare",
    "savedNotReturned", "incomplete", "notTaken", "unreadable", "tooSlow", "notLaunched", "timedOut", "overflowed", "offline", "unreachable",
    "outdated", "cancelled", "failed",
  ]

  var appName: String { program == "op" ? "1Password CLI" : program }

  func fieldTitle(_ field: String?) -> String {
    if let field, let found = signIn.field(field) { return found.title.lowercasedFirstWordUnlessName }
    if field == "server" { return "server" }
    if let unlock = signIn.unlockField, let found = signIn.field(unlock) { return found.title.lowercasedFirstWordUnlessName }
    return "password"
  }

  func sentence(_ problem: String, field: String? = nil, detail: String? = nil, handler: String = "") -> String {
    let field = fieldTitle(field)
    switch problem {
    case "wrongPassword": return "That master password isn't right."
    case "wrongCredentials": return "The email or master password isn't right."
    case "wrongCode": return "That code didn't work. Try a new one."
    case "badCode": return "That code doesn't look right."
    case "badServer": return "Enter the server as an https address."
    case "chooseMethod": return "Choose a two-step login method from the list."
    case "codeOrNewDevice": return "Enter your two-step login code. If \(title) emailed you a code for a new device instead, sign in with your API key."
    case "needsApiKey": return "\(title) wants to verify this Mac, so sign in with your API key instead."
    case "organizationKey": return "Organization keys can't sign in, so use your personal API key."
    case "notAccepted": return "\(title) didn't accept that \(field)."
    case "unlockNext": return "Signed in. Enter your \(field) to unlock."
    case "signOutFirst": return "Sign out of \(title) before changing the server."
    case "signInFirst": return "Sign in to \(title) first."
    case "lockedSinceLastUnlock": return "\(title) locked since Ardia last unlocked it. Enter your \(field)."
    case "stayedLocked": return "\(title) stayed locked."
    case "approvalTimedOut": return "\(title) didn't confirm in time. Try again."
    case "appUnreachable": return "Ardia couldn't reach \(title). Open it and try again."
    case "setupNeeded": return "Turn on Integrate with \(appName) in \(title), then try again."
    case "sessionLock": return "\(title) has a session lock on. Run \(program) session unlock in Terminal, then try again."
    case "extraPassword": return "Your \(title) account has an extra password. Enter it and sign in again."
    case "finishInBrowser": return "Finish signing in in the tab Ardia opened."
    case "didntStart": return "\(title) didn't start signing in. Try again."
    case "premiumNeeded": return "One-time codes in \(title) need Premium."
    case "noVault": return "No \(title) vault takes new items."
    case "unknownVault": return "Ardia couldn't tell which \(title) vault is yours, so save this login in \(title)."
    case "cantPrepare": return "Ardia couldn't prepare the change for \(title)."
    case "savedNotReturned":
      switch handler {
      case "edit", "addTotp": return "\(title) saved the change but didn't return the login. Check \(title) before saving it again."
      case "passkeys.save": return "\(title) saved the passkey but didn't say where. Check \(title) before saving it again."
      default: return "\(title) saved the login but didn't return it. Check \(title) before saving it again."
      }
    case "incomplete": return "\(title) made the login without its password. Update \(program), then add the password in \(title)."
    case "notTaken": return "\(title) didn't take the change. Update \(program) and try again."
    case "unreadable": return "Ardia couldn't read what \(program) answered."
    case "tooSlow": return "\(title) took too long to list your logins. Try again."
    case "notLaunched": return "Ardia couldn't start \(program)."
    case "timedOut": return "\(program) didn't answer in time."
    case "overflowed": return "\(program) sent more output than Ardia reads."
    case "offline": return "You're offline, so connect to the internet and try again."
    case "unreachable": return "Ardia couldn't reach the server, so check the address and your connection."
    case "outdated": return "This \(program) is too old, so update it and try again."
    case "cancelled": return handler == "signIn" || handler == "unlock" ? "Signing in to \(title) was cancelled." : "\(program) was stopped."
    default:
      if let detail, !detail.isEmpty { return detail }
      return "\(program) stopped with an error."
    }
  }

  func prompt(_ need: CredentialSignInNeed) -> String {
    switch need {
    case .field(let field): return "Enter your \(fieldTitle(field))."
    case .code(let methods, let method):
      if let methods, !methods.isEmpty { return "Choose how to get your two-step login code." }
      if method?.sendsCode == true { return "Enter the code \(title) sent you." }
      return "Enter your two-step login code."
    case .approval: return "Finish signing in in the new tab."
    case .account: return "Choose an account."
    }
  }

  var stopped: String { "\(title) stopped. Restart it in Settings." }
  var didntAnswer: String { "\(title) didn't answer in time." }
  var unreadableResult: String { "\(title)'s plugin sent a result Ardia can't read." }
  var tooLarge: String { "\(title)'s plugin sent more than Ardia reads." }
  var overloaded: String { "\(title) has too many requests waiting. Try again." }
  var hostCancelled: String { "\(title) stopped what it was doing." }
  var noServerSetting: String { "\(title) has no server setting." }
  var undeclaredApproval: String { "\(title) asked to open an address it doesn't declare." }
  var notRunning: String { "\(title) isn't running. Restart it in Settings." }
  var damaged: String { "This copy of \(title) is damaged. Reinstall it." }
  var keptPasskeyMismatch: String { "\(title) didn't keep the passkey." }
  var typeAgain: String { "Type your \(title) \(fieldTitle(nil)) again." }

  func missingHandler(_ handler: String) -> String { "\(title)'s plugin is missing \(handler)." }
  func unhandledCapability(_ capability: String) -> String { "\(title)'s plugin doesn't handle \(capability), which it offers." }
  func protocolSkew(_ spoken: Int) -> String {
    spoken > CredentialLimits.protocolVersion
      ? "This \(title) plugin speaks credentials protocol \(spoken), and this Ardia speaks \(CredentialLimits.protocolVersion). Update Ardia."
      : "This \(title) plugin speaks credentials protocol \(spoken), and this Ardia speaks \(CredentialLimits.protocolVersion). Update the plugin."
  }
  func update(to version: String) -> String { "Update \(program) to \(version) or later." }

  static func cleanedDetail(_ text: String?, secrets: [String]) -> String? {
    guard let text else { return nil }
    let plain = text.replacingOccurrences(of: #"\x1B\[[0-9;?]*[A-Za-z]"#, with: "", options: .regularExpression)
    guard let line = plain.split(whereSeparator: \.isNewline).map({ $0.trimmingCharacters(in: .whitespaces) }).first(where: { !$0.isEmpty }) else { return nil }
    let visible = String(String.UnicodeScalarView(line.unicodeScalars.filter { !CredentialCatalogParser.isControlOrDirection($0) }))
    let redacted = CredentialVerbOutput.redact(visible, CredentialVerbOutput.redactor(secrets))
    let kept = redacted.count > CredentialLimits.detailLength ? String(redacted.prefix(CredentialLimits.detailLength)) : redacted
    return kept.isEmpty ? nil : kept
  }
}

private extension String {
  var lowercasedFirstWordUnlessName: String {
    let words = split(separator: " ", omittingEmptySubsequences: false).map(String.init)
    guard let first = words.first, first.count > 1, first.dropFirst().allSatisfy({ $0.isLowercase || !$0.isLetter }) else { return self }
    return ([first.lowercased()] + words.dropFirst().map { word in
      word.dropFirst().allSatisfy({ $0.isLowercase || !$0.isLetter }) ? word.lowercased() : word
    }).joined(separator: " ")
  }
}
