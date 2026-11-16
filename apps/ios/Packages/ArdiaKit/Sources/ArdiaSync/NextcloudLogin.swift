@preconcurrency import ArdiaSyncCore
import Foundation

public struct NextcloudLoginStart: Sendable, Equatable {
  public let server: URL
  public let loginURL: URL
  let endpoint: URL
  let token: String
}

public struct NextcloudLogin: Sendable {
  public let transport: NextcloudTransport

  public init(transport: NextcloudTransport = .live) {
    self.transport = transport
  }

  public static func serverURL(from text: String) throws -> URL {
    var trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    while trimmed.hasSuffix("/") { trimmed.removeLast() }
    for suffix in ["/index.php", "/login"] where trimmed.lowercased().hasSuffix(suffix) {
      trimmed.removeLast(suffix.count)
    }
    guard !trimmed.isEmpty else { throw NextcloudProblem.unreachable }
    let lower = trimmed.lowercased()
    if lower.hasPrefix("http://") { throw NextcloudProblem.insecure }
    if !lower.hasPrefix("https://") { trimmed = "https://" + trimmed }
    guard let url = URL(string: trimmed), url.scheme?.lowercased() == "https", let host = url.host(), !host.isEmpty else { throw NextcloudProblem.unreachable }
    return url
  }

  private struct StartReply: Decodable {
    struct Poll: Decodable {
      var token: String
      var endpoint: String
    }

    var poll: Poll
    var login: String
  }

  private struct PollReply: Decodable {
    var server: String
    var loginName: String
    var appPassword: String
  }

  private struct UserReply: Decodable {
    struct OCS: Decodable {
      struct User: Decodable {
        var id: String
      }

      var data: User
    }

    var ocs: OCS
  }

  public func begin(server: URL) async throws -> NextcloudLoginStart {
    let client = NextcloudClient(transport: transport)
    let request = NextcloudClient.request(server.appending(path: "index.php/login/v2"), method: "POST", account: nil, headers: ["Accept": "application/json", "User-Agent": "Ardia for iPhone"])
    let (response, data) = try await client.send(request)
    guard response.statusCode == 200 else { throw response.statusCode == 404 ? NextcloudProblem.notNextcloud : NextcloudProblem.refused(response.statusCode) }
    guard let reply = try? JSONDecoder().decode(StartReply.self, from: data),
          let endpoint = URL(string: reply.poll.endpoint), let login = URL(string: reply.login)
    else { throw NextcloudProblem.notNextcloud }
    guard Self.sameSecureHost(endpoint, server), login.scheme?.lowercased() == "https" else { throw NextcloudProblem.insecure }
    return NextcloudLoginStart(server: server, loginURL: login, endpoint: endpoint, token: reply.poll.token)
  }

  public func poll(_ start: NextcloudLoginStart) async throws -> NextcloudAccount? {
    let client = NextcloudClient(transport: transport)
    var form = URLComponents()
    form.queryItems = [URLQueryItem(name: "token", value: start.token)]
    let body = Data((form.percentEncodedQuery ?? "").utf8)
    let request = NextcloudClient.request(start.endpoint, method: "POST", account: nil, body: body, headers: ["Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"])
    let (response, data) = try await client.send(request)
    if response.statusCode == 404 { return nil }
    guard response.statusCode == 200 else { throw NextcloudProblem.refused(response.statusCode) }
    guard let reply = try? JSONDecoder().decode(PollReply.self, from: data) else { throw NextcloudProblem.notNextcloud }
    let server = try Self.serverURL(from: reply.server)
    let unnamed = NextcloudAccount(server: server, userId: reply.loginName, loginName: reply.loginName, appPassword: reply.appPassword)
    do {
      return try await userAccount(unnamed)
    } catch {
      await revoke(unnamed)
      throw error
    }
  }

