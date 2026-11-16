@preconcurrency import ArdiaSyncCore
import Foundation

final class NextcloudStore: SyncStore, @unchecked Sendable {
  let connection: NextcloudConnection
  private let client: NextcloudClient
  private let keys: SyncKeys
  private let lock = NSLock()
  private var failed = false
  private let now: @Sendable () -> Date

  init(connection: NextcloudConnection, keys: SyncKeys, now: @escaping @Sendable () -> Date = Date.init) {
    self.connection = connection
    self.keys = keys
    self.now = now
    client = NextcloudClient(transport: connection.transport)
  }

  var root: URL { connection.account.folderURL(connection.path) }
  var chain: URL { root.appending(component: keys.chainTag, directoryHint: .isDirectory) }
  func scopeURL(_ scope: String) -> URL { chain.appending(component: keys.scopeTag(scope), directoryHint: .isDirectory) }
  func fileURL(_ scope: String, _ id: String) -> URL { scopeURL(scope).appending(component: "\(id).\(SyncVault.fileExtension)") }

  func rootNames() throws -> [String] {
    guard let entries = try list(root, strictAbout: WebDAV.isChainName) else { throw unavailable() }
    return entries.map(\.name)
  }

  func read(scope: String, skipping known: Set<String>) throws -> SyncStoreListing {
    var listing = SyncStoreListing()
    guard let entries = try list(scopeURL(scope), strictAbout: WebDAV.isSyncFileName) else { return listing }
    let suffix = ".\(SyncVault.fileExtension)"
    let scopeTag = keys.scopeTag(scope)
    for entry in entries.sorted(by: { $0.name < $1.name }) where !entry.isCollection && entry.name.hasSuffix(suffix) {
      let id = String(entry.name.dropLast(suffix.count))
      guard SyncFolderAccess.isChainTag(id), !listing.present.contains(id) else { continue }
      if known.contains(id) {
        listing.present.append(id)
        continue
      }
      let (response, data) = try perform(NextcloudClient.request(fileURL(scope, id), method: "GET", account: connection.account))
      switch response.statusCode {
      case 200:
        listing.present.append(id)
        do {
          listing.files.append(.init(id: id, payload: try keys.open(data, scopeTag: scopeTag, fileId: id)))
        } catch {
          listing.damaged.append((id, max(0, now().timeIntervalSince(entry.modified ?? now()))))
        }
      case 404, 410: continue
      default: throw unavailable()
      }
    }
    return listing
  }

  func write(scope: String, payload: Data) throws -> String {
    let id = SyncKeys.newFileId()
    let sealed = try keys.seal(payload, scopeTag: keys.scopeTag(scope), fileId: id)
    let put = NextcloudClient.request(fileURL(scope, id), method: "PUT", account: connection.account, body: sealed, headers: ["Content-Type": "application/octet-stream"])
    var status = try perform(put).0.statusCode
    if status == 404 || status == 409 {
      let made = try perform(NextcloudClient.request(scopeURL(scope), method: "MKCOL", account: connection.account)).0.statusCode
      guard made == 201 || made == 405 else { throw unavailable() }
      status = try perform(put).0.statusCode
    }
    guard (200..<300).contains(status) else { throw unavailable() }
    return id
  }

  func remove(scope: String, ids: [String]) throws {
    for id in ids {
      let status = try perform(NextcloudClient.request(fileURL(scope, id), method: "DELETE", account: connection.account)).0.statusCode
      guard (200..<300).contains(status) || status == 404 || status == 410 else { throw unavailable() }
    }
  }

  func cancel() {
    lock.withLock { failed = true }
    client.cancel()
  }

  func resume() {
    lock.withLock { failed = false }
    client.resume()
  }

  func list(_ url: URL, strictAbout matters: (String) -> Bool) throws -> [DAVEntry]? {
    let request = NextcloudClient.request(url, method: "PROPFIND", account: connection.account, body: WebDAV.propfindBody, headers: ["Depth": "1", "Content-Type": "application/xml; charset=utf-8"])
    let (response, data) = try perform(request)
    switch response.statusCode {
    case 207: break
    case 404: return nil
    default: throw unavailable()
    }
    guard let entries = WebDAV.parse(data), let children = WebDAV.children(of: url, in: entries, strictAbout: matters) else { throw unavailable() }
    return children
  }

  private func perform(_ request: URLRequest) throws -> (HTTPURLResponse, Data) {
    if lock.withLock({ failed }) { throw SyncCoordination.TimedOut() }
    let result: (HTTPURLResponse, Data)
    do {
      result = try client.sendBlocking(request)
    } catch {
      throw unavailable()
    }
    if result.0.statusCode == 401 {
      lock.withLock { failed = true }
      throw SyncSignInNeeded()
    }
    return result
  }

  private func unavailable() -> Error {
    lock.withLock { failed = true }
    return SyncCoordination.TimedOut()
  }
}
