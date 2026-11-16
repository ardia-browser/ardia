import Foundation
import Synchronization
@testable import ArdiaSync

final class FakeNextcloud: @unchecked Sendable {
  enum Fault: Equatable, Sendable, CustomStringConvertible {
    case refused
    case hang
    case status(Int)
    case captivePortal
    case truncatedXML
    case emptyMultiStatus
    case landsThenDrops
    case failedRoot(Int)
    case hrefOnlyRoot
    case foreignRoot
    case otherHostRoot

    var description: String {
      switch self {
      case .refused: "connection refused"
      case .hang: "timeout"
      case .status(let code): "HTTP \(code)"
      case .captivePortal: "captive portal 200 HTML"
      case .truncatedXML: "truncated XML"
      case .emptyMultiStatus: "empty 207"
      case .landsThenDrops: "lands then drops"
      case .failedRoot(let code): "207 whose root failed with \(code)"
      case .hrefOnlyRoot: "207 whose root has no properties"
      case .foreignRoot: "207 listing another collection"
      case .otherHostRoot: "207 listing another host"
      }
    }

    var onlyListings: Bool {
      switch self {
      case .failedRoot, .hrefOnlyRoot, .foreignRoot, .otherHostRoot: true
      default: false
      }
    }
  }

  struct Logged: Equatable {
    var method: String
    var path: String
  }

  private static let registry = Mutex<[String: FakeNextcloud]>([:])

  let host: String
  let basePath: String
  let filesRoot: URL
  let userId: String
  let loginName: String
  private let lock = NSLock()
  private var _passwords: Set<String>
  private var _fault: ((Logged) -> Fault?)?
  private var _log: [Logged] = []
  private var _revoked: [String] = []
  private var _approved: String?
  private var _searchSupported = true
  private var _pollHost: String?
  private var _beforeGet: ((String) -> Void)?
  private var _hold: (rule: (Logged) -> Bool, held: Held, answer: Fault?)?
  private var _brokenChildren: Set<String> = []

  init(filesRoot: URL, userId: String = "u-7f3a", loginName: String = "alex@example.com", password: String = "app-password-1", basePath: String = "/nc") {
    host = "cloud-\(UUID().uuidString.lowercased()).test"
    self.basePath = basePath
    self.filesRoot = filesRoot
    self.userId = userId
    self.loginName = loginName
    _passwords = [password]
    Self.registry.withLock { $0[host] = self }
  }

  func shutDown() {
    Self.registry.withLock { $0[host] = nil }
  }

  static func server(for host: String?) -> FakeNextcloud? {
    guard let host else { return nil }
    return registry.withLock { $0[host] }
  }

  var serverURL: URL { URL(string: "https://\(host)\(basePath)")! }
  var davPrefix: String { "\(basePath)/remote.php/dav/files/\(userId)" }

  func account(password: String = "app-password-1") -> NextcloudAccount {
    NextcloudAccount(server: serverURL, userId: userId, loginName: loginName, appPassword: password)
  }

  func transport(timeout: TimeInterval = 2) -> NextcloudTransport {
    NextcloudTransport(timeout: timeout) {
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [FakeNextcloudProtocol.self]
      return configuration
    }
  }

  var passwords: Set<String> {
    get { lock.withLock { _passwords } }
    set { lock.withLock { _passwords = newValue } }
  }

  func fail(_ fault: Fault?) {
    setFault(fault.map { fault in { _ in fault } })
  }

  func setFault(_ rule: ((Logged) -> Fault?)?) {
    lock.withLock { _fault = rule }
  }

  var log: [Logged] { lock.withLock { _log } }
  var revoked: [String] { lock.withLock { _revoked } }

  func clearLog() {
    lock.withLock { _log = [] }
  }

  var searchSupported: Bool {
    get { lock.withLock { _searchSupported } }
    set { lock.withLock { _searchSupported = newValue } }
  }

  var pollHost: String? {
    get { lock.withLock { _pollHost } }
    set { lock.withLock { _pollHost = newValue } }
  }

  var brokenChildren: Set<String> {
    get { lock.withLock { _brokenChildren } }
    set { lock.withLock { _brokenChildren = newValue } }
  }

  func beforeGet(_ hook: ((String) -> Void)?) {
    lock.withLock { _beforeGet = hook }
  }

