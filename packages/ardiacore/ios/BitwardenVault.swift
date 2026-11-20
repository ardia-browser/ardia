import Foundation

struct BitwardenVault: VaultProvider {
  let id = "bitwarden"
  let name = "Bitwarden"
  let binaryName = "bw"
  let capabilities = VaultCapabilities(totp: true, save: true, selfHosted: true, masterPassword: true, touchID: true, addTotp: true, edit: true)
  let install = VaultInstall(command: "brew install bitwarden-cli", url: "https://bitwarden.com/help/cli/")
  let setup: VaultSetup? = VaultSetup(kind: .credentials)

  private static let tool = "Bitwarden CLI"
  private static let passwordVariable = "ARDIA_BW_PASSWORD"
  private static let syncInterval: TimeInterval = 300
  private static let listTimeout: TimeInterval = 90
  private static let listOutputLimit = 160 * 1024 * 1024
  private static let syncTimeout: TimeInterval = 30
  private static let signInTimeout: TimeInterval = 60
  private static let writeTimeout: TimeInterval = 60
  private static let lockTimeout: TimeInterval = 20
  private static let euServer = "https://vault.bitwarden.eu"
  private static let twoStepMethods = [
    VaultMethod(id: "0", name: "Authenticator app"), VaultMethod(id: "1", name: "Email"), VaultMethod(id: "3", name: "YubiKey OTP"),
  ]
  private static let lockedHints = ["vault is locked", "session key is invalid", "invalid session"]
  private static let signedOutHints = ["you are not logged in", "not logged in"]
  private static let missingHints = [
    "not found", "no password available", "no totp available", "no username available", "not a login", "more than one result",
  ]
  private static let newDeviceMessage = "Bitwarden wants to verify this Mac, so sign in with your API key instead."
  private static let codeOrNewDeviceMessage =
    "Enter your two-step login code. If Bitwarden emailed you a code for a new device instead, sign in with your API key."

  var environment: [String: String] { ["BW_NOINTERACTION": "true"] }

  func isolatedEnvironment(_ directory: String) -> [String: String] { ["BITWARDENCLI_APPDATA_DIR": directory] }

  func state(_ cli: VaultCLI) async -> VaultProviderState {
    let session = cli.session
    let current = await readStatus(cli, session: session)
    guard let fields = current.fields else { return makeState(.unavailable, message: current.problem) }
    let server = Self.serverName(VaultJSON.string(fields["serverUrl"]))
    let email = VaultJSON.string(fields["userEmail"])
    switch VaultJSON.string(fields["status"]) {
    case "unlocked": return makeState(session == nil ? .locked : .unlocked, account: email, server: server)
    case "locked": return makeState(.locked, account: email, server: server)
    default: return makeState(.signedOut, server: server)
    }
  }

