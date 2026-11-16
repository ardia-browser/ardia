@preconcurrency import ArdiaSyncCore
import Foundation

enum SavedLocation: Equatable, Sendable {
  case folder(SyncFolderLocation)
  case nextcloud(NextcloudLocation)
}

struct SyncStoreResolver {
  let passwords: any SyncKeyStore
  let transport: NextcloudTransport

  enum Resolution {
    case ready(SyncLocation, refreshed: SyncFolderLocation?)
    case needsAccess
  }

  func resolve(_ meta: SyncMeta) -> Resolution {
    if let nextcloud = meta.nextcloud {
      guard let account = account(nextcloud) else { return .needsAccess }
      return .ready(.nextcloud(NextcloudConnection(account: account, path: nextcloud.path, transport: transport)), refreshed: nil)
    }
    guard let folder = meta.folder, case .resolved(let grant, let refreshed) = SyncFolderAccess.resolve(folder) else { return .needsAccess }
    return .ready(.folder(grant), refreshed: refreshed)
  }

  func account(_ location: NextcloudLocation) -> NextcloudAccount? {
    guard let server = URL(string: location.server), let secret = passwords.load(account: location.keychainAccount),
          let password = String(data: secret, encoding: .utf8), !password.isEmpty
    else { return nil }
    return NextcloudAccount(server: server, userId: location.userId, loginName: location.loginName, appPassword: password)
  }

  func save(_ account: NextcloudAccount, path: String) -> NextcloudLocation? {
    let keychainAccount = "nextcloud-" + SyncKeys.newFileId()
    guard passwords.save(Data(account.appPassword.utf8), account: keychainAccount) else { return nil }
    return NextcloudLocation(server: account.server.absoluteString, userId: account.userId, loginName: account.loginName, path: NextcloudAccount.normalizedPath(path), keychainAccount: keychainAccount)
  }

  @discardableResult
  func forget(_ location: NextcloudLocation, keeping live: NextcloudLocation? = nil) -> Task<Void, Never>? {
    let account = account(location)
    let inUse = live.flatMap { self.account($0) }
    passwords.delete(account: location.keychainAccount)
    guard let account, inUse.map(account.sharesCredential) != true else { return nil }
    let login = NextcloudLogin(transport: transport)
    return Task.detached { await login.revoke(account) }
  }

  func discard(_ saved: SavedLocation) {
    if case .nextcloud(let location) = saved { passwords.delete(account: location.keychainAccount) }
  }
}