  final class Held: @unchecked Sendable {
    private let lock = NSLock()
    private var _arrived = false
    private var _released = false
    private var deliver: (() -> Void)?

    var arrived: Bool { lock.withLock { _arrived } }

    func park(_ deliver: @escaping () -> Void) {
      let now = lock.withLock { () -> Bool in
        _arrived = true
        if _released { return true }
        self.deliver = deliver
        return false
      }
      if now { deliver() }
    }

    func release() {
      let pending = lock.withLock { () -> (() -> Void)? in
        _released = true
        defer { deliver = nil }
        return deliver
      }
      pending?()
    }
  }

  func hold(where rule: @escaping (Logged) -> Bool, answering answer: Fault? = nil) -> Held {
    let held = Held()
    lock.withLock { _hold = (rule, held, answer) }
    return held
  }

  func approveLogin(password: String) {
    lock.withLock {
      _approved = password
      _passwords.insert(password)
    }
  }

  struct Reply {
    var status: Int
    var headers: [String: String] = [:]
    var body = Data()
  }

  enum Answer {
    case reply(Reply)
    case fail(URLError)
    case hang
    case held(Held, () -> Answer)
  }

  func handle(_ request: URLRequest, body: Data) -> Answer {
    let method = request.httpMethod ?? "GET"
    let path = request.url?.path(percentEncoded: false) ?? ""
    let entry = Logged(method: method, path: path)
    let (rule, hold) = lock.withLock { () -> (((Logged) -> Fault?)?, (rule: (Logged) -> Bool, held: Held, answer: Fault?)?) in
      _log.append(entry)
      guard let hold = _hold, hold.rule(entry) else { return (_fault, nil) }
      _hold = nil
      return (_fault, hold)
    }
    if let hold {
      return .held(hold.held) { [self] in
        hold.answer.map { answer(for: $0, method: method, path: path, body: body, request: request) } ?? route(method: method, path: path, body: body, request: request)
      }
    }
    let isLogin = path.hasPrefix("\(basePath)/index.php/login") || path.hasPrefix("\(basePath)/login/v2")
    if !isLogin, let fault = rule?(entry), !fault.onlyListings || method == "PROPFIND" {
      return answer(for: fault, method: method, path: path, body: body, request: request)
    }
    return route(method: method, path: path, body: body, request: request)
  }