  func signIn(_ cli: VaultCLI, fields: VaultSignInFields) async -> VaultSignInResult {
    let current = await readStatus(cli, session: nil)
    guard let status = current.fields else { return failed(current.problem, state: .unavailable) }
    let loggedIn = ["locked", "unlocked"].contains(VaultJSON.string(status["status"]) ?? "")
    if loggedIn {
      guard let password = fields.password else { return needs(.password, "Enter your Bitwarden master password.") }
      return await unlock(cli, password: password)
    }
    if let server = fields.server, let problem = await applyServer(cli, server) { return failed(problem, state: .signedOut) }
    if let clientId = fields.clientId, let clientSecret = fields.clientSecret {
      return await apiKeySignIn(cli, clientId: clientId, clientSecret: clientSecret, password: fields.password)
    }
    guard let email = fields.email, Self.isEmail(email) else { return needs(.email, state: .signedOut) }
    guard let password = fields.password else { return needs(.password, state: .signedOut) }
    if let method = fields.method, !Self.isDigits(method) { return failed("Choose a two-step login method from the list.", state: .signedOut) }
    if let code = fields.code, !Self.isCode(code) { return needs(.code, "That code doesn't look right.", state: .signedOut) }
    if fields.code == nil, let method = fields.method, method != "1" {
      return needs(.code, "Enter your two-step login code.", state: .signedOut)
    }
    var arguments = ["login", email, "--passwordenv", Self.passwordVariable, "--raw", "--nointeraction"]
    if let method = fields.method { arguments += ["--method", method] }
    if let code = fields.code { arguments += ["--code", code] }
    let result = await cli.runSigningIn(arguments, environment: [Self.passwordVariable: password], timeout: Self.signInTimeout)
    if result.cancelled { return stopped(state: .signedOut) }
    if result.succeeded, let session = Self.sessionKey(result) {
      cli.remember(session: session, persistent: true)
      return signedIn()
    }
    if VaultMessages.mentions(result, ["already logged in"]) { return await unlock(cli, password: password) }
    if VaultMessages.mentions(result, ["no provider selected"]) {
      return needs(.code, "Choose how to get your two-step login code.", methods: Self.twoStepMethods, state: .signedOut)
    }
    if VaultMessages.mentions(result, ["code is required"]) {
      if fields.code != nil { return failed(Self.newDeviceMessage, state: .signedOut) }
      let message = switch fields.method {
      case "1"?: "Enter the code Bitwarden emailed you."
      case nil: Self.codeOrNewDeviceMessage
      default: "Enter your two-step login code."
      }
      return needs(.code, message, methods: fields.method == nil ? Self.twoStepMethods : nil, state: .signedOut)
    }
    if VaultMessages.mentions(result, ["username or password is incorrect", "invalid master password", "invalid_grant"]) {
      return failed("The email or master password isn't right.", state: .signedOut)
    }
    if VaultMessages.mentions(result, ["two-step", "invalid code", "token"]) && fields.code != nil {
      return needs(.code, "That code didn't work. Try a new one.", state: .signedOut)
    }
    return failed(VaultMessages.failure(result, tool: Self.tool, redacting: [password, email]), state: .signedOut)
  }

  func unlock(_ cli: VaultCLI, password: String?) async -> VaultSignInResult {
    guard let password, !password.isEmpty else { return await unlockWithStoredSession(cli) }
    let result = await cli.runSigningIn(
      ["unlock", "--passwordenv", Self.passwordVariable, "--raw", "--nointeraction"], environment: [Self.passwordVariable: password],
      timeout: Self.signInTimeout)
    if result.cancelled { return stopped(state: .locked) }
    if result.succeeded, let session = Self.sessionKey(result) {
      cli.remember(session: session, persistent: true)
      return signedIn()
    }
    if VaultMessages.mentions(result, Self.signedOutHints) { return failed("Sign in to Bitwarden first.", state: .signedOut) }
    if VaultMessages.mentions(result, ["invalid master password", "master password is required"]) {
      return needs(.password, "That master password isn't right.")
    }
    return failed(VaultMessages.failure(result, tool: Self.tool, redacting: [password]))
  }

  func lock(_ cli: VaultCLI, session: String) async {
    guard !cli.touchID else { return }
    _ = await cli.run(["lock", "--nointeraction"], environment: sessionEnvironment(session), timeout: Self.lockTimeout)
  }

  func signOut(_ cli: VaultCLI) async {
    _ = await cli.run(["logout", "--nointeraction"], environment: sessionEnvironment(cli.session))
  }

  func configure(_ cli: VaultCLI, server: String?) async -> String? {
    let current = await readStatus(cli, session: nil)
    if let status = current.fields, ["locked", "unlocked"].contains(VaultJSON.string(status["status"]) ?? "") {
      return "Sign out of Bitwarden before changing the server."
    }
    return await applyServer(cli, server ?? "")
  }

