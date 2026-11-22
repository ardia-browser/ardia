import ExpoSQLite
import PhoneSync

extension SQLiteEngine {
  public static let expoSQLite = SQLiteEngine(
    open: { path, flags in
      var handle: OpaquePointer?
      let result = exsqlite3_open_v2(path, &handle, flags, nil)
      return (result, handle)
    },
    close: { exsqlite3_close_v2($0) },
    exec: { exsqlite3_exec($0, $1, nil, nil, nil) },
    busyTimeout: { exsqlite3_busy_timeout($0, $1) },
    errorCode: { exsqlite3_errcode($0) },
    prepare: { connection, sql in
      var statement: OpaquePointer?
      let result = exsqlite3_prepare_v2(connection, sql, -1, &statement, nil)
      return (result, statement)
    },
    finalize: { exsqlite3_finalize($0) },
    bindText: { exsqlite3_bind_text($0, $1, $2, -1, unsafeBitCast(-1, to: ExpoSQLite.sqlite3_destructor_type.self)) },
    bindInt64: { exsqlite3_bind_int64($0, $1, $2) },
    bindNull: { exsqlite3_bind_null($0, $1) },
    step: { exsqlite3_step($0) },
    columnCount: { exsqlite3_column_count($0) },
    columnType: { exsqlite3_column_type($0, $1) },
    columnInt64: { exsqlite3_column_int64($0, $1) },
    columnDouble: { exsqlite3_column_double($0, $1) },
    columnText: { exsqlite3_column_text($0, $1).map { String(cString: $0) } }
  )
}
