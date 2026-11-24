import Foundation

struct PluginHttpHop: Equatable {
  let url: URL
  let method: String
  let headers: [String: String]
  let body: Data?

  init(url: URL, method: String, headers: [String: String], body: Data?) {
    self.url = url
    self.method = method
    self.headers = headers
    self.body = body
  }

  init(_ request: PluginFetchRequest) {
    self.init(url: request.url, method: request.method, headers: request.headers, body: request.body)
  }
}

struct PluginHttpResponse: Equatable {
  var status = 0
  var reason = ""
  var headers: [(String, String)] = []
  var body = Data()

  static func == (a: PluginHttpResponse, b: PluginHttpResponse) -> Bool {
    a.status == b.status && a.reason == b.reason && a.body == b.body && a.headers.map { "\($0.0):\($0.1)" } == b.headers.map { "\($0.0):\($0.1)" }
  }

  func values(_ name: String) -> [String] { headers.filter { $0.0 == name }.map(\.1) }

  var joinedHeaders: [String: String] {
    var joined: [String: String] = [:]
    for (name, value) in headers { joined[name] = joined[name].map { "\($0), \(value)" } ?? value }
    return joined
  }
}

enum PluginHttpCodec {
  static let maxHeadBytes = 64 * 1024
  static let maxChunkLine = 1024
  static let redirectStatuses: Set<Int> = [301, 302, 303, 307, 308]
  static let bodyMethods: Set<String> = ["POST", "PUT", "PATCH"]
  static let strictlyTextHeaders: Set<String> = ["content-length", "transfer-encoding", "content-encoding", "location"]

  static func defaultPort(_ scheme: String) -> Int { scheme == "https" ? 443 : 80 }

  static func port(of url: URL) -> Int { url.port ?? defaultPort(url.scheme?.lowercased() ?? "http") }

  static func hostHeader(_ url: URL) -> String? {
    guard let raw = url.host, !raw.isEmpty else { return nil }
    let host = PluginFetchPolicy.normalizedHost(raw)
    let shown = host.contains(":") ? "[\(host)]" : host
    guard let port = url.port, port != defaultPort(url.scheme?.lowercased() ?? "http") else { return shown }
    return "\(shown):\(port)"
  }

  static func target(_ url: URL) -> String? {
    guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    let path = parts.percentEncodedPath.isEmpty ? "/" : parts.percentEncodedPath
    let made = parts.percentEncodedQuery.map { "\(path)?\($0)" } ?? path
    guard made.hasPrefix("/"), made.utf8.allSatisfy({ $0 > 0x20 && $0 < 0x7f }) else { return nil }
    return made
  }

  static func requestBytes(_ hop: PluginHttpHop) -> Data? {
    guard let target = target(hop.url), let host = hostHeader(hop.url) else { return nil }
    var lines = ["\(hop.method) \(target) HTTP/1.1", "Host: \(host)"]
    let given = hop.headers.filter { $0.key != "accept-encoding" && !PluginFetchPolicy.refusedHeaders.contains($0.key) }
    for (name, value) in given.sorted(by: { $0.key < $1.key }) {
      guard PluginFetchPolicy.isToken(name), !value.utf8.contains(where: { $0 == 0x0d || $0 == 0x0a || $0 == 0 }) else { return nil }
      lines.append("\(name): \(value)")
    }
    if given["user-agent"] == nil { lines.append("user-agent: Ardia") }
    if given["accept"] == nil { lines.append("accept: */*") }
    lines.append("accept-encoding: identity")
    if hop.body != nil || bodyMethods.contains(hop.method) { lines.append("content-length: \(hop.body?.count ?? 0)") }
    lines.append("connection: close")
    var data = Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8)
    if let body = hop.body { data.append(body) }
    return data
  }

  static func isRedirect(_ status: Int) -> Bool { redirectStatuses.contains(status) }

  static func redirect(from hop: PluginHttpHop, status: Int, location: String?) -> Result<PluginHttpHop, FolderRefusal> {
    guard let location, !location.isEmpty else { return .failure(FolderRefusal(reason: "it redirected without an address")) }
    guard location.count <= 8192, let resolved = URL(string: location, relativeTo: hop.url)?.absoluteURL,
      var parts = URLComponents(url: resolved, resolvingAgainstBaseURL: false)
    else { return .failure(FolderRefusal(reason: "it redirected to an address that isn't valid")) }
    parts.fragment = nil
    guard let target = parts.url else { return .failure(FolderRefusal(reason: "it redirected to an address that isn't valid")) }
    if hop.url.scheme?.lowercased() == "https", target.scheme?.lowercased() != "https" { return .failure(FolderRefusal(reason: "it redirected from https to an address that isn't secure")) }
    let becomesGet = (status == 303 && hop.method != "HEAD") || ((status == 301 || status == 302) && hop.method == "POST")
    if !becomesGet, hop.body?.isEmpty == false, !PluginFetchPolicy.sameOrigin(hop.url, target) {
      return .failure(FolderRefusal(reason: "it redirected to another origin and would have sent the request body there"))
    }
    var headers = PluginFetchPolicy.redirectHeaders(hop.headers, from: hop.url, to: target)
    if becomesGet { headers = headers.filter { $0.key != "content-type" } }
    return .success(PluginHttpHop(url: target, method: becomesGet ? "GET" : hop.method, headers: headers, body: becomesGet ? nil : hop.body))
  }
}

