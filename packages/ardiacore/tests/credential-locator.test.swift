import Darwin
import Foundation
import Testing

enum VaultSandbox {
  static var directory: String? { nil }
}

struct LocatorScratch {
  let root: String

  init() throws {
    let made = (NSTemporaryDirectory() as NSString).appendingPathComponent("ardia-locator-\(UUID().uuidString)")
    try FileManager.default.createDirectory(atPath: made, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
    root = try #require(VaultBinaryLocator.realPath(made))
  }

  func folder(_ name: String, mode: Int = 0o755) throws -> String {
    let path = (root as NSString).appendingPathComponent(name)
    try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    chmod(path, mode_t(mode))
    return path
  }

  @discardableResult
  func program(_ name: String, in folder: String, text: String = "#!/bin/sh\necho ok\n") throws -> String {
    let path = (folder as NSString).appendingPathComponent(name)
    try Data(text.utf8).write(to: URL(fileURLWithPath: path))
    chmod(path, 0o755)
    return path
  }

  func link(_ name: String, in folder: String, to target: String) throws {
    try FileManager.default.createSymbolicLink(atPath: (folder as NSString).appendingPathComponent(name), withDestinationPath: target)
  }
}

@Suite("Finding a password manager's program")
struct CredentialLocatorTests {
  @Test func `a trusted program on the search path is found by its real path`() throws {
    let scratch = try LocatorScratch()
    let bin = try scratch.folder("bin")
    let real = try scratch.program("op", in: bin)
    let found = try #require(VaultBinaryLocator.program("op", in: [bin], roots: []))
    #expect(found.executable == real)
    #expect(found.leadingArguments.isEmpty)
  }

  @Test func `a link into Ardia's Programs store or a plugin folder is refused`() throws {
    let scratch = try LocatorScratch()
    let bin = try scratch.folder("bin")
    let store = try scratch.folder("Programs/fake")
    let planted = try scratch.program("bw", in: store)
    try scratch.link("bw", in: bin, to: planted)
    #expect(VaultBinaryLocator.program("bw", in: [bin], roots: []) != nil)
    #expect(VaultBinaryLocator.program("bw", in: [bin], roots: [(scratch.root as NSString).appendingPathComponent("Programs")]) == nil)
  }

  @Test func `a program in a folder others can write is refused`() throws {
    let scratch = try LocatorScratch()
    let open = try scratch.folder("open", mode: 0o777)
    try scratch.program("pass-cli", in: open)
    #expect(VaultBinaryLocator.program("pass-cli", in: [open], roots: []) == nil)
  }

  @Test func `a node script runs as a trusted node with the script, both checked`() throws {
    let scratch = try LocatorScratch()
    let bin = try scratch.folder("bin")
    let lib = try scratch.folder("lib")
    let node = try scratch.program("node", in: bin, text: "\u{7F}ELF not really")
    let script = try scratch.program("bw.js", in: lib, text: "#!/usr/bin/env node\nconsole.log(1)\n")
    try scratch.link("bw", in: bin, to: script)
    let found = try #require(VaultBinaryLocator.program("bw", in: [bin], roots: []))
    #expect(found.executable == node)
    #expect(found.leadingArguments == [script])
    #expect(found.path == script)
  }

  @Test func `a node script with no trusted node isn't run at all`() throws {
    let scratch = try LocatorScratch()
    let bin = try scratch.folder("bin")
    try scratch.program("bw", in: bin, text: "#!/usr/bin/env node\nconsole.log(1)\n")
    #expect(VaultBinaryLocator.program("bw", in: [bin], roots: []) == nil)
    let open = try scratch.folder("open", mode: 0o777)
    try scratch.program("node", in: open, text: "not a script")
    #expect(VaultBinaryLocator.program("bw", in: [bin, open], roots: []) == nil)
  }

  @Test("A name that isn't a bare program name is never looked up", arguments: ["", "../bw", "/usr/bin/bw", ".hidden"])
  func badNames(_ name: String) throws {
    let scratch = try LocatorScratch()
    #expect(VaultBinaryLocator.program(name, in: [try scratch.folder("bin")], roots: []) == nil)
  }
}
