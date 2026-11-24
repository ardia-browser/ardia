import Foundation
import os

final class VaultFakeProvider: VaultPasskeyHolder, VaultProviderSource, @unchecked Sendable {
  static let id = "bigvault"
  private static var installed: VaultFakeProvider?

  static func installIfAsked() {
    let config = LaunchConfig.shared
    guard config.background, installed == nil, let asked = config.testValue("vaultFakeItems"), let count = Int(asked), count > 0 else { return }
    let provider = VaultFakeProvider(count: count)
    installed = provider
    VaultRegistry.add(provider)
  }

  private let count: Int
  private let edits = OSAllocatedUnfairLock(initialState: [String: VaultItem]())

  init(count: Int) { self.count = count }

  var vaultProviders: [any VaultProvider] { [self] }
  var id: String { Self.id }
  var name: String { "Big Vault" }
  var binaryName: String { "bigvault" }
  var capabilities: VaultCapabilities {
    VaultCapabilities(totp: true, save: true, selfHosted: false, masterPassword: false, touchID: true, addTotp: true, edit: true, passkeys: true)
  }
  var install: VaultInstall { VaultInstall(command: "true", url: "https://example.com", update: "true") }

  func described(_ state: VaultProviderState) -> VaultProviderState {
    var described = state
    described.plugin = id
    described.title = name
    described.symbol = "key.horizontal.fill"
    described.accent = "#1A73E8"
    described.signIn = VaultSignInDescriptor(methods: [
      VaultSignInDescriptor.Method(id: "app", title: "Big Vault App", kind: "desktopApproval", fields: []),
    ])
    return described
  }

  func state(_ cli: VaultCLI) async -> VaultProviderState {
    makeState(cli.session == nil ? .signedOut : .unlocked, account: "sam@example.com")
  }

  func signIn(_ cli: VaultCLI, fields: VaultSignInFields) async -> VaultSignInResult {
    cli.remember(session: "fake-session", persistent: false)
    return VaultSignInResult(ok: true, state: makeState(.unlocked, account: "sam@example.com"))
  }

  func unlock(_ cli: VaultCLI, password: String?) async -> VaultSignInResult { await signIn(cli, fields: VaultSignInFields(json: "{}")) }

  func signOut(_ cli: VaultCLI) async {}

  func items(_ cli: VaultCLI) async throws -> VaultItemList {
    let changed = edits.withLock { $0 }
    return VaultItemList(items: (0..<count).map { changed[Self.itemId($0)] ?? Self.item($0) })
  }

  func secret(_ cli: VaultCLI, id: String, field: VaultField) async throws -> String { "fake-\(id)" }

  func edit(_ cli: VaultCLI, id: String, change: VaultLoginChange) async throws -> VaultItem {
    guard let index = Self.index(of: id), index < count else { throw VaultError.notFound }
    return edits.withLock { changed in
      var item = changed[id] ?? Self.item(index)
      if let username = change.username { item.username = username }
      if let url = change.url { item.urls = [url] + item.urls.dropFirst() }
      switch change.totp {
      case .set: item.hasTotp = true
      case .remove: item.hasTotp = false
      case .unchanged: break
      }
      item.updatedAt = Date().timeIntervalSince1970 * 1000
      changed[id] = item
      return item
    }
  }

  func passkeySigner(_ cli: VaultCLI, item: String, credential: Data, rpId: String) async throws -> VaultPasskeySigner? { nil }

  func savePasskey(_ cli: VaultCLI, credential: VaultNewPasskey, attachTo item: String?, title: String, url: String) async throws -> String {
    throw VaultError.unsupported
  }

  private static let words = [
    "acme", "north", "orbit", "maple", "harbor", "pixel", "summit", "cedar", "lumen", "vector", "quartz", "atlas", "river", "ember", "nova",
    "polar", "zephyr", "copper", "willow", "falcon", "meadow", "cobalt", "aurora", "granite", "lagoon", "saffron", "tundra", "velvet",
  ]
  private static let tlds = ["com", "io", "net", "org", "co.uk", "dev", "app", "de", "fr", "com.au"]
  private static let vaults = ["Private", "Work", "Shared with Family", "Archive", "Engineering Team Credentials"]
  private static let hosts = ["", "login.", "accounts.", "app.", "www.", "id.", "auth."]

  static func itemId(_ index: Int) -> String { String(format: "bv%06d", index) }
  static func index(of id: String) -> Int? { id.hasPrefix("bv") ? Int(id.dropFirst(2)) : nil }

  static func item(_ index: Int) -> VaultItem {
    var seed = UInt64(truncatingIfNeeded: index &* 2_654_435_761 &+ 97)
    func next() -> Int {
      seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
      return Int(truncatingIfNeeded: (seed >> 33) & 0x7fff_ffff)
    }
    let site = index % 9000
    let brand = "\(words[site % words.count])\(words[(site / words.count) % words.count])\(site)"
    let domain = "\(brand).\(tlds[site % tlds.count])"
    let siteCount = 1 + next() % 6
    let urls = (0..<siteCount).map { offset -> String in
      offset == 0 ? "https://\(hosts[next() % hosts.count])\(domain)/" : "https://\(hosts[(offset + 1) % hosts.count])\(brand)-alt\(offset).\(tlds[(site + offset) % tlds.count])/sign-in"
    }
    let long = next() % 5 == 0
    let title = long
      ? "\(brand.capitalized) (\(vaults[index % vaults.count]) account for the quarterly reporting dashboard and billing portal #\(index))"
      : "\(brand.capitalized)"
    let username = next() % 7 == 0 ? "" : next() % 3 == 0 ? "sam.\(words[next() % words.count])\(index % 97)" : "sam+\(index % 211)@example.com"
    let hasPasskey = index % 20 == 0
    let passkeys = hasPasskey
      ? [VaultItemPasskey(credentialId: "cGs\(itemId(index))", rpId: domain, userName: username, displayName: "Sam Example", discoverable: true, counter: 0)]
      : nil
    return VaultItem(provider: Self.id, id: itemId(index), title: title, username: username, urls: urls, hasTotp: next() % 5 < 2,
                     vault: vaults[next() % vaults.count], favorite: next() % 30 == 0, updatedAt: Double(1_700_000_000_000 + index * 60_000),
                     totpPeriod: 30, passkeys: passkeys)
  }
}
