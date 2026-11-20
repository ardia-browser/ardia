import Foundation

struct OnePasswordVault: VaultProvider {
  let id = "1password"
  let name = "1Password"
  let binaryName = "op"
  let capabilities = VaultCapabilities(totp: true, save: true, selfHosted: false, masterPassword: false, touchID: true, addTotp: true, edit: true)
  let install = VaultInstall(command: "brew install 1password-cli", url: "https://www.1password.dev/cli/get-started/")
  let setup: VaultSetup? = VaultSetup(kind: .desktopIntegration)
  let staysAuthorizedAfterUse: TimeInterval? = 600

  private static let tool = "1Password CLI"
  private static let marker = "1password-app"
  private static let approvalTimeout: TimeInterval = 90
  private static let readTimeout: TimeInterval = 60
  private static let accountsTimeout: TimeInterval = 20
  private static let signOutTimeout: TimeInterval = 15
  private static let lockedHints = [
    "not signed in", "not currently signed in", "authorization prompt dismissed", "authorization timeout", "authorization denied",
    "session expired", "signin is required", "sign in again",
  ]
  private static let missingHints = [
    "isn't an item", "could not get item", "could not find item", "no item found", "does not have a field", "more than one item",
    "isn't a valid", "no one-time password",
  ]
  private static let setupMessage = "Turn on Integrate with 1Password CLI in 1Password, then try again."
  private static let personalVaultNames: Set<String> = ["private", "personal", "employee"]
  private static let personalVaultTypes: Set<String> = ["PERSONAL", "PRIVATE", "EMPLOYEE"]
  private static let mostVaultsChecked = 12
  private static let unknownVaultMessage = "Ardia couldn't tell which 1Password vault is yours, so save this login in 1Password."

  var environment: [String: String] {
    ["OP_INTEGRATION_NAME": "Ardia", "OP_INTEGRATION_ID": "ardia", "OP_INTEGRATION_BUILDNUMBER": Self.buildNumber]
  }

  func isolatedEnvironment(_ directory: String) -> [String: String] { ["OP_CONFIG_DIR": directory] }

  private static var buildNumber: String {
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    let release = version.split(separator: "-").first.map { String($0) } ?? ""
    let parts = release.split(separator: ".").map { part -> String in
      let digits = String(part).filter { $0.isASCII && $0.isNumber }
      return digits.count < 2 ? String(repeating: "0", count: 2 - digits.count) + digits : digits
    }
    let joined = parts.joined()
    return joined.isEmpty ? "000001" : joined
  }

  func state(_ cli: VaultCLI) async -> VaultProviderState {
    let listed = await accounts(cli)
    if let problem = listed.problem { return makeState(.unavailable, message: problem) }
    guard let account = chosenAccount(cli, in: listed.accounts) else { return makeState(.signedOut, message: Self.setupMessage) }
    let email = VaultJSON.string(account["email"])
    let server = VaultJSON.string(account["url"])
    return makeState(cli.session == nil ? .locked : .unlocked, account: email, server: server)
  }

  func signIn(_ cli: VaultCLI, fields: VaultSignInFields) async -> VaultSignInResult { await connect(cli, requested: fields.account) }

  func unlock(_ cli: VaultCLI, password: String?) async -> VaultSignInResult { await connect(cli, requested: nil) }

  func lock(_ cli: VaultCLI, session: String) async { await signOutOfApp(cli) }

  private func signOutOfApp(_ cli: VaultCLI) async {
    _ = await cli.run(["signout"] + accountFlag(cli), timeout: Self.signOutTimeout)
  }

  func signOut(_ cli: VaultCLI) async {
    await signOutOfApp(cli)
    cli.setPreference("account", nil)
  }

  func items(_ cli: VaultCLI) async throws -> VaultItemList {
    guard cli.session != nil else { throw VaultError.locked }
    let result = await cli.run(["item", "list", "--categories", "Login", "--format", "json"] + accountFlag(cli), timeout: Self.readTimeout)
    try check(result)
    return VaultItemList(items: try VaultJSON.list(result.stdout, from: Self.tool).compactMap { listedItem($0) })
  }