  public func waitForAccount(_ start: NextcloudLoginStart, every interval: Duration = .seconds(2), giveUpAfter limit: Duration = .seconds(20 * 60)) async throws -> NextcloudAccount {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: limit)
    while clock.now < deadline {
      try Task.checkCancellation()
      do {
        if let account = try await poll(start) { return account }
      } catch NextcloudProblem.unreachable {
      }
      try await Task.sleep(for: interval)
    }
    throw NextcloudProblem.signInNeeded
  }

  func userAccount(_ account: NextcloudAccount) async throws -> NextcloudAccount {
    let client = NextcloudClient(transport: transport)
    var url = account.server.appending(path: "ocs/v2.php/cloud/user")
    url.append(queryItems: [URLQueryItem(name: "format", value: "json")])
    let request = NextcloudClient.request(url, method: "GET", account: account, headers: ["OCS-APIRequest": "true", "Accept": "application/json"])
    let (response, data) = try await client.send(request)
    if response.statusCode == 401 { throw NextcloudProblem.signInNeeded }
    guard response.statusCode == 200 else { throw NextcloudProblem.refused(response.statusCode) }
    guard let id = (try? JSONDecoder().decode(UserReply.self, from: data))?.ocs.data.id, !id.isEmpty else { throw NextcloudProblem.notNextcloud }
    var named = account
    named.userId = id
    return named
  }

  public func revoke(_ account: NextcloudAccount) async {
    let client = NextcloudClient(transport: transport)
    let request = NextcloudClient.request(account.server.appending(path: "ocs/v2.php/core/apppassword"), method: "DELETE", account: account, headers: ["OCS-APIRequest": "true", "Accept": "application/json"])
    _ = try? await client.send(request)
  }

  func searchChain(_ account: NextcloudAccount, chainTag: String) async throws -> [String] {
    let client = NextcloudClient(transport: transport)
    let scope = "/files/" + account.userId
    let body = """
    <?xml version="1.0" encoding="UTF-8"?>
    <d:searchrequest xmlns:d="DAV:">
      <d:basicsearch>
        <d:select><d:prop><d:resourcetype/></d:prop></d:select>
        <d:from><d:scope><d:href>\(Self.escapedXML(scope))</d:href><d:depth>infinity</d:depth></d:scope></d:from>
        <d:where><d:eq><d:prop><d:displayname/></d:prop><d:literal>\(chainTag)</d:literal></d:eq></d:where>
        <d:orderby/>
      </d:basicsearch>
    </d:searchrequest>
    """
    let url = account.server.appending(path: "remote.php/dav/")
    let request = NextcloudClient.request(url, method: "SEARCH", account: account, body: Data(body.utf8), headers: ["Content-Type": "text/xml; charset=utf-8"])
    let (response, data) = try await client.send(request)
    if response.statusCode == 401 { throw NextcloudProblem.signInNeeded }
    guard response.statusCode == 207, let entries = WebDAV.parse(data) else { throw NextcloudProblem.refused(response.statusCode) }
    let base = WebDAV.normalized(account.davBase.path(percentEncoded: false))
    var paths: [String] = []
    for entry in entries where entry.succeeded && entry.isCollection && entry.name == chainTag {
      guard let range = entry.path.range(of: base + "/") else { continue }
      let relative = String(entry.path[range.upperBound...])
      let parent = NextcloudAccount.normalizedPath((relative as NSString).deletingLastPathComponent)
      if !paths.contains(parent) { paths.append(parent) }
    }
    return paths
  }

  public struct Found: Sendable {
    public var path: String
    public var check: FolderCheck
  }

  public func locate(_ account: NextcloudAccount, entropy: Data, typedPath: String?) async throws -> Found {
    let chainTag = SyncKeys(entropy: entropy).chainTag
    let typed = typedPath.map(NextcloudAccount.normalizedPath).flatMap { $0.isEmpty ? nil : $0 }
    var candidates: [(path: String, absence: NextcloudProblem?)]
    if let typed {
      candidates = [(typed, .folderNotFound)]
    } else {
      var found: [String] = []
      do {
        found = try await searchChain(account, chainTag: chainTag)
      } catch NextcloudProblem.signInNeeded {
        throw NextcloudProblem.signInNeeded
      } catch is CancellationError {
        throw CancellationError()
      } catch {
      }
      candidates = found.map { ($0, .unreachable) } + SyncFolderAccess.folderNames.filter { !found.contains($0) }.map { ($0, nil) }
    }
    var mismatch: String?
    var listed: String?
    for candidate in candidates {
      guard let names = try await rootNames(account, path: candidate.path) else {
        if let absence = candidate.absence { throw absence }
        continue
      }
      listed = listed ?? candidate.path
      let check = SyncEngine.check(entropy: entropy, names: names)
      if check == .matches { return Found(path: candidate.path, check: check) }
      if check == .mismatch, mismatch == nil { mismatch = candidate.path }
    }
    if let mismatch { return Found(path: mismatch, check: .mismatch) }
    return Found(path: listed ?? candidates.first?.path ?? "", check: .noSyncData)
  }

  func rootNames(_ account: NextcloudAccount, path: String) async throws -> [String]? {
    let client = NextcloudClient(transport: transport)
    let url = account.folderURL(path)
    let request = NextcloudClient.request(url, method: "PROPFIND", account: account, body: WebDAV.propfindBody, headers: ["Depth": "1", "Content-Type": "application/xml; charset=utf-8"])
    let (response, data) = try await client.send(request)
    switch response.statusCode {
    case 207:
      guard let entries = WebDAV.parse(data), let children = WebDAV.children(of: url, in: entries, strictAbout: WebDAV.isChainName) else { throw NextcloudProblem.notNextcloud }
      return children.map(\.name)
    case 404: return nil
    case 401: throw NextcloudProblem.signInNeeded
    default: throw NextcloudProblem.refused(response.statusCode)
    }
  }

  static func sameSecureHost(_ url: URL, _ server: URL) -> Bool {
    url.scheme?.lowercased() == "https" && url.host()?.lowercased() == server.host()?.lowercased() && url.port == server.port
  }

  static func escapedXML(_ text: String) -> String {
    text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
  }
}
