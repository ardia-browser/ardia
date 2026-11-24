import Foundation
import SQLite3

struct VaultDeliveredMessage: Sendable, Equatable {
  var source: VaultDeliveredSource
  var key: String
  var sender: String
  var text: String
  var receivedAt: Date
}

enum VaultDeliveredReach: Sendable, Equatable {
  case readable
  case denied
  case missing
}

struct VaultDeliveredRead: Sendable {
  var reach: VaultDeliveredReach
  var messages: [VaultDeliveredMessage]
  var watched: [String]

  static let denied = VaultDeliveredRead(reach: .denied, messages: [], watched: [])
  static let missing = VaultDeliveredRead(reach: .missing, messages: [], watched: [])
}

struct VaultDeliveredPaths: Sendable {
  var messages: String?
  var mailEnvelope: String?
  var mailRoot: String?

  static func live(messagesFixture: String?, mailFixture: String?) -> VaultDeliveredPaths {
    let home = realHome()
    var paths = VaultDeliveredPaths(messages: home + "/Library/Messages/chat.db", mailEnvelope: nil, mailRoot: home + "/Library/Mail")
    if let messagesFixture, !messagesFixture.isEmpty { paths.messages = messagesFixture }
    if let mailFixture, !mailFixture.isEmpty {
      paths.mailEnvelope = mailFixture
      paths.mailRoot = nil
    }
    return paths
  }

  static func realHome() -> String {
    if let entry = getpwuid(getuid()), let directory = entry.pointee.pw_dir { return String(cString: directory) }
    return NSHomeDirectory()
  }
}

enum VaultDeliveredSQLite {
  static let busyMilliseconds: Int32 = 150
  static let rowLimit: Int32 = 60
  static let newestRows: Int64 = 400
  static let longestBody = 64 * 1024

  static func reach(file path: String) -> VaultDeliveredReach {
    let descriptor = open(path, O_RDONLY | O_CLOEXEC)
    if descriptor >= 0 {
      close(descriptor)
      return .readable
    }
    return errno == EPERM || errno == EACCES ? .denied : .missing
  }

  static func reach(folder path: String) -> VaultDeliveredReach {
    guard let folder = opendir(path) else { return errno == EPERM || errno == EACCES ? .denied : .missing }
    closedir(folder)
    return .readable
  }

  static func withReadOnly<T>(_ path: String, _ body: (OpaquePointer) -> T?) -> T? {
    var handle: OpaquePointer?
    let flags = SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX | SQLITE_OPEN_PRIVATECACHE
    guard sqlite3_open_v2(path, &handle, flags, nil) == SQLITE_OK, let db = handle else {
      if let handle { sqlite3_close_v2(handle) }
      return nil
    }
    defer { sqlite3_close_v2(db) }
    sqlite3_busy_timeout(db, busyMilliseconds)
    guard sqlite3_exec(db, "PRAGMA query_only = 1", nil, nil, nil) == SQLITE_OK else { return nil }
    return body(db)
  }

  static func columns(_ db: OpaquePointer, table: String) -> Set<String> {
    var names = Set<String>()
    _ = each(db, "PRAGMA table_info(\(table))", bind: { _ in }) { row in
      if let name = text(row, 1) { names.insert(name) }
    }
    return names
  }

  @discardableResult
  static func each(_ db: OpaquePointer, _ sql: String, bind: (OpaquePointer) -> Void, row: (OpaquePointer) -> Void) -> Bool {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let prepared = statement else { return false }
    defer { sqlite3_finalize(prepared) }
    bind(prepared)
    while true {
      let step = sqlite3_step(prepared)
      if step == SQLITE_ROW {
        row(prepared)
        continue
      }
      return step == SQLITE_DONE
    }
  }

  static func bindRecent(_ statement: OpaquePointer, cutoff: Int64) {
    sqlite3_bind_int64(statement, 1, cutoff)
    sqlite3_bind_int(statement, 2, rowLimit)
    sqlite3_bind_int64(statement, 3, newestRows)
  }

  static func text(_ statement: OpaquePointer, _ column: Int32) -> String? {
    guard sqlite3_column_type(statement, column) != SQLITE_NULL, let bytes = sqlite3_column_text(statement, column) else { return nil }
    let count = Int(sqlite3_column_bytes(statement, column))
    guard count <= longestBody else { return nil }
    return String(decoding: UnsafeBufferPointer(start: bytes, count: count), as: UTF8.self)
  }

