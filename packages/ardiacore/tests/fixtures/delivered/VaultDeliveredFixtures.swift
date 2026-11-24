import Foundation
import SQLite3

struct VaultDeliveredFixtureText {
  var sender: String
  var secondsAgo: Double
  var text: String
  var attributed = false
  var fromMe = false
}

struct VaultDeliveredFixtureMail {
  var sender: String
  var secondsAgo: Double
  var subject: String
  var summary: String
  var deleted = false
  var mailbox = "imap://fixture%40example.com@imap.example.com/INBOX"
}

enum VaultDeliveredFixtureError: Error {
  case sqlite(String)
}

enum VaultDeliveredFixtures {
  static let appleEpoch: TimeInterval = 978_307_200

  static let messagesSchema = """
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, country TEXT, service TEXT NOT NULL,
      uncanonicalized_id TEXT, person_centric_id TEXT, UNIQUE (id, service));
    CREATE TABLE IF NOT EXISTS message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, replace INTEGER DEFAULT 0,
      service_center TEXT, handle_id INTEGER DEFAULT 0, subject TEXT, country TEXT, attributedBody BLOB, version INTEGER DEFAULT 0,
      type INTEGER DEFAULT 0, service TEXT, account TEXT, account_guid TEXT, error INTEGER DEFAULT 0, date INTEGER, date_read INTEGER,
      date_delivered INTEGER, is_delivered INTEGER DEFAULT 0, is_finished INTEGER DEFAULT 0, is_emote INTEGER DEFAULT 0,
      is_from_me INTEGER DEFAULT 0, is_empty INTEGER DEFAULT 0, is_read INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0,
      associated_message_guid TEXT, associated_message_type INTEGER DEFAULT 0);
    CREATE INDEX IF NOT EXISTS message_idx_date ON message(date);
    """

  static let mailSchema = """
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS subjects (ROWID INTEGER PRIMARY KEY, subject COLLATE RTRIM, normalized_subject TEXT);
    CREATE TABLE IF NOT EXISTS summaries (ROWID INTEGER PRIMARY KEY, summary TEXT);
    CREATE TABLE IF NOT EXISTS addresses (ROWID INTEGER PRIMARY KEY, address COLLATE RTRIM, comment, UNIQUE(address, comment));
    CREATE TABLE IF NOT EXISTS mailboxes (ROWID INTEGER PRIMARY KEY, url UNIQUE);
    CREATE TABLE IF NOT EXISTS messages (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL DEFAULT 0,
      global_message_id INTEGER NOT NULL DEFAULT 0, remote_id INTEGER, document_id TEXT, sender INTEGER, subject_prefix TEXT,
      subject INTEGER NOT NULL, summary INTEGER, date_sent INTEGER, date_received INTEGER, mailbox INTEGER NOT NULL DEFAULT 1,
      remote_mailbox INTEGER, flags INTEGER NOT NULL DEFAULT 0, read INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0, conversation_id INTEGER NOT NULL DEFAULT 0,
      date_last_viewed INTEGER, list_id_hash INTEGER, unsubscribe_type INTEGER, searchable_message INTEGER, brand_indicator INTEGER,
      display_date INTEGER, color TEXT, type INTEGER, fuzzy_ancestor INTEGER, automated_conversation INTEGER DEFAULT 0, root_status INTEGER DEFAULT -1);
    """

  static func attributedBody(_ text: String) -> Data {
    let body = NSMutableAttributedString(string: text, attributes: [NSAttributedString.Key("__kIMMessagePartAttributeName"): 0])
    return NSArchiver.archivedData(withRootObject: body)
  }

  static func writeMessages(_ path: String, _ texts: [VaultDeliveredFixtureText], now: Date = Date()) throws {
    try withDatabase(path) { db in
      try run(db, messagesSchema)
      for entry in texts {
        let handle = try insert(db, "INSERT OR IGNORE INTO handle (id, service) VALUES (?1, 'SMS')", [.text(entry.sender)])
        let handleId = handle > 0 ? handle : try scalar(db, "SELECT ROWID FROM handle WHERE id = ?1", [.text(entry.sender)])
        let date = Int64(((now.timeIntervalSince1970 - entry.secondsAgo - appleEpoch) * 1_000_000_000).rounded())
        let text: Value = entry.attributed ? .null : .text(entry.text)
        let body: Value = entry.attributed ? .blob(attributedBody(entry.text)) : .null
        _ = try insert(db, """
          INSERT INTO message (guid, text, handle_id, attributedBody, service, date, is_from_me, item_type) VALUES (?1, ?2, ?3, ?4, 'SMS', ?5, ?6, 0)
          """, [.text(UUID().uuidString), text, .int(handleId), body, .int(date), .int(entry.fromMe ? 1 : 0)])
      }
    }
  }

