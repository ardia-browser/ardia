@preconcurrency import ArdiaSyncCore
import Foundation

public struct NextcloudAccount: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var server: URL
  public var userId: String
  public var loginName: String
  var appPassword: String

  public init(server: URL, userId: String, loginName: String, appPassword: String) {
    self.server = server
    self.userId = userId
    self.loginName = loginName
    self.appPassword = appPassword
  }

  public var host: String { server.host() ?? server.absoluteString }
  public var description: String { "\(loginName) on \(host)" }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: ["server": server, "userId": userId, "loginName": loginName]) }

  var davBase: URL {
    server.appending(component: "remote.php").appending(component: "dav").appending(component: "files").appending(component: userId, directoryHint: .isDirectory)
  }

  func folderURL(_ path: String) -> URL {
    NextcloudAccount.components(of: path).reduce(davBase) { $0.appending(component: $1, directoryHint: .isDirectory) }
  }

  func sharesCredential(with other: NextcloudAccount) -> Bool {
    server == other.server && loginName == other.loginName && appPassword == other.appPassword
  }

  var authorization: String { "Basic " + Data("\(loginName):\(appPassword)".utf8).base64EncodedString() }

  static func components(of path: String) -> [String] {
    path.split(separator: "/").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty && $0 != "." && $0 != ".." }
  }

  public static func normalizedPath(_ path: String) -> String {
    components(of: path).joined(separator: "/")
  }
}

public struct NextcloudLocation: Codable, Equatable, Sendable {
  public var server: String
  public var userId: String
  public var loginName: String
  public var path: String
  public var keychainAccount: String

  public init(server: String, userId: String, loginName: String, path: String, keychainAccount: String) {
    self.server = server
    self.userId = userId
    self.loginName = loginName
    self.path = path
    self.keychainAccount = keychainAccount
  }

  public var host: String { URL(string: server)?.host() ?? server }
}

public struct NextcloudTransport: Sendable {
  public var timeout: TimeInterval
  var configuration: @Sendable () -> URLSessionConfiguration

  public init(timeout: TimeInterval = 20, configuration: @escaping @Sendable () -> URLSessionConfiguration = { .ephemeral }) {
    self.timeout = timeout
    self.configuration = configuration
  }

  public static let live = NextcloudTransport()

  func makeSession() -> URLSession {
    let configuration = configuration()
    configuration.timeoutIntervalForRequest = timeout
    configuration.timeoutIntervalForResource = timeout * 3
    configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    configuration.urlCache = nil
    configuration.urlCredentialStorage = nil
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.waitsForConnectivity = false
    return URLSession(configuration: configuration, delegate: SameHostRedirects(), delegateQueue: nil)
  }
}

public struct NextcloudConnection: Sendable {
  public var account: NextcloudAccount
  public var path: String
  public var transport: NextcloudTransport

  public init(account: NextcloudAccount, path: String, transport: NextcloudTransport = .live) {
    self.account = account
    self.path = NextcloudAccount.normalizedPath(path)
    self.transport = transport
  }
}

public enum NextcloudProblem: Error, Equatable, Sendable, CustomStringConvertible {
  case insecure
  case certificate
  case unreachable
  case signInNeeded
  case notNextcloud
  case folderNotFound
  case refused(Int)

  public var message: String {
    switch self {
    case .insecure: "Ardia only connects to Nextcloud over https. Check the server address."
    case .certificate: "Ardia couldn’t make a secure connection to this server. Check its certificate."
    case .unreachable: "Ardia can’t reach this server. Check the address and your connection, then try again."
    case .signInNeeded: "Sign in to Nextcloud again."
    case .notNextcloud: "This doesn’t look like a Nextcloud server. Check the address."
    case .folderNotFound: "Ardia can’t find this folder in Nextcloud. Check its path, or leave it empty to find it automatically."
    case .refused: "The server refused the request. Try again later."
    }
  }

  public var description: String { message }
}

final class SameHostRedirects: NSObject, URLSessionTaskDelegate, Sendable {
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
    completionHandler(Self.allows(from: task.originalRequest?.url, to: request.url) ? request : nil)
  }

  static func allows(from: URL?, to: URL?) -> Bool {
    guard let from, let to, to.scheme?.lowercased() == "https", let host = to.host()?.lowercased() else { return false }
    return host == from.host()?.lowercased() && to.port == from.port
  }
}