  static func blob(_ statement: OpaquePointer, _ column: Int32) -> Data? {
    guard sqlite3_column_type(statement, column) == SQLITE_BLOB, let bytes = sqlite3_column_blob(statement, column) else { return nil }
    let count = Int(sqlite3_column_bytes(statement, column))
    guard count > 0, count <= longestBody else { return nil }
    return Data(bytes: bytes, count: count)
  }
}

enum VaultMessagesReader {
  static let appleEpoch: TimeInterval = 978_307_200

  static func read(_ path: String, since: Date) -> VaultDeliveredRead {
    VaultOffMain.check()
    let reach = VaultDeliveredSQLite.reach(file: path)
    guard reach == .readable else { return reach == .denied ? .denied : .missing }
    let watched = [path, path + "-wal"]
    let cutoff = Int64(((since.timeIntervalSince1970 - appleEpoch) * 1_000_000_000).rounded(.down))
    let messages = VaultDeliveredSQLite.withReadOnly(path) { db -> [VaultDeliveredMessage]? in
      let have = VaultDeliveredSQLite.columns(db, table: "message")
      guard have.isSuperset(of: ["ROWID", "text", "date", "is_from_me", "handle_id"]) else { return nil }
      var found: [VaultDeliveredMessage] = []
      let done = VaultDeliveredSQLite.each(db, sql(have), bind: { statement in
        VaultDeliveredSQLite.bindRecent(statement, cutoff: cutoff)
      }) { row in
        let text = VaultDeliveredSQLite.text(row, 1).flatMap { $0.isEmpty ? nil : $0 }
          ?? VaultDeliveredSQLite.blob(row, 2).flatMap(VaultTypedStreamText.text)
        guard let text else { return }
        let nanoseconds = sqlite3_column_int64(row, 3)
        let received = Date(timeIntervalSince1970: Double(nanoseconds) / 1_000_000_000 + appleEpoch)
        found.append(VaultDeliveredMessage(
          source: .messages, key: "messages/\(sqlite3_column_int64(row, 0))", sender: VaultDeliveredSQLite.text(row, 4) ?? "", text: text,
          receivedAt: received))
      }
      return done ? found : nil
    }
    return VaultDeliveredRead(reach: .readable, messages: messages ?? [], watched: watched)
  }

  static func sql(_ have: Set<String>) -> String {
    let body = have.contains("attributedBody") ? "m.attributedBody" : "NULL"
    let kind = have.contains("item_type") ? " AND m.item_type = 0" : ""
    return """
      SELECT m.ROWID, m.text, \(body), m.date, h.id FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id \
      WHERE m.ROWID > IFNULL((SELECT MAX(ROWID) FROM message), 0) - ?3 AND m.is_from_me = 0 AND +m.date >= ?1\(kind) \
      ORDER BY +m.date DESC LIMIT ?2
      """
  }
}

enum VaultMailReader {
  static func envelope(root: String) -> (reach: VaultDeliveredReach, path: String?) {
    let reach = VaultDeliveredSQLite.reach(folder: root)
    guard reach == .readable else { return (reach, nil) }
    let names = (try? FileManager.default.contentsOfDirectory(atPath: root)) ?? []
    let versions = names.compactMap { name -> (Int, String)? in
      guard name.hasPrefix("V"), let number = Int(name.dropFirst()), number > 0 else { return nil }
      return (number, name)
    }
    for (_, name) in versions.sorted(by: { $0.0 > $1.0 }) {
      let path = "\(root)/\(name)/MailData/Envelope Index"
      if VaultDeliveredSQLite.reach(file: path) != .missing { return (VaultDeliveredSQLite.reach(file: path), path) }
    }
    return (.missing, nil)
  }