struct PluginHttpParser {
  enum Framing: Equatable {
    case none
    case length(Int)
    case chunked
    case close
  }

  enum ChunkStep: Equatable {
    case size
    case data(Int)
    case dataEnd
    case trailers
  }

  let method: String
  let maxBody: Int
  private(set) var response = PluginHttpResponse()
  private(set) var framing: Framing?
  private(set) var done = false
  private var buffer: [UInt8] = []
  private var cursor = 0
  private var chunk = ChunkStep.size

  init(method: String, maxBody: Int) {
    self.method = method
    self.maxBody = maxBody
  }

  private var tooBig: FolderRefusal { FolderRefusal(reason: "the answer is over \(maxBody / 1024) KB") }

  mutating func feed(_ data: Data) throws -> Bool {
    guard !done else { return true }
    if cursor > 0 && cursor >= buffer.count / 2 {
      buffer.removeFirst(cursor)
      cursor = 0
    }
    buffer.append(contentsOf: data)
    while !done {
      guard try step() else { break }
    }
    return done
  }

  mutating func finishAtEOF() throws {
    guard !done else { return }
    guard framing != nil else { throw FolderRefusal(reason: "the connection closed before the answer arrived") }
    if framing == .close {
      done = true
      return
    }
    throw FolderRefusal(reason: "the answer was cut short")
  }

  static func fieldText(_ bytes: ArraySlice<UInt8>) -> String {
    String(bytes: bytes, encoding: .utf8) ?? String(decoding: bytes.map { UInt16($0) }, as: UTF16.self)
  }

  private func line(from start: Int, limit: Int) throws -> (ArraySlice<UInt8>, Int)? {
    var index = start
    while index + 1 < buffer.count {
      if buffer[index] == 0x0d && buffer[index + 1] == 0x0a { return (buffer[start..<index], index + 2) }
      index += 1
      if index - start > limit { throw FolderRefusal(reason: "the answer has a line that's too long") }
    }
    let waitingForLF = buffer.last == 0x0d ? 1 : 0
    if buffer.count - start - waitingForLF > limit { throw FolderRefusal(reason: "the answer has a line that's too long") }
    return nil
  }

  private func headerField(_ bytes: ArraySlice<UInt8>) throws -> (String, String) {
    let malformed = FolderRefusal(reason: "the answer has a malformed header")
    guard let first = bytes.first, first != 0x20, first != 0x09, let colon = bytes.firstIndex(of: 0x3a),
      let name = String(bytes: bytes[bytes.startIndex..<colon], encoding: .ascii), PluginFetchPolicy.isToken(name)
    else { throw malformed }
    let lowered = name.lowercased()
    let rawValue = bytes[(colon + 1)...]
    let value: String
    if let text = String(bytes: rawValue, encoding: .utf8) {
      value = text
    } else {
      guard !PluginHttpCodec.strictlyTextHeaders.contains(lowered) else { throw malformed }
      value = Self.fieldText(rawValue)
    }
    return (lowered, value.trimmingCharacters(in: CharacterSet(charactersIn: " \t")))
  }

  private mutating func step() throws -> Bool {
    guard let framing else { return try readHead() }
    switch framing {
    case .none:
      done = true
      return false
    case .close:
      return takeBody(buffer.count - cursor) > 0 ? try checkedSize() : false
    case .length(let remaining):
      let taken = takeBody(min(remaining, buffer.count - cursor))
      self.framing = .length(remaining - taken)
      if remaining - taken == 0 { done = true }
      return try checkedSize() && taken > 0
    case .chunked:
      return try readChunk()
    }
  }