final class NextcloudClient: @unchecked Sendable {
  private let session: URLSession
  let timeout: TimeInterval
  private let lock = NSLock()
  private var tasks: [Int: URLSessionTask] = [:]
  private var cancelled = false

  init(transport: NextcloudTransport) {
    session = transport.makeSession()
    timeout = transport.timeout
  }

  deinit {
    session.invalidateAndCancel()
  }

  func cancel() {
    let running = lock.withLock {
      cancelled = true
      return Array(tasks.values)
    }
    for task in running { task.cancel() }
  }

  func resume() {
    lock.withLock { cancelled = false }
  }

  private final class Outcome: @unchecked Sendable {
    var data: Data?
    var response: URLResponse?
    var error: Error?
  }

  func sendBlocking(_ request: URLRequest) throws -> (HTTPURLResponse, Data) {
    guard request.url?.scheme?.lowercased() == "https" else { throw NextcloudProblem.insecure }
    let done = DispatchSemaphore(value: 0)
    let outcome = Outcome()
    let task = session.dataTask(with: request) { data, response, error in
      outcome.data = data
      outcome.response = response
      outcome.error = error
      done.signal()
    }
    let started = lock.withLock { () -> Bool in
      guard !cancelled else { return false }
      tasks[task.taskIdentifier] = task
      return true
    }
    guard started else { throw NextcloudProblem.unreachable }
    task.resume()
    let finished = done.wait(timeout: .now() + timeout + min(timeout, 2)) == .success
    lock.withLock { tasks[task.taskIdentifier] = nil }
    guard finished else {
      task.cancel()
      throw NextcloudProblem.unreachable
    }
    if let error = outcome.error { throw Self.classify(error) }
    guard let response = outcome.response as? HTTPURLResponse else { throw NextcloudProblem.unreachable }
    return (response, outcome.data ?? Data())
  }

  func send(_ request: URLRequest) async throws -> (HTTPURLResponse, Data) {
    guard request.url?.scheme?.lowercased() == "https" else { throw NextcloudProblem.insecure }
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch is CancellationError {
      throw CancellationError()
    } catch let error as URLError where error.code == .cancelled && Task.isCancelled {
      throw CancellationError()
    } catch {
      throw Self.classify(error)
    }
    guard let response = response as? HTTPURLResponse else { throw NextcloudProblem.unreachable }
    return (response, data)
  }

  static func classify(_ error: Error) -> NextcloudProblem {
    guard let error = error as? URLError else { return .unreachable }
    switch error.code {
    case .appTransportSecurityRequiresSecureConnection: return .insecure
    case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot,
         .clientCertificateRejected, .clientCertificateRequired, .secureConnectionFailed:
      return .certificate
    default: return .unreachable
    }
  }

  static func request(_ url: URL, method: String, account: NextcloudAccount?, body: Data? = nil, headers: [String: String] = [:]) -> URLRequest {
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.httpBody = body
    request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    if let account { request.setValue(account.authorization, forHTTPHeaderField: "Authorization") }
    for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
    return request
  }
}

struct DAVEntry: Equatable {
  var path: String
  var origin: String?
  var isCollection: Bool
  var modified: Date?
  var succeeded = true

  var name: String { (path as NSString).lastPathComponent }
}