  func items(_ cli: VaultCLI) async throws -> VaultItemList {
    guard let session = cli.session else { throw VaultError.locked }
    let environment = ["BW_SESSION": session]
    let now = Date().timeIntervalSince1970
    let lastSync = cli.value(VaultCLI.syncedAtKey).flatMap { Double($0) } ?? 0
    if now - lastSync >= Self.syncInterval, !VaultNetwork.isOffline {
      let sync = await cli.run(["sync", "--nointeraction"], environment: environment, timeout: Self.syncTimeout)
      try Task.checkCancellation()
      if sync.succeeded {
        cli.setValue(VaultCLI.syncedAtKey, String(now))
      } else if VaultMessages.mentions(sync, Self.lockedHints + Self.signedOutHints) {
        try check(sync)
      }
    }
    let result = await cli.run(["list", "items", "--nointeraction"], environment: environment, timeout: Self.listTimeout,
                               outputLimit: Self.listOutputLimit)
    try check(result)
    var listed = VaultItemList(items: [])
    for entry in try VaultJSON.list(result.stdout, from: Self.tool) {
      guard let item = loginItem(entry) else { continue }
      listed.items.append(item)
      let login = VaultJSON.dict(entry["login"])
      if let password = login.flatMap({ VaultJSON.string($0["password"]) }), !password.isEmpty {
        listed.passwords[item.id] = password
      }
      if let totp = login.flatMap({ VaultJSON.string($0["totp"]) }), VaultTotpSecret(totp) != nil {
        listed.totps[item.id] = totp
      }
    }
    return listed
  }

  func secret(_ cli: VaultCLI, id: String, field: VaultField) async throws -> String {
    guard let session = cli.session else { throw VaultError.locked }
    guard Self.isGuid(id) else { throw VaultError.notFound }
    let result = await cli.run(["get", field.rawValue, id, "--nointeraction"], environment: ["BW_SESSION": session])
    try check(result)
    var value = result.output
    if value.hasSuffix("\n") { value.removeLast() }
    if value.hasSuffix("\r") { value.removeLast() }
    guard !value.isEmpty else { throw VaultError.notFound }
    return value
  }

  func save(_ cli: VaultCLI, login: VaultNewLogin) async throws -> VaultItem {
    guard let session = cli.session else { throw VaultError.locked }
    let uri: [String: Any] = ["uri": login.url, "match": NSNull()]
    let credentials: [String: Any] = [
      "uris": [uri], "username": login.username, "password": login.password, "totp": NSNull(),
    ]
    let item: [String: Any] = [
      "type": 1, "name": login.title, "notes": NSNull(), "favorite": false, "folderId": NSNull(), "organizationId": NSNull(),
      "reprompt": 0, "fields": [Any](), "login": credentials,
    ]
    guard let json = VaultJSON.data(item) else { throw VaultError.failed("Ardia couldn't prepare the login for Bitwarden.") }
    let input = Data(json.base64EncodedString().utf8)
    let result = await cli.run(["create", "item", "--nointeraction"], input: input, environment: ["BW_SESSION": session], timeout: Self.writeTimeout)
    try check(result, redacting: [login.password])
    if let created = VaultJSON.dict(VaultJSON.parse(result.stdout)), let saved = loginItem(created) { return saved }
    guard let found = await savedLogin(cli, session: session, login: login) else {
      throw VaultError.failed("Bitwarden saved the login but didn't return it. Check Bitwarden before saving it again.")
    }
    return found
  }

  func addTotp(_ cli: VaultCLI, id: String, uri: String) async throws -> VaultItem {
    try await edit(cli, id: id, change: VaultLoginChange(totp: .set(uri)))
  }

