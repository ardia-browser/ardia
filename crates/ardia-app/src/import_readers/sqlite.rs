use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::path::{Path, PathBuf};

#[repr(C)]
struct RawDb {
    _private: [u8; 0],
}

#[repr(C)]
struct RawStmt {
    _private: [u8; 0],
}

const SQLITE_OK: c_int = 0;
const SQLITE_ROW: c_int = 100;
const SQLITE_DONE: c_int = 101;
const SQLITE_OPEN_READONLY: c_int = 0x0000_0001;
const SQLITE_OPEN_URI: c_int = 0x0000_0040;
const SQLITE_NULL: c_int = 5;

#[link(name = "sqlite3")]
unsafe extern "C" {
    fn sqlite3_open_v2(
        filename: *const c_char,
        db: *mut *mut RawDb,
        flags: c_int,
        vfs: *const c_char,
    ) -> c_int;
    fn sqlite3_close(db: *mut RawDb) -> c_int;
    fn sqlite3_prepare_v2(
        db: *mut RawDb,
        sql: *const c_char,
        bytes: c_int,
        stmt: *mut *mut RawStmt,
        tail: *mut *const c_char,
    ) -> c_int;
    fn sqlite3_step(stmt: *mut RawStmt) -> c_int;
    fn sqlite3_finalize(stmt: *mut RawStmt) -> c_int;
    fn sqlite3_column_count(stmt: *mut RawStmt) -> c_int;
    fn sqlite3_column_name(stmt: *mut RawStmt, index: c_int) -> *const c_char;
    fn sqlite3_column_type(stmt: *mut RawStmt, index: c_int) -> c_int;
    fn sqlite3_column_int64(stmt: *mut RawStmt, index: c_int) -> i64;
    fn sqlite3_column_text(stmt: *mut RawStmt, index: c_int) -> *const u8;
    fn sqlite3_column_blob(stmt: *mut RawStmt, index: c_int) -> *const c_void;
    fn sqlite3_column_bytes(stmt: *mut RawStmt, index: c_int) -> c_int;
    fn sqlite3_busy_timeout(db: *mut RawDb, ms: c_int) -> c_int;
    fn sqlite3_errmsg(db: *mut RawDb) -> *const c_char;
}

pub struct Snapshot {
    db: *mut RawDb,
    dir: PathBuf,
}

pub struct Row<'a> {
    stmt: *mut RawStmt,
    names: &'a [String],
}

impl Row<'_> {
    fn index(&self, name: &str) -> Option<c_int> {
        self.names
            .iter()
            .position(|n| n == name)
            .map(|i| i as c_int)
    }

    fn present(&self, name: &str) -> Option<c_int> {
        let index = self.index(name)?;
        (unsafe { sqlite3_column_type(self.stmt, index) } != SQLITE_NULL).then_some(index)
    }

    pub fn int(&self, name: &str) -> Option<i64> {
        let index = self.present(name)?;
        Some(unsafe { sqlite3_column_int64(self.stmt, index) })
    }

    pub fn text(&self, name: &str) -> Option<String> {
        let bytes = self.blob(name)?;
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }

    pub fn blob(&self, name: &str) -> Option<Vec<u8>> {
        let index = self.present(name)?;
        unsafe {
            let ty = sqlite3_column_type(self.stmt, index);
            let pointer = if ty == 3 {
                sqlite3_column_text(self.stmt, index).cast::<c_void>()
            } else {
                sqlite3_column_blob(self.stmt, index)
            };
            let length = sqlite3_column_bytes(self.stmt, index);
            if pointer.is_null() || length <= 0 {
                return Some(Vec::new());
            }
            Some(std::slice::from_raw_parts(pointer.cast::<u8>(), length as usize).to_vec())
        }
    }
}

fn unique_dir() -> PathBuf {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "ardia-import-{}-{n}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ))
}

