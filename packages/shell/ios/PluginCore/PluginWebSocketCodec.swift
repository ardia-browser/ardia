import CryptoKit
import Foundation
import Security

enum PluginWebSocketMessage: Equatable {
  case text(Data)
  case binary(Data)
  case ping(Data)
  case pong
  case close(code: Int, reason: String)
}

enum PluginWebSocketCodec {
  struct Notice {
    let message: String
    let code: String
    let close: Int
    let reason: String
  }

  static let fellBehind = Notice(message: "the plugin didn't read the socket's messages in time", code: "backpressure", close: 1008, reason: "The plugin fell behind.")
  static let tooBig = Notice(message: "a message was over the plugin channel's 1 MB line", code: "too_big", close: 1009, reason: "Message too big for the plugin channel.")

  static let guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
  static let maxHeadBytes = 16 * 1024
  static let maxControlPayload = 125

  static func key() -> String {
    var bytes = [UInt8](repeating: 0, count: 16)
    if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess { bytes = (0..<16).map { _ in UInt8.random(in: 0...255) } }
    return Data(bytes).base64EncodedString()
  }

  static func accept(for key: String) -> String {
    Data(Insecure.SHA1.hash(data: Data((key + guid).utf8))).base64EncodedString()
  }

  static func handshake(url: URL, key: String, protocols: [String], headers: [(String, String)]) -> Data? {
    guard let target = PluginHttpCodec.target(url), let host = PluginHttpCodec.hostHeader(url) else { return nil }
    var lines = [
      "GET \(target) HTTP/1.1", "Host: \(host)", "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: \(key)", "Sec-WebSocket-Version: 13",
    ]
    if !protocols.isEmpty { lines.append("Sec-WebSocket-Protocol: \(protocols.joined(separator: ", "))") }
    let reserved: Set<String> = ["host", "upgrade", "connection", "origin", "cookie"]
    for (name, value) in headers {
      let lowered = name.lowercased()
      guard PluginFetchPolicy.isToken(name), !reserved.contains(lowered), !lowered.hasPrefix("sec-"), !value.utf8.contains(where: { $0 == 0x0d || $0 == 0x0a || $0 == 0 }) else { return nil }
      lines.append("\(name): \(value)")
    }
    if !headers.contains(where: { $0.0.lowercased() == "user-agent" }) { lines.append("User-Agent: Ardia") }
    return Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8)
  }

  static func headEnd(_ buffer: Data) -> Int? {
    guard let range = buffer.range(of: Data([13, 10, 13, 10])) else { return nil }
    return range.upperBound
  }

  static func checkHandshake(_ head: Data, key: String, protocols: [String]) -> Result<String, FolderRefusal> {
    guard let text = String(data: head, encoding: .utf8) else { return .failure(FolderRefusal(reason: "the server's answer wasn't text")) }
    var lines = text.components(separatedBy: "\r\n").filter { !$0.isEmpty }
    guard !lines.isEmpty else { return .failure(FolderRefusal(reason: "the server didn't answer")) }
    let status = lines.removeFirst().split(separator: " ", maxSplits: 2)
    guard status.count >= 2, status[0] == "HTTP/1.1", status[1] == "101" else { return .failure(FolderRefusal(reason: "the server didn't switch to a WebSocket (\(status.count > 1 ? String(status[1]) : "no status"))")) }
    var fields: [String: [String]] = [:]
    for line in lines {
      guard let colon = line.firstIndex(of: ":") else { return .failure(FolderRefusal(reason: "the server's answer has a malformed header")) }
      let name = line[line.startIndex..<colon].lowercased()
      fields[name, default: []].append(line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces))
    }
    guard fields["upgrade"]?.count == 1, fields["upgrade"]?.first?.lowercased() == "websocket" else { return .failure(FolderRefusal(reason: "the server didn't upgrade to a WebSocket")) }
    guard fields["connection"]?.contains(where: { $0.lowercased().split(separator: ",").contains { $0.trimmingCharacters(in: .whitespaces) == "upgrade" } }) == true else { return .failure(FolderRefusal(reason: "the server didn't upgrade the connection")) }
    guard fields["sec-websocket-accept"] == [accept(for: key)] else { return .failure(FolderRefusal(reason: "the server's WebSocket key didn't match")) }
    guard fields["sec-websocket-extensions"] == nil else { return .failure(FolderRefusal(reason: "the server asked for a WebSocket extension Ardia doesn't speak")) }
    let chosen = fields["sec-websocket-protocol"] ?? []
    guard chosen.count <= 1 else { return .failure(FolderRefusal(reason: "the server picked more than one protocol")) }
    if let pick = chosen.first, !protocols.contains(pick) { return .failure(FolderRefusal(reason: "the server picked a protocol the plugin didn't offer")) }
    return .success(chosen.first ?? "")
  }

  static func frame(opcode: UInt8, payload: Data, mask: [UInt8]? = nil) -> Data {
    let key = mask ?? (0..<4).map { _ in UInt8.random(in: 0...255) }
    var out = Data([0x80 | (opcode & 0x0f)])
    let count = payload.count
    if count < 126 {
      out.append(0x80 | UInt8(count))
    } else if count <= 0xffff {
      out.append(0x80 | 126)
      out.append(contentsOf: [UInt8(count >> 8), UInt8(count & 0xff)])
    } else {
      out.append(0x80 | 127)
      out.append(contentsOf: (0..<8).reversed().map { UInt8((UInt64(count) >> (UInt64($0) * 8)) & 0xff) })
    }
    out.append(contentsOf: key)
    var masked = [UInt8](payload)
    for index in masked.indices { masked[index] ^= key[index % 4] }
    out.append(contentsOf: masked)
    return out
  }

  static func closePayload(code: Int, reason: String) -> Data {
    var data = Data([UInt8((code >> 8) & 0xff), UInt8(code & 0xff)])
    data.append(Data(reason.utf8.prefix(123)))
    return data
  }
}

