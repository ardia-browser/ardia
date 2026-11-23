import Darwin
import Foundation
import os

enum VaultBinaryLocator {
  static let scriptPeekBytes = 256
  private static let refused = OSAllocatedUnfairLock(initialState: [String]())

  static func directories() -> [String] {
    if let data = VaultSandbox.directory {
      return [URL(fileURLWithPath: data, isDirectory: true).appendingPathComponent("Password Managers/bin", isDirectory: true).path]
    }
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    return ["/opt/homebrew/bin", "/usr/local/bin", "\(home)/.local/bin", "\(home)/.npm-global/bin", "/opt/local/bin", "\(home)/bin"]
  }

  static func refuse(roots: [String]) {
    let resolved = roots.compactMap { root in realPath(root) ?? (root.hasPrefix("/") ? root : nil) }
    refused.withLock { $0 = resolved }
  }

  static var refusedRoots: [String] { refused.withLock { $0 } }

  static func isInsideRefusedRoot(_ resolved: String, roots: [String] = refusedRoots) -> Bool {
    roots.contains { root in
      let trimmed = root.hasSuffix("/") ? String(root.dropLast()) : root
      return resolved == trimmed || resolved.hasPrefix(trimmed + "/")
    }
  }

  static func locate(_ name: String, in places: [String]? = nil, roots: [String] = refusedRoots) -> String? {
    guard !name.isEmpty, !name.contains("/"), !name.hasPrefix(".") else { return nil }
    for directory in places ?? directories() {
      let path = (directory as NSString).appendingPathComponent(name)
      if isTrusted(path), let resolved = realPath(path), !isInsideRefusedRoot(resolved, roots: roots) { return resolved }
    }
    return nil
  }

  static func program(_ name: String, in places: [String]? = nil, roots: [String] = refusedRoots) -> CredentialProgram? {
    guard let resolved = locate(name, in: places, roots: roots) else { return nil }
    guard let interpreter = scriptInterpreter(resolved) else {
      return CredentialProgram(executable: resolved, leadingArguments: [], path: resolved)
    }
    guard interpreter == "node" else { return CredentialProgram(executable: resolved, leadingArguments: [], path: resolved) }
    guard name != "node", let node = locate("node", in: places, roots: roots), scriptInterpreter(node) == nil else { return nil }
    return CredentialProgram(executable: node, leadingArguments: [resolved], path: resolved)
  }

  static func scriptInterpreter(_ path: String) -> String? {
    guard let handle = FileHandle(forReadingAtPath: path) else { return nil }
    defer { try? handle.close() }
    let head = (try? handle.read(upToCount: scriptPeekBytes)) ?? Data()
    guard head.starts(with: Data("#!".utf8)) else { return nil }
    let line = String(decoding: head.dropFirst(2).prefix { $0 != 10 }, as: UTF8.self).trimmingCharacters(in: .whitespaces)
    let words = line.split(separator: " ").map(String.init)
    guard let first = words.first else { return nil }
    let program = (first as NSString).lastPathComponent
    if program == "env" {
      return words.dropFirst().first { !$0.hasPrefix("-") }.map { ($0 as NSString).lastPathComponent }
    }
    return program
  }

  static func isTrusted(_ path: String) -> Bool {
    let manager = FileManager.default
    guard path.hasPrefix("/"), manager.fileExists(atPath: path) else { return false }
    guard let resolved = realPath(path), let linkDirectory = realPath((path as NSString).deletingLastPathComponent),
      isOwnedSafely(path), directoriesAreSafe(linkDirectory), isOwnedSafely(resolved),
      directoriesAreSafe((resolved as NSString).deletingLastPathComponent), manager.isExecutableFile(atPath: resolved),
      let attributes = try? manager.attributesOfItem(atPath: resolved)
    else { return false }
    return (attributes[.type] as? FileAttributeType) == .typeRegular
  }

  static func isTrustedDirectory(_ directory: String) -> Bool {
    guard directory.hasPrefix("/"), let resolved = realPath(directory) else { return false }
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: resolved, isDirectory: &isDirectory), isDirectory.boolValue else { return false }
    return isOwnedSafely(resolved) && directoriesAreSafe((resolved as NSString).deletingLastPathComponent) && !isInsideRefusedRoot(resolved)
  }

  static func realPath(_ path: String) -> String? {
    guard let pointer = realpath(path, nil) else { return nil }
    defer { free(pointer) }
    let resolved = String(cString: pointer)
    return resolved.hasPrefix("/") ? resolved : nil
  }

  private static func directoriesAreSafe(_ directory: String) -> Bool {
    var current = directory
    while true {
      guard current.hasPrefix("/"), isOwnedSafely(current, stickyAllowed: true) else { return false }
      if current == "/" { return true }
      current = (current as NSString).deletingLastPathComponent
    }
  }

  private static func isOwnedSafely(_ path: String, stickyAllowed: Bool = false) -> Bool {
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: path) else { return false }
    guard let owner = (attributes[.ownerAccountID] as? NSNumber)?.uint32Value, owner == 0 || owner == getuid() else { return false }
    let type = attributes[.type] as? FileAttributeType
    if type == .typeSymbolicLink { return true }
    guard let permissions = (attributes[.posixPermissions] as? NSNumber)?.intValue else { return false }
    if permissions & 0o002 == 0 { return true }
    return stickyAllowed && type == .typeDirectory && permissions & 0o1000 != 0
  }
}
