package com.ardia.phone;

import expo.modules.sqlite.NativeDatabaseBinding;
import expo.modules.sqlite.NativeStatementBinding;
import java.io.Closeable;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

final class ExpoSqliteConnection implements Closeable {
    private static final int SQLITE_OK = 0;
    private static final int SQLITE_ROW = 100;
    private static final int SQLITE_DONE = 101;

    private final NativeDatabaseBinding database = new NativeDatabaseBinding();
    private boolean closed;

    ExpoSqliteConnection(String path) throws IOException {
        int opened = database.sqlite3_open(path);
        if (opened != SQLITE_OK) {
            String reason = database.convertSqlLiteErrorToString();
            close();
            throw new IOException("couldn't open the phone's database: " + reason);
        }
    }

    List<List<Object>> query(String sql, List<String> args) throws IOException {
        NativeStatementBinding statement = new NativeStatementBinding();
        try {
            try {
                database.sqlite3_prepare_v2(sql, statement);
            } catch (RuntimeException failure) {
                throw new IOException("couldn't read the phone's database: " + failure.getMessage(), failure);
            }
            for (int index = 0; index < args.size(); index++) {
                if (statement.bindStatementParam(index + 1, args.get(index)) != SQLITE_OK) {
                    throw new IOException("couldn't read the phone's database: " + statement.getLastErrorMessage());
                }
            }
            List<List<Object>> rows = new ArrayList<>();
            while (true) {
                int step = statement.sqlite3_step();
                if (step == SQLITE_DONE) break;
                if (step != SQLITE_ROW) throw new IOException("couldn't read the phone's database: " + statement.getLastErrorMessage());
                rows.add(new ArrayList<>(statement.getColumnValues()));
            }
            return rows;
        } finally {
            statement.sqlite3_finalize();
            statement.close();
        }
    }

    @Override
    public void close() {
        if (closed) return;
        closed = true;
        database.sqlite3_close();
        database.close();
    }
}
