import Darwin
import Foundation

struct ControlOutput {
  static let maxLine = 1_048_576
  static let maxEventBytes = 4 * 1_048_576
  static let maxBytes = 34 * 1_048_576
  static let markerRoom = 64
  static let maxWaitingEvents = 1000
  static let maxIdBytes = 256
  static let releaseWrittenBytes = 65_536

  enum WriteResult { case drained, blocked, failed }
  enum Kind { case reply, kept, event }

  private struct Chunk {
    var data: Data
    let kind: Kind
    var ticket = 0
  }

  private var chunks: [Chunk] = []
  private var headStarted = false
  private var offset = 0
  private var headWritten = 0
  private var headMarked = 0
  private(set) var bytes = 0
  private(set) var eventBytes = 0
  private(set) var waitingEvents = 0
  private(set) var dropped = 0
  private var finished: [Int] = []

  var isEmpty: Bool { chunks.isEmpty }
  var midLine: Bool { headStarted && headWritten > 0 }
  var waitingTickets: [Int] { chunks.map(\.ticket).filter { $0 > 0 } }

  mutating func takeFinishedTickets() -> [Int] {
    defer { finished = [] }
    return finished
  }

  mutating func addReply(_ data: Data, ticket: Int) -> Bool {
    addKept(Chunk(data: Self.fittedReply(data), kind: .reply, ticket: ticket))
  }

  mutating func addKept(_ data: Data) -> Bool {
    guard data.count <= Self.maxLine else { return true }
    return addKept(Chunk(data: data, kind: .kept))
  }

  mutating func addEvent(_ data: Data) -> Bool {
    guard data.count <= Self.maxLine else {
      dropped += 1
      return true
    }
    while waitingEvents >= Self.maxWaitingEvents || eventBytes + data.count > Self.maxEventBytes || !hasRoom(data.count) {
      guard dropOldestEvent() else {
        dropped += 1
        return true
      }
    }
    waitingEvents += 1
    bytes += data.count
    eventBytes += data.count
    chunks.append(Chunk(data: data, kind: .event))
    return true
  }

  mutating func keepOnlyReplies() {
    var kept: [Chunk] = []
    for (index, chunk) in chunks.enumerated() {
      if chunk.kind == .reply || (index == 0 && midLine) {
        kept.append(chunk)
        continue
      }
      bytes -= chunk.data.count
      if chunk.kind == .event {
        eventBytes -= chunk.data.count
        waitingEvents -= 1
      }
    }
    if !midLine {
      headStarted = false
      headMarked = 0
    }
    chunks = kept
    dropped = 0
  }

  mutating func keepOnlyHead() -> [Int] {
    guard midLine else { return [] }
    let rest = chunks.dropFirst()
    let unwritten = rest.map(\.ticket).filter { $0 > 0 }
    for chunk in rest {
      bytes -= chunk.data.count
      if chunk.kind == .event {
        eventBytes -= chunk.data.count
        waitingEvents -= 1
      }
    }
    chunks.removeLast(rest.count)
    return unwritten
  }

  mutating func write(to fd: Int32) -> WriteResult {
    while !chunks.isEmpty {
      startHead()
      let data = chunks[0].data
      let written = data.withUnsafeBytes { raw -> Int in
        guard let base = raw.baseAddress else { return 0 }
        return Darwin.write(fd, base + offset, data.count - offset)
      }
      if written < 0 {
        if errno == EINTR { continue }
        return errno == EAGAIN || errno == EWOULDBLOCK ? .blocked : .failed
      }
      if headWritten == 0 && chunks[0].kind == .event { waitingEvents -= 1 }
      offset += written
      headWritten += written
      bytes -= written
      if chunks[0].kind == .event { eventBytes -= written }
      if offset == data.count {
        if chunks[0].ticket > 0 { finished.append(chunks[0].ticket) }
        chunks.removeFirst()
        offset = 0
        headWritten = 0
        headMarked = 0
        headStarted = false
      } else if offset >= Self.releaseWrittenBytes {
        chunks[0].data = Data(data[(data.startIndex + offset)...])
        offset = 0
      }
    }
    return .drained
  }

  private func hasRoom(_ count: Int) -> Bool { bytes + count + Self.markerRoom <= Self.maxBytes }

  private mutating func addKept(_ chunk: Chunk) -> Bool {
    while !hasRoom(chunk.data.count) {
      guard dropOldestEvent() else { return false }
    }
    bytes += chunk.data.count
    chunks.append(chunk)
    return true
  }

  private mutating func dropOldestEvent() -> Bool {
    guard let index = chunks.indices.first(where: { chunks[$0].kind == .event && !($0 == 0 && midLine) }) else { return false }
    if index == 0 && headStarted {
      dropped += headMarked
      headMarked = 0
      headStarted = false
      offset = 0
    }
    bytes -= chunks[index].data.count
    eventBytes -= chunks[index].data.count
    chunks.remove(at: index)
    waitingEvents -= 1
    dropped += 1
    return true
  }

  private mutating func startHead() {
    guard !headStarted else { return }
    headStarted = true
    guard chunks[0].kind == .event, dropped > 0 else { return }
    let marked = Self.marking(chunks[0].data, dropped: dropped)
    let grown = marked.count - chunks[0].data.count
    guard grown > 0, grown <= Self.markerRoom, marked.count <= Self.maxLine else { return }
    bytes += grown
    eventBytes += grown
    chunks[0].data = marked
    headMarked = dropped
    dropped = 0
  }

  static let maxSafeInteger: Double = 9_007_199_254_740_991

  static func echoedId(_ given: Any?) -> Any {
    if let number = given as? NSNumber {
      guard CFGetTypeID(number) != CFBooleanGetTypeID() else { return NSNull() }
      let value = number.doubleValue
      return value.rounded() == value && abs(value) <= maxSafeInteger ? number : NSNull()
    }
    guard let text = given as? NSString, wellFormed(text) else { return NSNull() }
    let string = text as String
    return string.utf8.count <= maxIdBytes ? string : NSNull()
  }

  static func wellFormed(_ text: NSString) -> Bool {
    var index = 0
    while index < text.length {
      let unit = text.character(at: index)
      if (0xDC00...0xDFFF).contains(unit) { return false }
      if (0xD800...0xDBFF).contains(unit) {
        guard index + 1 < text.length, (0xDC00...0xDFFF).contains(text.character(at: index + 1)) else { return false }
        index += 1
      }
      index += 1
    }
    return true
  }

  static func marking(_ line: Data, dropped: Int) -> Data {
    guard line.count >= 2, line.first == UInt8(ascii: "{"), line[line.startIndex + 1] != UInt8(ascii: "}") else { return line }
    var marked = Data("{\"dropped\":\(dropped),".utf8)
    marked.append(line.dropFirst())
    return marked
  }

  static func fittedReply(_ data: Data) -> Data {
    guard data.count > maxLine else { return data }
    let message = "The reply would be over 1 MiB, the most a line can carry; ask for less."
    let parsed = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? [String: Any]
    let reply: [String: Any] = ["id": echoedId(parsed?["id"]), "error": ["code": "failed", "message": message]]
    var line = (try? JSONSerialization.data(withJSONObject: reply)) ?? Data("{\"id\":null,\"error\":{\"code\":\"failed\",\"message\":\"\(message)\"}}".utf8)
    line.append(10)
    return line
  }
}
