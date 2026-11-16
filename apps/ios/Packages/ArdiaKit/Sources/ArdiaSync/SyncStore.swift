@preconcurrency import ArdiaSyncCore
import Foundation

struct SyncStoreListing {
  struct File {
    var id: String
    var payload: Data
  }

  var files: [File] = []
  var pending: [String] = []
  var damaged: [(id: String, age: TimeInterval)] = []
  var present: [String] = []
}

struct SyncSignInNeeded: Error {}

protocol SyncStore: AnyObject, Sendable {
  func rootNames() throws -> [String]
  func read(scope: String, skipping known: Set<String>) throws -> SyncStoreListing
  func write(scope: String, payload: Data) throws -> String
  func remove(scope: String, ids: [String]) throws
  func cancel()
  func resume()
}

final class FolderStore: SyncStore, @unchecked Sendable {
  let grant: SyncFolderGrant
  let vault: SyncVault
  private let keys: SyncKeys
  private let coordination: SyncCoordination

  init(grant: SyncFolderGrant, keys: SyncKeys, coordination: SyncCoordination) {
    self.grant = grant
    self.keys = keys
    self.coordination = coordination
    vault = SyncVault(folder: grant.folder, keys: keys)
    vault.coordination = coordination
  }

  func rootNames() throws -> [String] {
    guard let names = SyncFolderAccess.coordinatedListing(vault.folder, coordination: coordination) else { throw SyncCoordination.TimedOut() }
    return names
  }

  func read(scope: String, skipping known: Set<String>) throws -> SyncStoreListing {
    let folder = vault.chainURL.appendingPathComponent(keys.scopeTag(scope), isDirectory: true)
    if SyncFolderAccess.isDirectory(folder), SyncFolderAccess.coordinatedListing(folder, coordination: coordination) == nil {
      throw SyncCoordination.TimedOut()
    }
    let listing = try vault.read(scope: scope, skipping: known)
    if listing.timedOut { throw SyncCoordination.TimedOut() }
    return SyncStoreListing(listing)
  }

  func write(scope: String, payload: Data) throws -> String {
    try vault.write(scope: scope, payload: payload)
  }

  func remove(scope: String, ids: [String]) throws {
    try vault.remove(scope: scope, ids: ids)
  }

  func cancel() {
    coordination.cancelAll()
  }

  func resume() {
    coordination.resume()
  }
}

extension SyncStoreListing {
  init(_ listing: SyncVault.Listing) {
    files = listing.files.map { File(id: $0.id, payload: $0.payload) }
    pending = listing.pending
    damaged = listing.damaged
    present = listing.present
  }
}

public enum SyncLocation: Sendable {
  case folder(SyncFolderGrant)
  case nextcloud(NextcloudConnection)

  func makeStore(keys: SyncKeys, coordination: SyncCoordination) -> any SyncStore {
    switch self {
    case .folder(let grant): FolderStore(grant: grant, keys: keys, coordination: coordination)
    case .nextcloud(let connection): NextcloudStore(connection: connection, keys: keys)
    }
  }
}