  private mutating func takeBody(_ count: Int) -> Int {
    guard count > 0 else { return 0 }
    response.body.append(contentsOf: buffer[cursor..<(cursor + count)])
    cursor += count
    return count
  }

  private func checkedSize() throws -> Bool {
    if response.body.count > maxBody { throw tooBig }
    return true
  }

  private mutating func readHead() throws -> Bool {
    var lines: [ArraySlice<UInt8>] = []
    var index = cursor
    while true {
      guard let (text, next) = try line(from: index, limit: PluginHttpCodec.maxHeadBytes) else {
        if buffer.count - cursor > PluginHttpCodec.maxHeadBytes { throw FolderRefusal(reason: "the answer's headers are too long") }
        return false
      }
      index = next
      if index - cursor > PluginHttpCodec.maxHeadBytes { throw FolderRefusal(reason: "the answer's headers are too long") }
      if text.isEmpty { break }
      lines.append(text)
    }
    cursor = index
    guard let statusLine = lines.first.map(Self.fieldText) else { throw FolderRefusal(reason: "the answer wasn't HTTP") }
    var head = PluginHttpResponse()
    let parts = statusLine.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: false)
    guard parts.count >= 2, parts[0] == "HTTP/1.1" || parts[0] == "HTTP/1.0", parts[1].count == 3, let status = Int(parts[1]), (100...599).contains(status) else {
      throw FolderRefusal(reason: "the answer wasn't HTTP")
    }
    head.status = status
    head.reason = parts.count > 2 ? String(parts[2]) : ""
    for bytes in lines.dropFirst() { head.headers.append(try headerField(bytes)) }
    if (100...199).contains(status) {
      guard status != 101 else { throw FolderRefusal(reason: "the server tried to switch protocols") }
      return true
    }
    response = head
    framing = try framingFor(head)
    return true
  }

  private func framingFor(_ head: PluginHttpResponse) throws -> Framing {
    if method == "HEAD" || head.status == 204 || head.status == 304 { return .none }
    if let coding = head.values("content-encoding").joined(separator: ",").lowercased().split(separator: ",").map({ $0.trimmingCharacters(in: .whitespaces) }).first(where: { !$0.isEmpty && $0 != "identity" }) {
      throw FolderRefusal(reason: "the answer is compressed (\(coding)), which Ardia doesn't decode")
    }
    let codings = head.values("transfer-encoding").joined(separator: ",").lowercased().split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    if !codings.isEmpty { return codings.last == "chunked" ? .chunked : .close }
    let lengths = Set(head.values("content-length").flatMap { $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) } })
    guard !lengths.isEmpty else { return .close }
    guard lengths.count == 1, let text = lengths.first, !text.isEmpty, text.count <= 18, text.utf8.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }), let length = Int(text) else {
      throw FolderRefusal(reason: "the answer has a bad content-length")
    }
    if length > maxBody { throw tooBig }
    return length == 0 ? .none : .length(length)
  }

  private mutating func readChunk() throws -> Bool {
    switch chunk {
    case .size:
      guard let (bytes, next) = try line(from: cursor, limit: PluginHttpCodec.maxChunkLine) else { return false }
      let digits = Self.fieldText(bytes).split(separator: ";", maxSplits: 1).first.map { $0.trimmingCharacters(in: CharacterSet(charactersIn: " \t")) } ?? ""
      guard !digits.isEmpty, digits.count <= 8, let size = Int(digits, radix: 16), size >= 0 else { throw FolderRefusal(reason: "the answer has a bad chunk size") }
      if response.body.count + size > maxBody { throw tooBig }
      cursor = next
      chunk = size == 0 ? .trailers : .data(size)
      return true
    case .data(let remaining):
      let taken = takeBody(min(remaining, buffer.count - cursor))
      chunk = remaining - taken == 0 ? .dataEnd : .data(remaining - taken)
      return taken > 0
    case .dataEnd:
      guard buffer.count - cursor >= 2 else { return false }
      guard buffer[cursor] == 0x0d, buffer[cursor + 1] == 0x0a else { throw FolderRefusal(reason: "the answer has a malformed chunk") }
      cursor += 2
      chunk = .size
      return true
    case .trailers:
      guard let (text, next) = try line(from: cursor, limit: PluginHttpCodec.maxHeadBytes) else { return false }
      cursor = next
      if text.isEmpty { done = true }
      return true
    }
  }
}