  func secret(_ cli: VaultCLI, id: String, field: VaultField) async throws -> String {
    let fields = try await revealedFields(cli, id: id)
    if field == .totp { return try await oneTimeCode(cli, id: id, fields: fields) }
    let purpose = field == .username ? "USERNAME" : "PASSWORD"
    guard let match = fields.first(where: { VaultJSON.string($0["purpose"]) == purpose }), let value = match["value"] as? String,
      !value.isEmpty
    else { throw VaultError.notFound }
    return value
  }

  func revealed(_ cli: VaultCLI, id: String) async throws -> VaultRevealed {
    let fields = try await revealedFields(cli, id: id)
    let password = fields.first { VaultJSON.string($0["purpose"]) == "PASSWORD" }.flatMap { $0["value"] as? String }
    let totp = fields.filter(Self.isOneTimeField).compactMap { $0["value"] as? String }
      .first { $0.lowercased().hasPrefix("otpauth://") && VaultTotpSecret($0) != nil }
    return VaultRevealed(password: password?.isEmpty == false ? password : nil, totp: totp)
  }

  private func revealedFields(_ cli: VaultCLI, id: String) async throws -> [[String: Any]] {
    guard cli.session != nil else { throw VaultError.locked }
    guard Self.isItemId(id) else { throw VaultError.notFound }
    return VaultJSON.dicts(try await revealedItem(cli, id: id)["fields"])
  }

  private func oneTimeCode(_ cli: VaultCLI, id: String, fields: [[String: Any]]) async throws -> String {
    let otpFields = fields.filter(Self.isOneTimeField)
    for otp in otpFields {
      if let uri = otp["value"] as? String, uri.lowercased().hasPrefix("otpauth://"), VaultTotpSecret(uri) != nil { return uri }
    }
    for otp in otpFields {
      if let code = otp["totp"] as? String, !code.isEmpty { return code }
    }
    guard !otpFields.isEmpty else { throw VaultError.notFound }
    let result = await cli.run(["item", "get", id, "--otp"] + accountFlag(cli), timeout: Self.readTimeout)
    try check(result)
    let code = result.trimmedOutput
    guard !code.isEmpty else { throw VaultError.notFound }
    return code
  }

  func save(_ cli: VaultCLI, login: VaultNewLogin) async throws -> VaultItem {
    guard cli.session != nil else { throw VaultError.locked }
    let vaultId = try await vaultForNewItems(cli)
    let usernameField: [String: Any] = ["id": "username", "type": "STRING", "purpose": "USERNAME", "label": "username", "value": login.username]
    let passwordField: [String: Any] = ["id": "password", "type": "CONCEALED", "purpose": "PASSWORD", "label": "password", "value": login.password]
    let primaryURL: [String: Any] = ["href": login.url, "primary": true]
    let template: [String: Any] = ["title": login.title, "category": "LOGIN", "fields": [usernameField, passwordField], "urls": [primaryURL]]
    guard let input = VaultJSON.data(template) else { throw VaultError.failed("Ardia couldn't prepare the login for 1Password.") }
    let arguments = ["item", "create", "-", "--vault=\(vaultId)", "--format=json"]
    let result = await cli.run(arguments + accountFlag(cli), input: input, timeout: Self.readTimeout)
    try check(result, redacting: [login.password])
    guard let created = VaultJSON.dict(VaultJSON.parse(result.stdout)), var item = listedItem(created) else {
      throw VaultError.failed("1Password saved the login but didn't say where. Check 1Password before saving it again.")
    }
    try await confirmCredentials(cli, id: item.id, login: login)
    if item.username.isEmpty { item.username = login.username }
    if item.urls.isEmpty { item.urls = [login.url] }
    return item
  }