  private func answer(for fault: Fault, method: String, path: String, body: Data, request: URLRequest) -> Answer {
    let collection = "<d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>"
    let root = Self.encoded(WebDAV.normalized(path)) + "/"
    switch fault {
    case .refused: return .fail(URLError(.cannotConnectToHost))
    case .hang: return .hang
    case .status(let code): return .reply(Reply(status: code, body: Data("<html>error</html>".utf8)))
    case .captivePortal: return .reply(Reply(status: 200, headers: ["Content-Type": "text/html"], body: Data("<html><body>Sign in to the Wi-Fi</body></html>".utf8)))
    case .truncatedXML:
      let full = davAnswer(method: method, path: path, body: body, request: request)
      if case .reply(var reply) = full, reply.status == 207 {
        reply.body = reply.body.prefix(reply.body.count / 2)
        return .reply(reply)
      }
      return .reply(Reply(status: 207, body: Data(#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>"#.utf8)))
    case .emptyMultiStatus:
      return .reply(Reply(status: 207, headers: ["Content-Type": "application/xml"], body: Data(#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>"#.utf8)))
    case .landsThenDrops:
      _ = route(method: method, path: path, body: body, request: request)
      return .fail(URLError(.networkConnectionLost))
    case .failedRoot(let code):
      return .reply(multiStatus(["<d:response><d:href>\(root)</d:href><d:status>HTTP/1.1 \(code) Failed</d:status></d:response>"]))
    case .hrefOnlyRoot:
      return .reply(multiStatus(["<d:response><d:href>\(root)</d:href></d:response>"]))
    case .foreignRoot:
      return .reply(multiStatus(["<d:response><d:href>/backup\(root)</d:href>\(collection)</d:response>"]))
    case .otherHostRoot:
      return .reply(multiStatus(["<d:response><d:href>https://evil.test\(root)</d:href>\(collection)</d:response>"]))
    }
  }

  static func encoded(_ href: String) -> String {
    href.split(separator: "/", omittingEmptySubsequences: false).map { $0.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? String($0) }.joined(separator: "/")
  }

  private func route(method: String, path: String, body: Data, request: URLRequest) -> Answer {
    if path == "\(basePath)/index.php/login/v2", method == "POST" {
      let pollHost = pollHost ?? host
      let json = #"{"poll":{"token":"poll-token","endpoint":"https://\#(pollHost)\#(basePath)/login/v2/poll"},"login":"https://\#(host)\#(basePath)/login/v2/flow/abc"}"#
      return .reply(Reply(status: 200, headers: ["Content-Type": "application/json"], body: Data(json.utf8)))
    }
    if path == "\(basePath)/login/v2/poll", method == "POST" {
      guard String(decoding: body, as: UTF8.self).contains("token=poll-token"), let approved = lock.withLock({ _approved }) else { return .reply(Reply(status: 404)) }
      let json = #"{"server":"https://\#(host)\#(basePath)","loginName":"\#(loginName)","appPassword":"\#(approved)"}"#
      return .reply(Reply(status: 200, headers: ["Content-Type": "application/json"], body: Data(json.utf8)))
    }
    if path == "\(basePath)/ocs/v2.php/core/apppassword", method == "DELETE" {
      let password = credential(request).map { String($0.dropFirst(loginName.count + 1)) } ?? ""
      lock.withLock {
        _revoked.append(password)
        _passwords.remove(password)
      }
      return .reply(Reply(status: 200))
    }
    guard authorized(request) else { return .reply(Reply(status: 401, body: Data("<d:error/>".utf8))) }
    if path == "\(basePath)/ocs/v2.php/cloud/user", method == "GET" {
      guard request.value(forHTTPHeaderField: "OCS-APIRequest") == "true" else { return .reply(Reply(status: 400)) }
      return .reply(Reply(status: 200, headers: ["Content-Type": "application/json"], body: Data(#"{"ocs":{"meta":{"status":"ok"},"data":{"id":"\#(userId)","displayname":"Alex"}}}"#.utf8)))
    }
    return davAnswer(method: method, path: path, body: body, request: request)
  }

  private func credential(_ request: URLRequest) -> String? {
    guard let header = request.value(forHTTPHeaderField: "Authorization"), header.hasPrefix("Basic "),
          let data = Data(base64Encoded: String(header.dropFirst(6)))
    else { return nil }
    return String(data: data, encoding: .utf8)
  }

  private func authorized(_ request: URLRequest) -> Bool {
    guard let credential = credential(request), credential.hasPrefix(loginName + ":") else { return false }
    return passwords.contains(String(credential.dropFirst(loginName.count + 1)))
  }

  private func davAnswer(method: String, path: String, body: Data, request: URLRequest) -> Answer {
    if method == "SEARCH", WebDAV.normalized(path) == "\(basePath)/remote.php/dav" {
      return searchAnswer(body)
    }
    guard path == davPrefix || path.hasPrefix(davPrefix + "/") else { return .reply(Reply(status: 404)) }
    let relative = String(path.dropFirst(davPrefix.count)).split(separator: "/").map(String.init)
    let url = relative.reduce(filesRoot) { $0.appendingPathComponent($1) }
    let fileManager = FileManager.default
    var isDirectory: ObjCBool = false
    let exists = fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory)
    let parentExists = fileManager.fileExists(atPath: url.deletingLastPathComponent().path)
    switch method {
    case "PROPFIND":
      guard exists else { return .reply(Reply(status: 404)) }
      var responses = [response(href: path, url: url, isDirectory: isDirectory.boolValue)]
      if isDirectory.boolValue, request.value(forHTTPHeaderField: "Depth") != "0" {
        for name in ((try? fileManager.contentsOfDirectory(atPath: url.path)) ?? []).sorted() {
          var childIsDirectory: ObjCBool = false
          let child = url.appendingPathComponent(name)
          fileManager.fileExists(atPath: child.path, isDirectory: &childIsDirectory)
          responses.append(response(href: WebDAV.normalized(path) + "/" + name, url: child, isDirectory: childIsDirectory.boolValue))
        }
        for name in brokenChildren.sorted() {
          responses.append("<d:response><d:href>\(Self.encoded(WebDAV.normalized(path) + "/" + name))</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat></d:response>")
        }
      }
      return .reply(multiStatus(responses))
    case "GET":
      lock.withLock { _beforeGet }?(path)
      guard let data = try? Data(contentsOf: url) else { return .reply(Reply(status: 404)) }
      return .reply(Reply(status: 200, headers: ["Content-Type": "application/octet-stream"], body: data))
    case "PUT":
      guard parentExists else { return .reply(Reply(status: 409)) }
      do {
        try body.write(to: url)
      } catch {
        return .reply(Reply(status: 500))
      }
      return .reply(Reply(status: exists ? 204 : 201))
    case "MKCOL":
      if exists { return .reply(Reply(status: 405)) }
      guard parentExists else { return .reply(Reply(status: 409)) }
      try? fileManager.createDirectory(at: url, withIntermediateDirectories: false)
      return .reply(Reply(status: 201))
    case "DELETE":
      guard exists else { return .reply(Reply(status: 404)) }
      try? fileManager.removeItem(at: url)
      return .reply(Reply(status: 204))
    default:
      return .reply(Reply(status: 405))
    }
  }

  private func searchAnswer(_ body: Data) -> Answer {
    guard searchSupported else { return .reply(Reply(status: 501)) }
    let text = String(decoding: body, as: UTF8.self)
    guard let start = text.range(of: "<d:literal>"), let end = text.range(of: "</d:literal>", range: start.upperBound..<text.endIndex) else {
      return .reply(Reply(status: 400))
    }
    let literal = String(text[start.upperBound..<end.lowerBound])
    var responses: [String] = []
    let enumerator = FileManager.default.enumerator(at: filesRoot, includingPropertiesForKeys: [.isDirectoryKey])
    while let url = enumerator?.nextObject() as? URL {
      guard url.lastPathComponent == literal, (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else { continue }
      let relative = url.standardizedFileURL.path.replacingOccurrences(of: filesRoot.standardizedFileURL.path, with: "")
      responses.append(response(href: davPrefix + relative, url: url, isDirectory: true))
    }
    return .reply(multiStatus(responses))
  }

  private func response(href: String, url: URL, isDirectory: Bool) -> String {
    let encoded = Self.encoded(href)
    let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? Date()
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
    let type = isDirectory ? "<d:resourcetype><d:collection/></d:resourcetype>" : "<d:resourcetype/>"
    return "<d:response><d:href>\(encoded)\(isDirectory ? "/" : "")</d:href><d:propstat><d:prop>\(type)<d:getlastmodified>\(formatter.string(from: modified))</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><d:quota-used-bytes/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>"
  }

  private func multiStatus(_ responses: [String]) -> Reply {
    let xml = #"<?xml version="1.0" encoding="UTF-8"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">"# + responses.joined() + "</d:multistatus>"
    return Reply(status: 207, headers: ["Content-Type": "application/xml; charset=utf-8"], body: Data(xml.utf8))
  }
}

final class FakeNextcloudProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool {
    FakeNextcloud.server(for: request.url?.host()) != nil
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let server = FakeNextcloud.server(for: request.url?.host()), let url = request.url else {
      client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
      return
    }
    deliver(server.handle(request, body: Self.body(of: request)), url: url)
  }

  private let stopped = Mutex(false)

  private func deliver(_ answer: FakeNextcloud.Answer, url: URL) {
    guard !stopped.withLock({ $0 }) else { return }
    switch answer {
    case .hang:
      return
    case .held(let held, let later):
      let loop = CFRunLoopGetCurrent()
      held.park { [self] in
        CFRunLoopPerformBlock(loop, CFRunLoopMode.commonModes.rawValue) { self.deliver(later(), url: url) }
        CFRunLoopWakeUp(loop)
      }
    case .fail(let error):
      client?.urlProtocol(self, didFailWithError: error)
    case .reply(let reply):
      let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: reply.body)
      client?.urlProtocolDidFinishLoading(self)
    }
  }

  override func stopLoading() {
    stopped.withLock { $0 = true }
  }

  static func body(of request: URLRequest) -> Data {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return Data() }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    while stream.hasBytesAvailable {
      let read = stream.read(&buffer, maxLength: buffer.count)
      if read <= 0 { break }
      data.append(buffer, count: read)
    }
    return data
  }
}