struct PluginWebSocketParser {
  let maxPayload: Int
  private var buffer = Data()
  private var fragments = Data()
  private var fragmentOpcode: UInt8?

  init(maxPayload: Int) {
    self.maxPayload = maxPayload
  }

  mutating func feed(_ data: Data) throws -> [PluginWebSocketMessage] {
    buffer.append(data)
    var out: [PluginWebSocketMessage] = []
    while let message = try next() { out.append(message) }
    return out
  }

  private mutating func next() throws -> PluginWebSocketMessage? {
    while true {
      let bytes = [UInt8](buffer.prefix(14))
      guard bytes.count >= 2 else { return nil }
      let fin = bytes[0] & 0x80 != 0
      guard bytes[0] & 0x70 == 0 else { throw FolderRefusal(reason: "the server sent a frame with reserved bits") }
      let opcode = bytes[0] & 0x0f
      guard bytes[1] & 0x80 == 0 else { throw FolderRefusal(reason: "the server masked a frame") }
      var length = Int(bytes[1] & 0x7f)
      var offset = 2
      if length == 126 {
        guard bytes.count >= 4 else { return nil }
        length = Int(bytes[2]) << 8 | Int(bytes[3])
        offset = 4
      } else if length == 127 {
        guard bytes.count >= 10 else { return nil }
        var big: UInt64 = 0
        for index in 2..<10 { big = big << 8 | UInt64(bytes[index]) }
        guard big <= UInt64(maxPayload) else { throw FolderRefusal(reason: "the server sent a message over \(maxPayload >> 20) MB") }
        length = Int(big)
        offset = 10
      }
      let control = opcode & 0x08 != 0
      if control, !fin || length > PluginWebSocketCodec.maxControlPayload { throw FolderRefusal(reason: "the server sent a malformed control frame") }
      guard length <= maxPayload, fragments.count + length <= maxPayload else { throw FolderRefusal(reason: "the server sent a message over \(maxPayload >> 20) MB") }
      guard buffer.count >= offset + length else { return nil }
      let start = buffer.startIndex + offset
      let payload = Data(buffer[start..<(start + length)])
      buffer = Data(buffer.suffix(from: start + length))
      switch opcode {
      case 0x8:
        let code = payload.count >= 2 ? Int(payload[payload.startIndex]) << 8 | Int(payload[payload.startIndex + 1]) : 1005
        return .close(code: code, reason: String(decoding: payload.dropFirst(2), as: UTF8.self))
      case 0x9: return .ping(payload)
      case 0xA: return .pong
      case 0x0:
        guard let first = fragmentOpcode else { throw FolderRefusal(reason: "the server continued a message it never started") }
        fragments.append(payload)
        guard fin else { continue }
        let whole = fragments
        fragments = Data()
        fragmentOpcode = nil
        return first == 0x1 ? .text(whole) : .binary(whole)
      case 0x1, 0x2:
        guard fragmentOpcode == nil else { throw FolderRefusal(reason: "the server started a message inside another") }
        if fin { return opcode == 0x1 ? .text(payload) : .binary(payload) }
        fragmentOpcode = opcode
        fragments = payload
      default:
        throw FolderRefusal(reason: "the server sent an unknown frame")
      }
    }
  }
}