  private func confirmCredentials(_ cli: VaultCLI, id: String, login: VaultNewLogin) async throws {
    let wanted = VaultLoginChange(username: login.username, password: login.password)
    let stored = try await revealedItem(cli, id: id)
    if VaultLoginEditPlan.onePasswordHolds(stored, wanted) { return }
    guard let repair = VaultLoginEditPlan.onePasswordCommand(id: id, item: stored, change: wanted, account: accountFlag(cli)) else {
      throw VaultError.failed(Self.incompleteSaveMessage(login.title))
    }
    let repaired = await cli.run(repair.arguments, input: repair.input, timeout: Self.readTimeout)
    try check(repaired, redacting: [login.password])
    guard VaultLoginEditPlan.onePasswordHolds(try await revealedItem(cli, id: id), wanted) else {
      throw VaultError.failed(Self.incompleteSaveMessage(login.title))
    }
  }

  private static func incompleteSaveMessage(_ title: String) -> String {
    "1Password made \"\(title)\" without its password. Update the 1Password CLI, then add the password in 1Password."
  }

  private func vaultForNewItems(_ cli: VaultCLI) async throws -> String {
    let listed = await cli.run(["vault", "list", "--format", "json"] + accountFlag(cli), timeout: Self.readTimeout)
    try check(listed)
    let vaults = try VaultJSON.list(listed.stdout, from: Self.tool).filter { VaultJSON.string($0["id"]).map(Self.isItemId) ?? false }
    let ids = vaults.compactMap { VaultJSON.string($0["id"]) }
    if let named = vaults.first(where: { Self.personalVaultNames.contains((VaultJSON.string($0["name"]) ?? "").lowercased()) }),
      let id = VaultJSON.string(named["id"])
    {
      return id
    }
    if let typed = vaults.first(where: { Self.personalVaultTypes.contains((VaultJSON.string($0["type"]) ?? "").uppercased()) }),
      let id = VaultJSON.string(typed["id"])
    {
      return id
    }
    for id in ids.prefix(Self.mostVaultsChecked) {
      let detail = await cli.run(["vault", "get", id, "--format", "json"] + accountFlag(cli), timeout: Self.readTimeout)
      guard detail.succeeded, let vault = try? VaultJSON.record(detail.stdout, from: Self.tool) else { continue }
      if Self.personalVaultTypes.contains((VaultJSON.string(vault["type"]) ?? "").uppercased()) { return id }
    }
    if ids.count == 1, let only = ids.first { return only }
    throw VaultError.failed(ids.isEmpty ? "No 1Password vault takes new items." : Self.unknownVaultMessage)
  }

  func addTotp(_ cli: VaultCLI, id: String, uri: String) async throws -> VaultItem {
    try await edit(cli, id: id, change: VaultLoginChange(totp: .set(uri)))
  }

  func edit(_ cli: VaultCLI, id: String, change: VaultLoginChange) async throws -> VaultItem {
    guard cli.session != nil else { throw VaultError.locked }
    guard VaultLoginEditPlan.isOnePasswordId(id) else { throw VaultError.notFound }
    let template = try await revealedItem(cli, id: id)
    guard let command = VaultLoginEditPlan.onePasswordCommand(id: id, item: template, change: change, account: accountFlag(cli)) else {
      throw VaultError.failed("Ardia couldn't prepare the change for 1Password.")
    }
    let result = await cli.run(command.arguments, input: command.input, timeout: Self.readTimeout)
    try check(result, redacting: VaultLoginEditPlan.onePasswordSecrets(template, change))
    guard let edited = VaultJSON.dict(VaultJSON.parse(result.stdout)), var saved = listedItem(edited) else {
      throw VaultError.failed("1Password saved the change but didn't return the login.")
    }
    if !VaultLoginEditPlan.onePasswordHolds(edited, change) {
      guard VaultLoginEditPlan.onePasswordHolds(try await revealedItem(cli, id: id), change) else {
        throw VaultError.failed("1Password didn't take the change. Update the 1Password CLI and try again.")
      }
    }
    if let username = change.validated()?.username { saved.username = username }
    return saved
  }

  private func revealedItem(_ cli: VaultCLI, id: String) async throws -> [String: Any] {
    let result = await cli.run(["item", "get", id, "--format", "json", "--reveal"] + accountFlag(cli), timeout: Self.readTimeout)
    try check(result)
    return try VaultJSON.record(result.stdout, from: Self.tool)
  }