  static func read(_ path: String, since: Date) -> VaultDeliveredRead {
    VaultOffMain.check()
    let reach = VaultDeliveredSQLite.reach(file: path)
    guard reach == .readable else { return reach == .denied ? .denied : .missing }
    let watched = [path, path + "-wal"]
    let cutoff = Int64(since.timeIntervalSince1970.rounded(.down))
    let messages = VaultDeliveredSQLite.withReadOnly(path) { db -> [VaultDeliveredMessage]? in
      let have = VaultDeliveredSQLite.columns(db, table: "messages")
      guard have.isSuperset(of: ["ROWID", "sender", "subject", "date_received", "mailbox"]),
        VaultDeliveredSQLite.columns(db, table: "mailboxes").isSuperset(of: ["ROWID", "url"])
      else { return nil }
      let summaries = have.contains("summary") && !VaultDeliveredSQLite.columns(db, table: "summaries").isEmpty
      var found: [VaultDeliveredMessage] = []
      let done = VaultDeliveredSQLite.each(db, sql(have, summaries: summaries), bind: { statement in
        VaultDeliveredSQLite.bindRecent(statement, cutoff: cutoff)
      }) { row in
        guard isInbox(VaultDeliveredSQLite.text(row, 5)) else { return }
        let subject = VaultDeliveredSQLite.text(row, 1) ?? ""
        let summary = VaultDeliveredSQLite.text(row, 2) ?? ""
        let text = [subject, summary].filter { !$0.isEmpty }.joined(separator: "\n")
        guard !text.isEmpty else { return }
        found.append(VaultDeliveredMessage(
          source: .mail, key: "mail/\(sqlite3_column_int64(row, 0))", sender: VaultDeliveredSQLite.text(row, 4) ?? "", text: text,
          receivedAt: Date(timeIntervalSince1970: Double(sqlite3_column_int64(row, 3)))))
      }
      return done ? found : nil
    }
    return VaultDeliveredRead(reach: .readable, messages: messages ?? [], watched: watched)
  }
}

extension VaultMailReader {
  static func sql(_ have: Set<String>, summaries: Bool) -> String {
    let summaryColumn = summaries ? "su.summary" : "NULL"
    let summaryJoin = summaries ? " LEFT JOIN summaries su ON su.ROWID = m.summary" : ""
    let deleted = have.contains("deleted") ? " AND m.deleted = 0" : ""
    return """
      SELECT m.ROWID, s.subject, \(summaryColumn), m.date_received, a.address, mb.url FROM messages m \
      LEFT JOIN subjects s ON s.ROWID = m.subject LEFT JOIN addresses a ON a.ROWID = m.sender \
      LEFT JOIN mailboxes mb ON mb.ROWID = m.mailbox\(summaryJoin) \
      WHERE m.ROWID > IFNULL((SELECT MAX(ROWID) FROM messages), 0) - ?3 AND +m.date_received >= ?1\(deleted) \
      ORDER BY +m.date_received DESC LIMIT ?2
      """
  }

  static let skippedMailboxes: Set<String> = [
    "junk", "junk e-mail", "junk email", "spam", "bulk mail", "trash", "deleted messages", "deleted items", "bin", "deleted",
  ]

  static func isInbox(_ url: String?) -> Bool {
    guard let url, !url.isEmpty else { return false }
    let trimmed = url.hasSuffix("/") ? String(url.dropLast()) : url
    let last = trimmed.split(separator: "/").last.map(String.init) ?? trimmed
    let name = (last.removingPercentEncoding ?? last).lowercased()
    return !skippedMailboxes.contains(name)
  }
}

enum VaultTypedStreamText {
  private static let header = Array("streamtyped".utf8)
  private static let stringClass = Array("NSString".utf8)

  static func text(_ data: Data) -> String? {
    let bytes = [UInt8](data)
    guard bytes.count > header.count + 2, Array(bytes[2..<(2 + header.count)]) == header else { return nil }
    guard let mark = find(stringClass, in: bytes) else { return nil }
    var cursor = mark + stringClass.count
    let limit = min(bytes.count, cursor + 8)
    while cursor < limit, bytes[cursor] != 0x2B { cursor += 1 }
    guard cursor < limit else { return nil }
    cursor += 1
    guard let (length, after) = length(bytes, at: cursor), length > 0, length <= bytes.count - after else { return nil }
    return String(bytes: bytes[after..<(after + length)], encoding: .utf8)
  }

  private static func length(_ bytes: [UInt8], at index: Int) -> (Int, Int)? {
    guard index < bytes.count else { return nil }
    switch bytes[index] {
    case 0x81:
      guard index + 2 < bytes.count else { return nil }
      return (Int(bytes[index + 1]) | Int(bytes[index + 2]) << 8, index + 3)
    case 0x82:
      guard index + 4 < bytes.count else { return nil }
      let value = Int(bytes[index + 1]) | Int(bytes[index + 2]) << 8 | Int(bytes[index + 3]) << 16 | Int(bytes[index + 4]) << 24
      return (value, index + 5)
    case let small where small < 0x80:
      return (Int(small), index + 1)
    default:
      return nil
    }
  }

  private static func find(_ needle: [UInt8], in haystack: [UInt8]) -> Int? {
    guard haystack.count >= needle.count else { return nil }
    for start in 0...(haystack.count - needle.count) where haystack[start] == needle[0] {
      if Array(haystack[start..<(start + needle.count)]) == needle { return start }
    }
    return nil
  }
}