  func edit(_ cli: VaultCLI, id: String, change: VaultLoginChange) async throws -> VaultItem {
    guard let session = cli.session else { throw VaultError.locked }
    guard VaultLoginEditPlan.isBitwardenId(id) else { throw VaultError.notFound }
    let environment = ["BW_SESSION": session]
    let current = await cli.run(["get", "item", id, "--nointeraction"], environment: environment)
    try check(current)
    let entry = try VaultJSON.record(current.stdout, from: Self.tool)
    guard VaultJSON.dict(entry["login"]) != nil else { throw VaultError.notFound }
    guard let command = VaultLoginEditPlan.bitwardenCommand(id: id, item: entry, change: change) else {
      throw VaultError.failed("Ardia couldn't prepare the change for Bitwarden.")
    }
    let result = await cli.run(command.arguments, input: command.input, environment: environment, timeout: Self.writeTimeout)
    try check(result, redacting: VaultLoginEditPlan.bitwardenSecrets(entry, change))
    if let edited = VaultJSON.dict(VaultJSON.parse(result.stdout)), let saved = loginItem(edited) { return saved }
    let reread = await cli.run(["get", "item", id, "--nointeraction"], environment: environment)
    guard reread.succeeded, let entry = try? VaultJSON.record(reread.stdout, from: Self.tool), let saved = loginItem(entry) else {
      throw VaultError.failed("Bitwarden saved the change but didn't return the login.")
    }
    return saved
  }

  private func readStatus(_ cli: VaultCLI, session: String?) async -> (fields: [String: Any]?, problem: String, cancelled: Bool) {
    let result = await cli.run(["status", "--nointeraction"], environment: sessionEnvironment(session))
    guard result.succeeded else { return (nil, VaultMessages.failure(result, tool: Self.tool), result.cancelled) }
    guard let fields = try? VaultJSON.record(result.stdout, from: Self.tool) else { return (nil, VaultJSON.unreadableMessage(Self.tool), false) }
    return (fields, "", false)
  }

  private func savedLogin(_ cli: VaultCLI, session: String, login: VaultNewLogin) async -> VaultItem? {
    let result = await cli.run(["list", "items", "--url", login.url, "--nointeraction"], environment: ["BW_SESSION": session],
                               timeout: Self.listTimeout, outputLimit: Self.listOutputLimit)
    guard result.succeeded, let entries = try? VaultJSON.list(result.stdout, from: Self.tool) else { return nil }
    return entries.compactMap(loginItem).filter { $0.title == login.title && $0.username == login.username }
      .max { ($0.updatedAt ?? 0) < ($1.updatedAt ?? 0) }
  }

  private func sessionEnvironment(_ session: String?) -> [String: String] {
    guard let session else { return [:] }
    return ["BW_SESSION": session]
  }

  private func unlockWithStoredSession(_ cli: VaultCLI) async -> VaultSignInResult {
    guard cli.touchID, cli.hasStoredSession, let stored = await cli.storedSession("unlock Bitwarden") else {
      return needs(.password, "Enter your Bitwarden master password.")
    }
    let current = await readStatus(cli, session: stored)
    if current.cancelled { return stopped(state: .locked) }
    guard let status = current.fields else { return failed(current.problem) }
    switch VaultJSON.string(status["status"]) {
    case "unlocked":
      break
    case "locked", "unauthenticated":
      cli.dropStoredSession()
      return needs(.password, "Bitwarden locked since Ardia last unlocked it. Enter your master password.")
    default:
      return failed("Bitwarden didn't say whether it's unlocked. Try again.")
    }
    cli.remember(session: stored)
    return signedIn()
  }

  private func apiKeySignIn(_ cli: VaultCLI, clientId: String, clientSecret: String, password: String?) async -> VaultSignInResult {
    guard clientId.hasPrefix("user") else { return failed("Organization keys can't sign in, so use your personal API key.", state: .signedOut) }
    let result = await cli.runSigningIn(
      ["login", "--apikey", "--nointeraction"], environment: ["BW_CLIENTID": clientId, "BW_CLIENTSECRET": clientSecret],
      timeout: Self.signInTimeout)
    if result.cancelled { return stopped(state: .signedOut) }
    if !result.succeeded && !VaultMessages.mentions(result, ["already logged in"]) {
      if VaultMessages.mentions(result, ["incorrect", "invalid_client", "invalid api key"]) {
        return failed("Bitwarden didn't accept that API key.", state: .signedOut)
      }
      return failed(VaultMessages.failure(result, tool: Self.tool, redacting: [clientSecret, clientId]), state: .signedOut)
    }
    guard let password else { return needs(.password, "Signed in. Enter your master password to unlock.") }
    return await unlock(cli, password: password)
  }