  static func writeMail(_ path: String, _ mails: [VaultDeliveredFixtureMail], now: Date = Date()) throws {
    try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try withDatabase(path) { db in
      try run(db, mailSchema)
      for mail in mails {
        let added = try insert(db, "INSERT OR IGNORE INTO addresses (address, comment) VALUES (?1, '')", [.text(mail.sender)])
        let address = added > 0 ? added : try scalar(db, "SELECT ROWID FROM addresses WHERE address = ?1", [.text(mail.sender)])
        let subject = try insert(db, "INSERT INTO subjects (subject) VALUES (?1)", [.text(mail.subject)])
        let summary = try insert(db, "INSERT INTO summaries (summary) VALUES (?1)", [.text(mail.summary)])
        let addedBox = try insert(db, "INSERT OR IGNORE INTO mailboxes (url) VALUES (?1)", [.text(mail.mailbox)])
        let box = addedBox > 0 ? addedBox : try scalar(db, "SELECT ROWID FROM mailboxes WHERE url = ?1", [.text(mail.mailbox)])
        let received = Int64((now.timeIntervalSince1970 - mail.secondsAgo).rounded())
        _ = try insert(db, """
          INSERT INTO messages (sender, subject, summary, date_sent, date_received, deleted, mailbox) VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6)
          """, [.int(address), .int(subject), .int(summary), .int(received), .int(mail.deleted ? 1 : 0), .int(box)])
      }
    }
  }

  static func writeOldHistory(messages path: String, count: Int, now: Date = Date()) throws {
    try withDatabase(path) { db in
      try run(db, messagesSchema)
      let date = Int64(((now.timeIntervalSince1970 - 86_400 - appleEpoch) * 1_000_000_000).rounded())
      try run(db, """
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < \(count))
        INSERT INTO message (guid, text, handle_id, service, date, is_from_me, item_type)
        SELECT '\(UUID().uuidString)-' || i, 'Your code is 100000', 0, 'SMS', \(date), 0, 0 FROM n
        """)
    }
  }

  static func writeOldHistory(mail path: String, count: Int, now: Date = Date()) throws {
    try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try withDatabase(path) { db in
      try run(db, mailSchema)
      let received = Int64(now.timeIntervalSince1970 - 86_400)
      try run(db, """
        INSERT OR IGNORE INTO mailboxes (ROWID, url) VALUES (1, 'imap://fixture%40example.com@imap.example.com/INBOX');
        INSERT OR IGNORE INTO subjects (ROWID, subject) VALUES (1, 'Your code is 100000');
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < \(count))
        INSERT INTO messages (sender, subject, date_sent, date_received, mailbox) SELECT 0, 1, \(received), \(received), 1 FROM n
        """)
    }
  }

  static func queryPlan(_ path: String, _ sql: String) throws -> String {
    var plan: [String] = []
    try withDatabase(path) { db in
      try step(db, "EXPLAIN QUERY PLAN " + sql, []) { row in
        if let detail = sqlite3_column_text(row, 3) { plan.append(String(cString: detail)) }
      }
    }
    return plan.joined(separator: "\n")
  }

  enum Value {
    case text(String)
    case int(Int64)
    case blob(Data)
    case null
  }

  private static func withDatabase(_ path: String, _ body: (OpaquePointer) throws -> Void) throws {
    var handle: OpaquePointer?
    guard sqlite3_open_v2(path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) == SQLITE_OK, let db = handle else {
      throw VaultDeliveredFixtureError.sqlite("open \(path)")
    }
    defer { sqlite3_close_v2(db) }
    try body(db)
  }

  private static func run(_ db: OpaquePointer, _ sql: String) throws {
    guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw VaultDeliveredFixtureError.sqlite(String(cString: sqlite3_errmsg(db))) }
  }

  private static func insert(_ db: OpaquePointer, _ sql: String, _ values: [Value]) throws -> Int64 {
    let changesBefore = sqlite3_total_changes(db)
    try step(db, sql, values) { _ in }
    return sqlite3_total_changes(db) == changesBefore ? 0 : sqlite3_last_insert_rowid(db)
  }

  private static func scalar(_ db: OpaquePointer, _ sql: String, _ values: [Value]) throws -> Int64 {
    var found: Int64 = 0
    try step(db, sql, values) { found = sqlite3_column_int64($0, 0) }
    return found
  }

  private static func step(_ db: OpaquePointer, _ sql: String, _ values: [Value], row: (OpaquePointer) -> Void) throws {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let prepared = statement else {
      throw VaultDeliveredFixtureError.sqlite(String(cString: sqlite3_errmsg(db)))
    }
    defer { sqlite3_finalize(prepared) }
    let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    for (offset, value) in values.enumerated() {
      let index = Int32(offset + 1)
      switch value {
      case .text(let text): sqlite3_bind_text(prepared, index, text, -1, transient)
      case .int(let number): sqlite3_bind_int64(prepared, index, number)
      case .blob(let data): _ = data.withUnsafeBytes { sqlite3_bind_blob(prepared, index, $0.baseAddress, Int32(data.count), transient) }
      case .null: sqlite3_bind_null(prepared, index)
      }
    }
    while true {
      let result = sqlite3_step(prepared)
      if result == SQLITE_ROW {
        row(prepared)
        continue
      }
      guard result == SQLITE_DONE else { throw VaultDeliveredFixtureError.sqlite(String(cString: sqlite3_errmsg(db))) }
      return
    }
  }
}
