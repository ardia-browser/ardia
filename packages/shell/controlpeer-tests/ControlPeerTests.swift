import ArdiaControlPeerCore
import Darwin
import Foundation
import XCTest

final class ControlPeerTests: XCTestCase {
  private var scratch: URL!
  private var held: [Int32] = []

  override func setUpWithError() throws {
    scratch = URL(fileURLWithPath: "/private/tmp").appendingPathComponent("acp-\(getpid())-\(UInt32.random(in: 0...UInt32.max))")
    try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  }

  override func tearDownWithError() throws {
    held.forEach { close($0) }
    held = []
    try? FileManager.default.removeItem(at: scratch)
  }

  func testSocketPairPeerIsThisProcess() throws {
    var fds: [Int32] = [0, 0]
    XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds), 0)
    defer { close(fds[0]); close(fds[1]) }
    let token = try XCTUnwrap(ControlPeer.auditToken(of: fds[0]))
    XCTAssertEqual(ControlPeer.pid(of: token), getpid())
    let peer = ControlPeer.resolve(token)
    let me = ControlPeer.resolveSelf()
    XCTAssertEqual(peer.path, me.path)
    XCTAssertEqual(peer.cdhash, me.cdhash)
    XCTAssertEqual(peer.signer, me.signer)
    XCTAssertNotNil(peer.cdhash)
  }

  func testApplePlatformPeer() throws {
    let (child, peer, _) = try connect(executable: "/usr/bin/nc")
    defer { reap(child) }
    XCTAssertEqual(peer.signer, .apple)
    XCTAssertEqual(peer.identifier, "com.apple.nc")
    XCTAssertEqual(peer.path, "/usr/bin/nc")
    XCTAssertEqual(peer.pid, child)
    XCTAssertEqual(peer.approvalKey, "apple:com.apple.nc")
    XCTAssertEqual(peer.name, "nc")
  }

  func testAdHocPeerIsKeyedByPathAndCodeHash() throws {
    let copy = scratch.appendingPathComponent("nc-copy").path
    XCTAssertNoThrow(try FileManager.default.copyItem(atPath: "/usr/bin/nc", toPath: copy))
    XCTAssertEqual(run("/usr/bin/codesign", ["--force", "--sign", "-", copy]), 0)
    let (child, peer, _) = try connect(executable: copy)
    defer { reap(child) }
    XCTAssertEqual(peer.signer, .other)
    XCTAssertEqual(peer.path, copy)
    let cdhash = try XCTUnwrap(peer.cdhash)
    XCTAssertEqual(peer.approvalKey, "code:\(cdhash):\(copy)")
    XCTAssertEqual(peer.signedBy, "Not signed by an identified developer")
  }

  func testTokenOfAGonePeerResolvesToNothing() throws {
    let (child, _, token) = try connect(executable: "/usr/bin/nc")
    kill(child, SIGKILL)
    reap(child)
    let later = ControlPeer.resolve(token)
    XCTAssertNil(later.path)
    XCTAssertNil(later.approvalKey)
    XCTAssertEqual(later.signer, .other)
  }

  func testPolicy() {
    let now = Date(timeIntervalSince1970: 1_000_000)
    let ours = ControlPeer(pid: 1, path: "/a/ardia", identifier: "ardia", signer: .team("U5L5T3NGVV"), developer: "Ardia", cdhash: "aa", hardened: true)
    let oursSoft = ControlPeer(pid: 1, path: "/a/ardia", identifier: "ardia", signer: .team("U5L5T3NGVV"), developer: "Ardia", cdhash: "aa", hardened: false)
    let other = ControlPeer(pid: 2, path: "/b/tool", identifier: "com.x.tool", signer: .team("XXXXXXXXXX"), developer: "X", cdhash: "bb", hardened: true)
    let unsigned = ControlPeer(pid: 3, path: "/c/tool", identifier: nil, signer: .other, developer: nil, cdhash: nil, hardened: false)
    let policy = ControlPeerPolicy(ownTeam: "U5L5T3NGVV", sameUserIsEnough: false)
    XCTAssertEqual(policy.verdict(ours, approvals: [], now: now), .ardia)
    XCTAssertEqual(policy.verdict(oursSoft, approvals: [], now: now), .ask("team:U5L5T3NGVV:ardia"))
    XCTAssertEqual(policy.verdict(other, approvals: [], now: now), .ask("team:XXXXXXXXXX:com.x.tool"))
    XCTAssertEqual(policy.verdict(unsigned, approvals: [], now: now), .ask(nil))
    let halfHour = ControlPeerDecision.halfHour.approval(for: other, key: other.approvalKey!, now: now)!
    XCTAssertEqual(policy.verdict(other, approvals: [halfHour], now: now.addingTimeInterval(60)), .approved("team:XXXXXXXXXX:com.x.tool"))
    XCTAssertEqual(policy.verdict(other, approvals: [halfHour], now: now.addingTimeInterval(1800)), .ask("team:XXXXXXXXXX:com.x.tool"))
    XCTAssertNil(ControlPeerDecision.once.approval(for: other, key: "k", now: now))
    XCTAssertNil(ControlPeerDecision.deny.approval(for: other, key: "k", now: now))
    XCTAssertEqual(ControlPeerPolicy(ownTeam: nil, sameUserIsEnough: false).verdict(ours, approvals: [], now: now), .ask("team:U5L5T3NGVV:ardia"))
    XCTAssertEqual(ControlPeerPolicy(ownTeam: "U5L5T3NGVV", sameUserIsEnough: true).verdict(unsigned, approvals: [], now: now), .sameUser)
  }

  func testAFolderWithAnInheritableAccessListIsRefused() throws {
    let folder = scratch.appendingPathComponent("shared").path
    try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    XCTAssertNil(PrivateFolder.openFolder(folder).problem)
    XCTAssertEqual(run("/bin/chmod", ["+a", "everyone allow read,file_inherit", folder]), 0)
    let refused = try XCTUnwrap(PrivateFolder.openFolder(folder).problem)
    XCTAssertTrue(refused.contains("access list"), refused)
    let store = ControlApprovals(directory: folder)
    let approval = ControlApproval(key: "apple:com.apple.nc", name: "nc", signedBy: "Apple", path: nil, added: 1, until: nil)
    XCTAssertFalse(store.add(approval))
    XCTAssertFalse(FileManager.default.fileExists(atPath: store.path))
    XCTAssertEqual(store.load(), [])
    XCTAssertNotNil(store.problem)
  }

  func testAnOwnerOnlyAccessListIsFine() throws {
    let folder = scratch.appendingPathComponent("mine").path
    try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    XCTAssertEqual(run("/bin/chmod", ["+a", "\(NSUserName()) allow read", folder]), 0)
    XCTAssertNil(PrivateFolder.openFolder(folder).problem)
    XCTAssertEqual(run("/bin/chmod", ["+a", "everyone deny delete", folder]), 0)
    XCTAssertNil(PrivateFolder.openFolder(folder).problem)
  }

  func testTheApprovalsFileHasNoAccessListAndAnAddedOneIsIgnored() throws {
    let store = ControlApprovals(directory: scratch.path)
    let approval = ControlApproval(key: "apple:com.apple.nc", name: "nc", signedBy: "Apple", path: nil, added: 1, until: nil)
    XCTAssertTrue(store.add(approval))
    let fd = open(store.path, O_RDONLY)
    XCTAssertGreaterThanOrEqual(fd, 0)
    XCTAssertEqual(PrivateFolder.extendedAccess(fd), .none)
    close(fd)
    XCTAssertEqual(store.load().map(\.key), [approval.key])
    XCTAssertEqual(run("/bin/chmod", ["+a", "everyone allow read", store.path]), 0)
    XCTAssertEqual(store.load(), [])
    XCTAssertNotNil(store.problem)
  }

  func testOnlyOwnerCanReadStripsAnInheritedAccessList() throws {
    let folder = scratch.appendingPathComponent("inherits").path
    try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    XCTAssertEqual(run("/bin/chmod", ["+a", "everyone allow read,file_inherit", folder]), 0)
    let fd = open((folder as NSString).appendingPathComponent("secret"), O_RDWR | O_CREAT | O_EXCL, 0o600)
    XCTAssertGreaterThanOrEqual(fd, 0)
    defer { close(fd) }
    XCTAssertEqual(PrivateFolder.extendedAccess(fd), .allowsOthers)
    XCTAssertTrue(PrivateFolder.onlyOwnerCanRead(fd))
    XCTAssertEqual(PrivateFolder.extendedAccess(fd), .none)
  }

  func testAncestorsMustNotBeReplaceableBySomeoneElse() throws {
    let parent = scratch.appendingPathComponent("parent").path
    let child = (parent as NSString).appendingPathComponent("data")
    try FileManager.default.createDirectory(atPath: child, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    var folder = PrivateFolder.openFolder(child)
    XCTAssertNil(folder.problem)
    XCTAssertNil(PrivateFolder.ancestorProblem(folder.fd))
    close(folder.fd)
    XCTAssertEqual(run("/bin/chmod", ["+a", "everyone allow read,list", parent]), 0)
    folder = PrivateFolder.openFolder(child)
    XCTAssertNil(PrivateFolder.ancestorProblem(folder.fd))
    close(folder.fd)
    XCTAssertEqual(run("/bin/chmod", ["+a", "everyone allow delete_child,add_subdirectory", parent]), 0)
    folder = PrivateFolder.openFolder(child)
    let aclProblem = try XCTUnwrap(PrivateFolder.ancestorProblem(folder.fd))
    XCTAssertTrue(aclProblem.contains("access list"), aclProblem)
    close(folder.fd)
    XCTAssertEqual(run("/bin/chmod", ["-N", parent]), 0)
    XCTAssertEqual(chmod(parent, 0o777), 0)
    folder = PrivateFolder.openFolder(child)
    let writable = try XCTUnwrap(PrivateFolder.ancestorProblem(folder.fd))
    XCTAssertTrue(writable.contains("Others can write"), writable)
    close(folder.fd)
    XCTAssertEqual(chmod(parent, 0o1777), 0)
    folder = PrivateFolder.openFolder(child)
    XCTAssertNil(PrivateFolder.ancestorProblem(folder.fd))
    close(folder.fd)
    XCTAssertEqual(chmod(parent, 0o700), 0)
  }

  func testDisplayTextIsPlainAndBounded() {
    XCTAssertEqual(ControlPeer.plain("ar\u{202E}dia\n\u{0007}x", limit: 64), "ardiax")
    XCTAssertEqual(ControlPeer.plain(String(repeating: "a", count: 100), limit: 10).count, 10)
    let spoof = ControlPeer(pid: 1, path: "/tmp/\u{202E}ardia", identifier: nil, signer: .other, developer: nil, cdhash: nil, hardened: false)
    XCTAssertEqual(spoof.name, "ardia")
  }

  func testDeveloperName() {
    XCTAssertEqual(ControlPeer.developerName("Developer ID Application: mantra patel (U5L5T3NGVV)"), "mantra patel")
    XCTAssertEqual(ControlPeer.developerName("Apple Development: A (B) (TEAM123456)"), "A (B)")
    XCTAssertEqual(ControlPeer.developerName("Plain"), "Plain")
  }

  func testApprovalsStoreIsPrivateAndRevocable() throws {
    let store = ControlApprovals(directory: scratch.path)
    let now = Date(timeIntervalSince1970: 2_000_000)
    XCTAssertEqual(store.load(now: now), [])
    let a = ControlApproval(key: "apple:com.apple.nc", name: "nc", signedBy: "Apple", path: "/usr/bin/nc", added: now.timeIntervalSince1970, until: nil)
    let b = ControlApproval(key: "code:aa:/x", name: "x", signedBy: "none", path: "/x", added: now.timeIntervalSince1970, until: now.timeIntervalSince1970 + 10)
    XCTAssertTrue(store.add(a, now: now))
    XCTAssertTrue(store.add(b, now: now))
    var info = stat()
    XCTAssertEqual(lstat(store.path, &info), 0)
    XCTAssertEqual(info.st_mode & 0o777, 0o600)
    XCTAssertEqual(store.load(now: now).map(\.key), [a.key, b.key])
    XCTAssertEqual(store.load(now: now.addingTimeInterval(11)).map(\.key), [a.key])
    XCTAssertTrue(store.revoke(a.key, now: now))
    XCTAssertFalse(store.revoke(a.key, now: now))
    XCTAssertEqual(store.load(now: now).map(\.key), [b.key])
    chmod(store.path, 0o644)
    XCTAssertEqual(store.load(now: now), [])
    XCTAssertNotNil(store.problem)
    unlink(store.path)
    let elsewhere = scratch.appendingPathComponent("elsewhere.json").path
    XCTAssertTrue(FileManager.default.createFile(atPath: elsewhere, contents: Data("[]".utf8), attributes: [.posixPermissions: 0o600]))
    XCTAssertEqual(symlink(elsewhere, store.path), 0)
    XCTAssertEqual(store.load(now: now), [])
    XCTAssertNotNil(store.problem)
    XCTAssertTrue(store.add(a, now: now))
    XCTAssertFalse(lstatIsLink(store.path))
    XCTAssertEqual(try String(contentsOfFile: elsewhere, encoding: .utf8), "[]")
    XCTAssertEqual(store.load(now: now).map(\.key), [a.key])
  }

  private func lstatIsLink(_ path: String) -> Bool {
    var info = stat()
    return lstat(path, &info) == 0 && (info.st_mode & S_IFMT) == S_IFLNK
  }

  private func connect(executable: String) throws -> (pid_t, ControlPeer, audit_token_t) {
    let path = scratch.appendingPathComponent("s").path
    unlink(path)
    let listener = socket(AF_UNIX, SOCK_STREAM, 0)
    defer { close(listener) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
      let bytes = Array(path.utf8)
      raw.copyBytes(from: bytes)
      raw[bytes.count] = 0
    }
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
    XCTAssertEqual(bound, 0)
    XCTAssertEqual(Darwin.listen(listener, 1), 0)
    let child = try spawn(executable, ["-U", path])
    let fd = accept(listener, nil, nil)
    XCTAssertGreaterThanOrEqual(fd, 0)
    defer { close(fd) }
    let token = try XCTUnwrap(ControlPeer.auditToken(of: fd))
    return (child, ControlPeer.resolve(token), token)
  }

  private func spawn(_ executable: String, _ arguments: [String]) throws -> pid_t {
    var pid: pid_t = 0
    var actions: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&actions)
    var input: [Int32] = [0, 0]
    guard pipe(&input) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    held.append(input[1])
    defer { close(input[0]) }
    posix_spawn_file_actions_adddup2(&actions, input[0], 0)
    posix_spawn_file_actions_addclose(&actions, input[1])
    posix_spawn_file_actions_addopen(&actions, 1, "/dev/null", O_WRONLY, 0)
    defer { posix_spawn_file_actions_destroy(&actions) }
    let argv = ([executable] + arguments).map { strdup($0) } + [nil]
    defer { argv.forEach { free($0) } }
    let result = posix_spawn(&pid, executable, &actions, nil, argv, environ)
    guard result == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(result)) }
    return pid
  }

  private func reap(_ pid: pid_t) {
    kill(pid, SIGKILL)
    var status: Int32 = 0
    waitpid(pid, &status, 0)
  }

  private func run(_ executable: String, _ arguments: [String]) -> Int32 {
    guard let pid = try? spawn(executable, arguments) else { return -1 }
    var status: Int32 = 0
    waitpid(pid, &status, 0)
    return status
  }
}