impl Snapshot {
    pub fn copying(source: &Path) -> Result<Snapshot, String> {
        let name = source
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if !source.is_file() {
            return Err(format!("{name} not found"));
        }
        let dir = unique_dir();
        std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't copy {name}: {e}"))?;
        let copy = dir.join("db.sqlite");
        if let Err(e) = std::fs::copy(source, &copy) {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(format!("Couldn't copy {name}: {e}"));
        }
        for suffix in ["-wal", "-journal"] {
            let sibling = PathBuf::from(format!("{}{suffix}", source.display()));
            if sibling.is_file() {
                let _ = std::fs::copy(
                    &sibling,
                    PathBuf::from(format!("{}{suffix}", copy.display())),
                );
            }
        }
        let uri = CString::new(format!("file:{}?mode=ro", copy.display()))
            .map_err(|_| format!("Couldn't open {name}"))?;
        let mut db = std::ptr::null_mut();
        let status = unsafe {
            sqlite3_open_v2(
                uri.as_ptr(),
                &mut db,
                SQLITE_OPEN_READONLY | SQLITE_OPEN_URI,
                std::ptr::null(),
            )
        };
        if status != SQLITE_OK {
            let message = if db.is_null() {
                "open failed".to_owned()
            } else {
                unsafe {
                    CStr::from_ptr(sqlite3_errmsg(db))
                        .to_string_lossy()
                        .into_owned()
                }
            };
            unsafe { sqlite3_close(db) };
            let _ = std::fs::remove_dir_all(&dir);
            return Err(format!("Couldn't open {name}: {message}"));
        }
        unsafe { sqlite3_busy_timeout(db, 2000) };
        Ok(Snapshot { db, dir })
    }

    pub fn table_exists(&self, table: &str) -> bool {
        let mut found = false;
        let sql = format!(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='{}'",
            table.replace('\'', "''")
        );
        let _ = self.query(&sql, |_| {
            found = true;
            false
        });
        found
    }

    pub fn query(&self, sql: &str, mut each: impl FnMut(&Row<'_>) -> bool) -> Result<(), String> {
        let sql = CString::new(sql).map_err(|_| "bad query".to_owned())?;
        let mut stmt = std::ptr::null_mut();
        let status = unsafe {
            sqlite3_prepare_v2(self.db, sql.as_ptr(), -1, &mut stmt, std::ptr::null_mut())
        };
        if status != SQLITE_OK || stmt.is_null() {
            let message = unsafe {
                CStr::from_ptr(sqlite3_errmsg(self.db))
                    .to_string_lossy()
                    .into_owned()
            };
            unsafe { sqlite3_finalize(stmt) };
            return Err(message);
        }
        let count = unsafe { sqlite3_column_count(stmt) };
        let names: Vec<String> = (0..count)
            .map(|i| unsafe {
                let name = sqlite3_column_name(stmt, i);
                if name.is_null() {
                    String::new()
                } else {
                    CStr::from_ptr(name).to_string_lossy().into_owned()
                }
            })
            .collect();
        let result = loop {
            match unsafe { sqlite3_step(stmt) } {
                SQLITE_ROW => {
                    if !each(&Row {
                        stmt,
                        names: &names,
                    }) {
                        break Ok(());
                    }
                }
                SQLITE_DONE => break Ok(()),
                _ => {
                    break Err(unsafe {
                        CStr::from_ptr(sqlite3_errmsg(self.db))
                            .to_string_lossy()
                            .into_owned()
                    });
                }
            }
        };
        unsafe { sqlite3_finalize(stmt) };
        result
    }
}

impl Drop for Snapshot {
    fn drop(&mut self) {
        unsafe { sqlite3_close(self.db) };
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import_readers::fixture;

    #[test]
    fn a_snapshot_reads_a_copy_and_leaves_the_source_alone() {
        let source = fixture("home/Library/Safari/History.db");
        let before = std::fs::read(&source).unwrap();
        let db = Snapshot::copying(&source).unwrap();
        assert!(db.table_exists("history_items"));
        assert!(!db.table_exists("nope"));
        let mut rows = 0;
        db.query("SELECT url FROM history_items", |row| {
            rows += 1;
            row.text("url").is_some()
        })
        .unwrap();
        assert!(rows > 0);
        drop(db);
        assert_eq!(std::fs::read(&source).unwrap(), before);
        assert!(Snapshot::copying(&fixture("nope.db")).is_err());
    }
}