  private func applyServer(_ cli: VaultCLI, _ server: String) async -> String? {
    guard let value = Self.serverValue(server) else { return "Enter the server as an https address." }
    let result = await cli.run(["config", "server", value, "--nointeraction"])
    if result.succeeded { return nil }
    if VaultMessages.mentions(result, ["logout required"]) { return "Sign out of Bitwarden before changing the server." }
    return VaultMessages.failure(result, tool: Self.tool)
  }

  private func check(_ result: VaultCommandResult, redacting secrets: [String] = []) throws {
    if !result.succeeded && VaultMessages.mentions(result, ["premium"]) {
      throw VaultError.failed("One-time codes in Bitwarden need Premium.")
    }
    try checked(result, tool: Self.tool, locked: Self.lockedHints, signedOut: Self.signedOutHints, missing: Self.missingHints,
                redacting: secrets)
  }

  private func loginItem(_ entry: [String: Any]) -> VaultItem? {
    guard VaultJSON.int(entry["type"]) == 1, VaultJSON.int(entry["reprompt"]) != 1, VaultJSON.string(entry["deletedDate"]) == nil,
      VaultJSON.string(entry["archivedDate"]) == nil, let itemId = VaultJSON.string(entry["id"]), let login = VaultJSON.dict(entry["login"])
    else { return nil }
    var urls: [String] = []
    var urlMatch: [String] = []
    for uri in VaultJSON.dicts(login["uris"]) {
      guard let address = VaultJSON.string(uri["uri"]), let mode = Self.urlMatch(VaultJSON.int(uri["match"])) else { continue }
      urls.append(address)
      urlMatch.append(mode)
    }
    let totp = VaultJSON.string(login["totp"])
    var item = VaultItem(
      provider: id, id: itemId, title: VaultJSON.string(entry["name"]) ?? "", username: VaultJSON.string(login["username"]) ?? "",
      urls: urls, hasTotp: totp != nil, vault: VaultJSON.string(entry["organizationId"]) == nil ? nil : "Organization",
      favorite: VaultJSON.bool(entry["favorite"]), updatedAt: VaultJSON.milliseconds(entry["revisionDate"]))
    item.totpPeriod = totp.flatMap { VaultTotp.period(fromURI: $0) }
    if urlMatch.contains(where: { !$0.isEmpty }) { item.urlMatch = urlMatch }
    let passkeys = VaultJSON.dicts(login["fido2Credentials"]).compactMap(BitwardenPasskeys.metadata)
    if !passkeys.isEmpty { item.passkeys = passkeys }
    return item
  }

  func savePasskey(_ cli: VaultCLI, credential: BitwardenPasskeys.NewCredential, attachTo existing: String?, title: String, url: String) async throws
    -> String
  {
    guard let session = cli.session else { throw VaultError.locked }
    let environment = ["BW_SESSION": session]
    let secret = VaultBase64URL.encode(credential.key.derRepresentation)
    var itemId: String?
    if let existing, Self.isGuid(existing) {
      let current = await cli.run(["get", "item", existing, "--nointeraction"], environment: environment)
      try check(current)
      if let updated = BitwardenPasskeys.attach(credential, to: try VaultJSON.record(current.stdout, from: Self.tool)),
        let json = VaultJSON.data(updated)
      {
        let result = await cli.run(["edit", "item", existing, "--nointeraction"], input: Data(json.base64EncodedString().utf8), environment: environment,
                                   timeout: Self.writeTimeout)
        try check(result, redacting: [secret])
        itemId = existing
      }
    }
    if itemId == nil {
      guard let json = VaultJSON.data(BitwardenPasskeys.newItem(credential, title: title, url: url)) else {
        throw VaultError.failed("Ardia couldn't prepare the passkey for Bitwarden.")
      }
      let result = await cli.run(["create", "item", "--nointeraction"], input: Data(json.base64EncodedString().utf8), environment: environment,
                                 timeout: Self.writeTimeout)
      try check(result, redacting: [secret])
      guard let created = VaultJSON.string(VaultJSON.dict(VaultJSON.parse(result.stdout))?["id"]), Self.isGuid(created) else {
        throw VaultError.failed("Bitwarden saved the passkey but didn't say where. Check Bitwarden before saving it again.")
      }
      itemId = created
    }
    guard let itemId else { throw VaultError.failed("Bitwarden didn't return the item it saved.") }
    let readBack = await cli.run(["get", "item", itemId, "--nointeraction"], environment: environment)
    try check(readBack)
    guard let stored = try? VaultJSON.record(readBack.stdout, from: Self.tool), let login = VaultJSON.dict(stored["login"]),
      let signer = BitwardenPasskeys.signer(VaultJSON.dicts(login["fido2Credentials"]), credential: credential.rawId),
      signer.key.publicKey.rawRepresentation == credential.key.publicKey.rawRepresentation
    else { throw VaultError.failed("Bitwarden didn't keep the passkey.") }
    return itemId
  }