  private static func isOneTimeField(_ field: [String: Any]) -> Bool { VaultLoginEditPlan.isOneTimeField(field) }

  private func accounts(_ cli: VaultCLI) async -> (accounts: [[String: Any]], problem: String?) {
    let result = await cli.run(["account", "list", "--format", "json"], timeout: Self.accountsTimeout)
    if result.succeeded {
      guard let listed = try? VaultJSON.list(result.stdout, from: Self.tool) else {
        return ([], VaultJSON.unreadableMessage(Self.tool))
      }
      return (listed, nil)
    }
    if VaultMessages.mentions(result, ["no accounts", "no account found"]) { return ([], nil) }
    return ([], VaultMessages.failure(result, tool: Self.tool))
  }

  private func chosenAccount(_ cli: VaultCLI, in accounts: [[String: Any]]) -> [String: Any]? {
    if let chosen = cli.preference("account") {
      let keys = ["account_uuid", "shorthand", "url", "email", "user_uuid"]
      if let match = accounts.first(where: { account in keys.contains { VaultJSON.string(account[$0]) == chosen } }) { return match }
      cli.setPreference("account", nil)
    }
    return accounts.first
  }

  private func accountFlag(_ cli: VaultCLI) -> [String] {
    guard let account = cli.preference("account") else { return [] }
    return ["--account=\(account)"]
  }

  private func connect(_ cli: VaultCLI, requested: String?) async -> VaultSignInResult {
    let listed = await accounts(cli)
    if let problem = listed.problem { return failed(problem, state: .unavailable) }
    if let requested { cli.setPreference("account", requested) }
    guard let account = chosenAccount(cli, in: listed.accounts),
      let reference = VaultJSON.string(account["account_uuid"]) ?? VaultJSON.string(account["shorthand"]) ?? VaultJSON.string(account["url"])
    else { return failed(Self.setupMessage, state: .signedOut) }
    cli.setPreference("account", reference)
    let result = await cli.runSigningIn(["vault", "list", "--format", "json"] + accountFlag(cli), timeout: Self.approvalTimeout)
    if result.cancelled { return stopped(state: .locked) }
    guard result.succeeded else { return failed(connectMessage(result)) }
    cli.remember(session: Self.marker)
    return signedIn()
  }

  private func connectMessage(_ result: VaultCommandResult) -> String {
    if result.timedOut { return "1Password didn't confirm in time. Approve Ardia in 1Password and try again." }
    if VaultMessages.mentions(result, ["dismissed", "denied", "cancel"]) { return "1Password stayed locked." }
    if VaultMessages.mentions(result, ["cannot connect", "connect to the 1password app", "desktop app"]) {
      return "Ardia couldn't reach 1Password. Open it and try again."
    }
    return VaultMessages.failure(result, tool: Self.tool)
  }

  private func check(_ result: VaultCommandResult, redacting secrets: [String] = []) throws {
    try checked(result, tool: Self.tool, locked: Self.lockedHints, signedOut: ["no accounts configured"], missing: Self.missingHints,
                redacting: secrets)
  }

  private func listedItem(_ entry: [String: Any]) -> VaultItem? {
    guard let itemId = VaultJSON.string(entry["id"]) else { return nil }
    let urls = VaultJSON.dicts(entry["urls"]).compactMap { VaultJSON.string($0["href"]) }
    let vault = VaultJSON.dict(entry["vault"]).flatMap { VaultJSON.string($0["name"]) }
    return VaultItem(
      provider: id, id: itemId, title: VaultJSON.string(entry["title"]) ?? "", username: VaultJSON.string(entry["additional_information"]) ?? "",
      urls: urls, hasTotp: nil, vault: vault, favorite: VaultJSON.bool(entry["favorite"]), updatedAt: VaultJSON.milliseconds(entry["updated_at"]))
  }

  private static func isItemId(_ id: String) -> Bool { VaultLoginEditPlan.isOnePasswordId(id) }
}
