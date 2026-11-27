import Foundation

struct PluginSignInExpectation: Equatable {
  let path: String
  let hosts: Set<String>
  let state: String

  init(path: String, hosts: Set<String>, state: String) {
    self.path = path
    self.hosts = Set(hosts.map { $0.lowercased() })
    self.state = state
  }

  static func isPath(_ path: String) -> Bool {
    guard path.hasPrefix("/"), path.utf8.count <= PluginSignInRequest.maxTarget else { return false }
    guard path.utf8.allSatisfy({ isPathByte($0) }) else { return false }
    if path == "/" { return true }
    return path.dropFirst().split(separator: "/", omittingEmptySubsequences: false).allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
  }

  static func isState(_ state: String) -> Bool {
    (16...256).contains(state.utf8.count) && state.utf8.allSatisfy { isStateByte($0) }
  }

  private static func isStateByte(_ b: UInt8) -> Bool {
    (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) || b == 0x5F || b == 0x2D
  }

  private static func isPathByte(_ b: UInt8) -> Bool {
    isStateByte(b) || b == 0x2F || b == 0x2E || b == 0x7E
  }

  static func forCallback(host: String, port: Int, path: String, state: String) -> PluginSignInExpectation? {
    guard (1024...65535).contains(port), isPath(path), isState(state) else { return nil }
    switch host {
    case "127.0.0.1": return PluginSignInExpectation(path: path, hosts: ["127.0.0.1:\(port)"], state: state)
    case "::1": return PluginSignInExpectation(path: path, hosts: ["[::1]:\(port)"], state: state)
    case "localhost": return PluginSignInExpectation(path: path, hosts: ["localhost:\(port)"], state: state)
    default: return nil
    }
  }

  static func bindAddresses(host: String) -> [String] {
    switch host {
    case "127.0.0.1": return ["127.0.0.1"]
    case "::1": return ["::1"]
    case "localhost": return ["127.0.0.1", "::1"]
    default: return []
    }
  }
}

enum PluginSignInVerdict: Equatable {
  case incomplete
  case caught(String)
  case refused(Int)
}

enum PluginSignInRequest {
  static let maxHead = 16 * 1024
  static let maxTarget = 8 * 1024
  static let maxHeaders = 64

  private static let headEnd = Data("\r\n\r\n".utf8)

  static func verdict(_ data: Data, expecting expectation: PluginSignInExpectation) -> PluginSignInVerdict {
    guard let end = data.range(of: headEnd) else { return data.count > maxHead ? .refused(431) : .incomplete }
    guard end.lowerBound - data.startIndex <= maxHead else { return .refused(431) }
    let headBytes = data[data.startIndex..<end.lowerBound]
    guard headBytes.allSatisfy({ ($0 >= 0x20 && $0 < 0x7F) || $0 == 0x0D || $0 == 0x0A || $0 == 0x09 }),
      let head = String(data: headBytes, encoding: .ascii)
    else { return .refused(400) }
    let lines = head.components(separatedBy: "\r\n")
    guard lines.count - 1 <= maxHeaders, let requestLine = lines.first else { return .refused(431) }
    let parts = requestLine.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
    guard parts.count == 3, parts[2] == "HTTP/1.1" || parts[2] == "HTTP/1.0" else { return .refused(400) }
    guard parts[0] == "GET" else { return .refused(405) }
    let target = parts[1]
    guard target.hasPrefix("/"), !target.contains("#"), !target.contains("\\") else { return .refused(400) }
    guard target.utf8.count <= maxTarget else { return .refused(414) }
    guard let headers = headerFields(lines.dropFirst()) else { return .refused(400) }
    guard let host = headers["host"], expectation.hosts.contains(host.lowercased()) else { return .refused(421) }
    if let mode = headers["sec-fetch-mode"], mode != "navigate" { return .refused(403) }
    if let dest = headers["sec-fetch-dest"], dest != "document" { return .refused(403) }
    let split = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
    guard String(split[0]) == expectation.path else { return .refused(404) }
    guard split.count == 2, let given = stateOf(String(split[1])), sameBytes(given, expectation.state) else { return .refused(403) }
    return .caught(target)
  }

  static func stateOf(_ query: String) -> String? {
    var found: String?
    for pair in query.split(separator: "&", omittingEmptySubsequences: true) {
      let kv = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
      guard let name = String(kv[0]).removingPercentEncoding else { return nil }
      guard name == "state" else { continue }
      guard found == nil, let value = (kv.count == 2 ? String(kv[1]) : "").removingPercentEncoding else { return nil }
      found = value
    }
    return found
  }

  static func sameBytes(_ a: String, _ b: String) -> Bool {
    let x = Array(a.utf8)
    let y = Array(b.utf8)
    guard x.count == y.count else { return false }
    var diff: UInt8 = 0
    for i in 0..<x.count { diff |= x[i] ^ y[i] }
    return diff == 0
  }

  private static let singleHeaders: Set<String> = ["host", "sec-fetch-mode", "sec-fetch-dest"]

  private static func headerFields(_ lines: ArraySlice<String>) -> [String: String]? {
    var fields: [String: String] = [:]
    for line in lines {
      guard let colon = line.firstIndex(of: ":"), colon != line.startIndex else { return nil }
      let name = line[line.startIndex..<colon].lowercased()
      guard !name.contains(" "), !name.contains("\t") else { return nil }
      let value = line[line.index(after: colon)...].trimmingCharacters(in: CharacterSet(charactersIn: " \t"))
      if singleHeaders.contains(name), fields[name] != nil { return nil }
      if fields[name] == nil { fields[name] = value }
    }
    return fields
  }

  static func response(_ verdict: PluginSignInVerdict) -> Data {
    let status: (Int, String)
    switch verdict {
    case .caught: status = (204, "No Content")
    case .incomplete: status = (408, "Request Timeout")
    case .refused(let code): status = (code, reason(code))
    }
    return Data("HTTP/1.1 \(status.0) \(status.1)\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n".utf8)
  }

  private static func reason(_ code: Int) -> String {
    switch code {
    case 403: return "Forbidden"
    case 404: return "Not Found"
    case 405: return "Method Not Allowed"
    case 414: return "URI Too Long"
    case 421: return "Misdirected Request"
    case 431: return "Request Header Fields Too Large"
    default: return "Bad Request"
    }
  }
}