  func passkeySigner(_ cli: VaultCLI, item: String, credential: Data) async throws -> VaultPasskeySigner? {
    guard let session = cli.session else { throw VaultError.locked }
    guard Self.isGuid(item) else { throw VaultError.notFound }
    let result = await cli.run(["get", "item", item, "--nointeraction"], environment: ["BW_SESSION": session])
    try check(result)
    guard let login = VaultJSON.dict(try VaultJSON.record(result.stdout, from: Self.tool)["login"]) else { throw VaultError.notFound }
    return BitwardenPasskeys.signer(VaultJSON.dicts(login["fido2Credentials"]), credential: credential)
  }

  static func urlMatch(_ match: Int?) -> String? {
    switch match {
    case nil, 1?: return "host"
    case 2?, 3?: return "exact"
    case 4?, 5?: return nil
    default: return ""
    }
  }

  private static func sessionKey(_ result: VaultCommandResult) -> String? {
    guard let line = result.trimmedOutput.split(whereSeparator: \.isNewline).last.map({ String($0) }),
      line.count >= 16, !line.contains(" ")
    else { return nil }
    return line
  }

  private static func serverName(_ url: String?) -> String {
    guard let url, !url.isEmpty else { return "bitwarden.com" }
    let host = VaultOriginMatch.host(of: url) ?? url
    if host == "bitwarden.com" || host == "vault.bitwarden.com" { return "bitwarden.com" }
    if host == "bitwarden.eu" || host == "vault.bitwarden.eu" { return "bitwarden.eu" }
    return url
  }

  static func serverValue(_ text: String) -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    switch trimmed.lowercased() {
    case "", "bitwarden.com", "us", "https://bitwarden.com", "https://vault.bitwarden.com": return "bitwarden.com"
    case "bitwarden.eu", "eu", "https://bitwarden.eu", "https://vault.bitwarden.eu": return euServer
    default: break
    }
    guard let components = URLComponents(string: trimmed), let scheme = components.scheme?.lowercased(), let host = components.host,
      !host.isEmpty, scheme == "https" || (scheme == "http" && VaultOriginMatch.isLocalHost(host))
    else { return nil }
    var value = trimmed
    while value.hasSuffix("/") { value.removeLast() }
    return value
  }

  private static func isEmail(_ text: String) -> Bool {
    text.contains("@") && !text.hasPrefix("-") && !text.contains(where: { $0.isWhitespace }) && text.count <= 320
  }

  private static func isDigits(_ text: String) -> Bool { !text.isEmpty && text.count <= 2 && text.allSatisfy { $0.isASCII && $0.isNumber } }

  private static func isCode(_ text: String) -> Bool {
    !text.isEmpty && text.count <= 64 && !text.hasPrefix("-") && text.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) }
  }

  private static func isGuid(_ id: String) -> Bool { VaultLoginEditPlan.isBitwardenId(id) }
}
