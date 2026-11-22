import Foundation
import SQLite3

public struct SQLiteEngine: Sendable {
  public var open: @Sendable (_ path: String, _ flags: Int32) -> (result: Int32, handle: OpaquePointer?)
  public var close: @Sendable (OpaquePointer) -> Void
  public var exec: @Sendable (OpaquePointer, String) -> Int32
  public var busyTimeout: @Sendable (OpaquePointer, Int32) -> Void
  public var errorCode: @Sendable (OpaquePointer) -> Int32
  public var prepare: @Sendable (OpaquePointer, String) -> (result: Int32, statement: OpaquePointer?)
  public var finalize: @Sendable (OpaquePointer) -> Void
  public var bindText: @Sendable (OpaquePointer, Int32, String) -> Void
  public var bindInt64: @Sendable (OpaquePointer, Int32, Int64) -> Void
  public var bindNull: @Sendable (OpaquePointer, Int32) -> Void
  public var step: @Sendable (OpaquePointer) -> Int32
  public var columnCount: @Sendable (OpaquePointer) -> Int32
  public var columnType: @Sendable (OpaquePointer, Int32) -> Int32
  public var columnInt64: @Sendable (OpaquePointer, Int32) -> Int64
  public var columnDouble: @Sendable (OpaquePointer, Int32) -> Double
  public var columnText: @Sendable (OpaquePointer, Int32) -> String?

  public init(
    open: @escaping @Sendable (_ path: String, _ flags: Int32) -> (result: Int32, handle: OpaquePointer?),
    close: @escaping @Sendable (OpaquePointer) -> Void,
    exec: @escaping @Sendable (OpaquePointer, String) -> Int32,
    busyTimeout: @escaping @Sendable (OpaquePointer, Int32) -> Void,
    errorCode: @escaping @Sendable (OpaquePointer) -> Int32,
    prepare: @escaping @Sendable (OpaquePointer, String) -> (result: Int32, statement: OpaquePointer?),
    finalize: @escaping @Sendable (OpaquePointer) -> Void,
    bindText: @escaping @Sendable (OpaquePointer, Int32, String) -> Void,
    bindInt64: @escaping @Sendable (OpaquePointer, Int32, Int64) -> Void,
    bindNull: @escaping @Sendable (OpaquePointer, Int32) -> Void,
    step: @escaping @Sendable (OpaquePointer) -> Int32,
    columnCount: @escaping @Sendable (OpaquePointer) -> Int32,
    columnType: @escaping @Sendable (OpaquePointer, Int32) -> Int32,
    columnInt64: @escaping @Sendable (OpaquePointer, Int32) -> Int64,
    columnDouble: @escaping @Sendable (OpaquePointer, Int32) -> Double,
    columnText: @escaping @Sendable (OpaquePointer, Int32) -> String?
  ) {
    self.open = open
    self.close = close
    self.exec = exec
    self.busyTimeout = busyTimeout
    self.errorCode = errorCode
    self.prepare = prepare
    self.finalize = finalize
    self.bindText = bindText
    self.bindInt64 = bindInt64
    self.bindNull = bindNull
    self.step = step
    self.columnCount = columnCount
    self.columnType = columnType
    self.columnInt64 = columnInt64
    self.columnDouble = columnDouble
    self.columnText = columnText
  }

  public enum Value: Sendable, Equatable {
    case null
    case integer(Int64)
    case real(Double)
    case text(String)

    public var text: String? {
      if case let .text(text) = self { return text }
      return nil
    }

    public var number: Double? {
      switch self {
      case let .integer(number): Double(number)
      case let .real(number): number
      default: nil
      }
    }
  }

  public func readRows(at path: String, _ sql: String, _ arguments: [String], busyTimeoutMilliseconds: Int32) -> [[Value]]? {
    let (opened, handle) = open(path, SQLITE_OPEN_READONLY)
    guard opened == SQLITE_OK, let handle else {
      if let handle { close(handle) }
      return nil
    }
    defer { close(handle) }
    busyTimeout(handle, busyTimeoutMilliseconds)
    let (prepared, statement) = prepare(handle, sql)
    guard prepared == SQLITE_OK, let statement else { return nil }
    defer { finalize(statement) }
    for (index, argument) in arguments.enumerated() {
      bindText(statement, Int32(index + 1), argument)
    }
    var rows: [[Value]] = []
    while step(statement) == SQLITE_ROW {
      rows.append((0..<columnCount(statement)).map { column in
        switch columnType(statement, column) {
        case SQLITE_NULL: .null
        case SQLITE_INTEGER: .integer(columnInt64(statement, column))
        case SQLITE_FLOAT: .real(columnDouble(statement, column))
        default: columnText(statement, column).map(Value.text) ?? .null
        }
      })
    }
    return rows
  }

  public static let system = SQLiteEngine(
    open: { path, flags in
      var handle: OpaquePointer?
      let result = sqlite3_open_v2(path, &handle, flags, nil)
      return (result, handle)
    },
    close: { sqlite3_close_v2($0) },
    exec: { sqlite3_exec($0, $1, nil, nil, nil) },
    busyTimeout: { sqlite3_busy_timeout($0, $1) },
    errorCode: { sqlite3_errcode($0) },
    prepare: { connection, sql in
      var statement: OpaquePointer?
      let result = sqlite3_prepare_v2(connection, sql, -1, &statement, nil)
      return (result, statement)
    },
    finalize: { sqlite3_finalize($0) },
    bindText: { sqlite3_bind_text($0, $1, $2, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self)) },
    bindInt64: { sqlite3_bind_int64($0, $1, $2) },
    bindNull: { sqlite3_bind_null($0, $1) },
    step: { sqlite3_step($0) },
    columnCount: { sqlite3_column_count($0) },
    columnType: { sqlite3_column_type($0, $1) },
    columnInt64: { sqlite3_column_int64($0, $1) },
    columnDouble: { sqlite3_column_double($0, $1) },
    columnText: { sqlite3_column_text($0, $1).map { String(cString: $0) } }
  )
}