enum WebDAV {
  static let propfindBody = Data(#"<?xml version="1.0" encoding="UTF-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getlastmodified/></d:prop></d:propfind>"#.utf8)

  static func normalized(_ path: String) -> String {
    var path = path
    while path.count > 1, path.hasSuffix("/") { path.removeLast() }
    return path
  }

  static func origin(of url: URL) -> String? {
    guard let scheme = url.scheme?.lowercased(), let host = url.host(percentEncoded: false)?.lowercased(), !host.isEmpty else { return nil }
    let port = url.port ?? (scheme == "https" ? 443 : scheme == "http" ? 80 : -1)
    return "\(scheme)://\(host):\(port)"
  }

  static func decodedHref(_ href: String) -> (path: String, origin: String?) {
    let trimmed = href.trimmingCharacters(in: .whitespacesAndNewlines)
    if let url = URL(string: trimmed), url.scheme != nil { return (normalized(url.path(percentEncoded: false)), origin(of: url) ?? "") }
    return (normalized(trimmed.removingPercentEncoding ?? trimmed), nil)
  }

  static func succeeded(_ statusLine: String) -> Bool {
    let parts = statusLine.split(whereSeparator: \.isWhitespace)
    guard parts.count >= 2, parts[0].uppercased().hasPrefix("HTTP/"), let code = Int(parts[1]) else { return false }
    return (200..<300).contains(code)
  }

  static func isChainName(_ name: String) -> Bool {
    SyncFolderAccess.isChainTag(name)
  }

  static func isSyncFileName(_ name: String) -> Bool {
    let suffix = "." + SyncVault.fileExtension
    return name.hasSuffix(suffix) && SyncFolderAccess.isChainTag(String(name.dropLast(suffix.count)))
  }

  static func children(of url: URL, in entries: [DAVEntry], strictAbout matters: (String) -> Bool) -> [DAVEntry]? {
    let requested = normalized(url.path(percentEncoded: false))
    let requestOrigin = origin(of: url)
    guard entries.allSatisfy({ $0.origin == nil || $0.origin == requestOrigin }) else { return nil }
    let roots = entries.filter { $0.path == requested }
    guard !roots.isEmpty, roots.allSatisfy({ $0.succeeded && $0.isCollection }) else { return nil }
    let children = entries.filter { $0.path != requested && ($0.path as NSString).deletingLastPathComponent == requested }
    guard !children.contains(where: { !$0.succeeded && matters($0.name) }) else { return nil }
    return children.filter(\.succeeded)
  }

  static func parse(_ data: Data) -> [DAVEntry]? {
    let reader = MultiStatusReader()
    let parser = XMLParser(data: data)
    parser.shouldProcessNamespaces = true
    parser.shouldResolveExternalEntities = false
    parser.delegate = reader
    guard parser.parse(), reader.sawMultiStatus, !reader.failed else { return nil }
    return reader.entries
  }
}

private final class MultiStatusReader: NSObject, XMLParserDelegate {
  var entries: [DAVEntry] = []
  var sawMultiStatus = false
  var failed = false
  private var depth = 0
  private var text = ""
  private var href: String?
  private var inResponse = false
  private var inPropstat = false
  private var propIsCollection = false
  private var propHasResourceType = false
  private var propModified: Date?
  private var propStatusOK = false
  private var responseStatusOK = true
  private var hasResourceType = false
  private var isCollection = false
  private var modified: Date?

  private let dates: DateFormatter = {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
    return formatter
  }()

  func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String] = [:]) {
    depth += 1
    text = ""
    guard namespaceURI == "DAV:" else { return }
    if depth == 1 {
      if elementName == "multistatus" { sawMultiStatus = true } else { failed = true }
      return
    }
    switch elementName {
    case "response":
      inResponse = true
      href = nil
      responseStatusOK = true
      hasResourceType = false
      isCollection = false
      modified = nil
    case "propstat":
      inPropstat = true
      propIsCollection = false
      propHasResourceType = false
      propModified = nil
      propStatusOK = false
    case "resourcetype" where inPropstat:
      propHasResourceType = true
    case "collection" where inPropstat:
      propIsCollection = true
    default: break
    }
  }

  func parser(_ parser: XMLParser, foundCharacters string: String) {
    text += string
  }

  func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName: String?) {
    defer { depth -= 1 }
    guard namespaceURI == "DAV:" else { return }
    switch elementName {
    case "href" where inResponse && !inPropstat:
      href = text
    case "getlastmodified" where inPropstat:
      propModified = dates.date(from: text.trimmingCharacters(in: .whitespacesAndNewlines))
    case "status" where inPropstat:
      propStatusOK = WebDAV.succeeded(text)
    case "status" where inResponse:
      responseStatusOK = WebDAV.succeeded(text)
    case "propstat":
      inPropstat = false
      if propStatusOK {
        hasResourceType = hasResourceType || propHasResourceType
        isCollection = isCollection || propIsCollection
        modified = modified ?? propModified
      }
    case "response":
      inResponse = false
      guard let href else {
        failed = true
        return
      }
      let (path, origin) = WebDAV.decodedHref(href)
      entries.append(DAVEntry(path: path, origin: origin, isCollection: isCollection, modified: modified, succeeded: responseStatusOK && hasResourceType))
    default: break
    }
  }
}
