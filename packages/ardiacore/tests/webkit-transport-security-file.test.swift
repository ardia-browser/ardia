import Foundation
import Testing

struct TransportSecurityFiles {
  let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ardia-hsts-\(UUID().uuidString)")
  let entries = ["bank.example": WebKitTransportSecurity(expires: 1_900_000_000, subdomains: true, observed: 1_800_000_000)]
  static let permissionsApply = geteuid() != 0

  @Test func `a write creates its folder and reads back the same hosts`() throws {
    let file = folder.appendingPathComponent("nested").appendingPathComponent("p00.json")
    defer { try? FileManager.default.removeItem(at: folder) }
    #expect(WebKitCertificatePolicy.SavedList.write(entries, to: file) == nil)
    #expect(try WebKitCertificatePolicy.SavedList.read(file) == entries)
  }

  @Test func `writing nothing removes the file, and a missing file is not an error`() throws {
    let file = folder.appendingPathComponent("p00.json")
    defer { try? FileManager.default.removeItem(at: folder) }
    #expect(WebKitCertificatePolicy.SavedList.write(entries, to: file) == nil)
    #expect(WebKitCertificatePolicy.SavedList.write(nil, to: file) == nil)
    #expect(!FileManager.default.fileExists(atPath: file.path))
    #expect(WebKitCertificatePolicy.SavedList.write(nil, to: file) == nil)
    #expect(try WebKitCertificatePolicy.SavedList.read(file).isEmpty)
  }

  @Test func `a damaged file reads as empty so the next save can replace it`() throws {
    let file = folder.appendingPathComponent("p00.json")
    defer { try? FileManager.default.removeItem(at: folder) }
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    try Data("{not json".utf8).write(to: file)
    #expect(try WebKitCertificatePolicy.SavedList.read(file).isEmpty)
  }

  @Test(.enabled(if: permissionsApply)) func `a file that can't be read is an error, not an empty list`() throws {
    let file = folder.appendingPathComponent("p00.json")
    defer {
      try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
      try? FileManager.default.removeItem(at: folder)
    }
    #expect(WebKitCertificatePolicy.SavedList.write(entries, to: file) == nil)
    try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: file.path)
    #expect(throws: WebKitCertificatePolicy.SavedList.Unreadable.self) { try WebKitCertificatePolicy.SavedList.read(file) }
  }

  @Test(.enabled(if: permissionsApply)) func `removing a file in a folder that can't be searched reports the failure`() throws {
    let file = folder.appendingPathComponent("p00.json")
    defer {
      try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: folder.path)
      try? FileManager.default.removeItem(at: folder)
    }
    #expect(WebKitCertificatePolicy.SavedList.write(entries, to: file) == nil)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: folder.path)
    let error = WebKitCertificatePolicy.SavedList.write(nil, to: file)
    #expect(error?.hasPrefix("couldn't save the HSTS list") == true)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: folder.path)
    #expect(FileManager.default.fileExists(atPath: file.path))
  }

  @Test func `a write that can't reach the disk says so`() throws {
    defer { try? FileManager.default.removeItem(at: folder) }
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let blocker = folder.appendingPathComponent("blocker")
    try Data().write(to: blocker)
    let error = WebKitCertificatePolicy.SavedList.write(entries, to: blocker.appendingPathComponent("p00.json"))
    #expect(error?.hasPrefix("couldn't save the HSTS list") == true)
  }
}
