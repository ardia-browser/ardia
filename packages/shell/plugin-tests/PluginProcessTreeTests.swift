import XCTest

@testable import ArdiaPluginCore

final class PluginProcessTreeTests: XCTestCase {
  var root = ""

  override func setUpWithError() throws {
    let made = FileManager.default.temporaryDirectory.appendingPathComponent("plugin-tree-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
    root = made.path
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(atPath: root)
  }

  static let helper = """
    import os, subprocess, sys, time
    os.setpgid(0, 0)
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True)
    open(sys.argv[1], "w").write(str(child.pid))
    time.sleep(60)
    """

  func alive(_ pid: pid_t) -> Bool { kill(pid, 0) == 0 }

  func startHelper() throws -> (helper: Process, child: pid_t) {
    let marker = "\(root)/child.pid"
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
    process.arguments = ["-c", Self.helper, marker]
    try process.run()
    let deadline = Date().addingTimeInterval(10)
    while Date() < deadline {
      if let text = try? String(contentsOfFile: marker, encoding: .utf8), let pid = pid_t(text) { return (process, pid) }
      usleep(50_000)
    }
    throw XCTSkip("the helper didn't start")
  }

  func waitGone(_ pid: pid_t) -> Bool {
    let deadline = Date().addingTimeInterval(3)
    while Date() < deadline {
      if !alive(pid) { return true }
      usleep(20_000)
    }
    return false
  }

  func testAMemberWhosePidNowNamesAnotherProcessBringsInNoneOfItsChildren() throws {
    let (helper, child) = try startHelper()
    defer {
      kill(child, SIGKILL)
      helper.terminate()
    }
    let now = try XCTUnwrap(PluginProcessTree.entry(helper.processIdentifier))
    let reused = PluginProcessMember(pid: now.pid, started: now.started &+ 1)
    XCTAssertFalse(PluginProcessTree.withDescendants([reused]).contains { $0.pid == child }, "the pid's current owner isn't the member, so its child isn't ours")
    let same = PluginProcessMember(pid: now.pid, started: now.started)
    XCTAssertTrue(PluginProcessTree.withDescendants([same]).contains { $0.pid == child }, "a member that still matches brings in its child")
  }

  func testStoppingAHelperEndsAChildThatLeftItsProcessGroup() throws {
    let (helper, child) = try startHelper()
    defer { kill(child, SIGKILL) }
    let family = PluginProcessTree.family(of: helper.processIdentifier)
    PluginProcessTree.signal(family, SIGKILL)
    helper.waitUntilExit()
    XCTAssertTrue(waitGone(child), "the child in its own session is stopped with the helper")
  }

  func testAFamilyRememberedBeforeTheHelperExitedIsStillEnded() throws {
    let (helper, child) = try startHelper()
    defer { kill(child, SIGKILL) }
    let family = PluginProcessTree.family(of: helper.processIdentifier)
    kill(helper.processIdentifier, SIGKILL)
    helper.waitUntilExit()
    XCTAssertTrue(alive(child), "orphaned onto launchd")
    PluginProcessTree.signal(family, SIGKILL)
    XCTAssertTrue(waitGone(child))
  }

  func testWithoutTheResponsibilityCallsTheGroupAndDescendantsAreStillFound() throws {
    let (helper, child) = try startHelper()
    defer {
      kill(child, SIGKILL)
      helper.terminate()
    }
    let pids = Set(PluginProcessTree.family(of: helper.processIdentifier, byResponsibility: false).map(\.pid))
    XCTAssertTrue(pids.contains(child), "a setsid child is still the helper's descendant")
    XCTAssertTrue(pids.contains(helper.processIdentifier))
  }

  func testTheFamilyNeverTakesInThisProcessOrLaunchd() throws {
    let (helper, child) = try startHelper()
    defer {
      kill(child, SIGKILL)
      helper.terminate()
    }
    let pids = Set(PluginProcessTree.family(of: helper.processIdentifier).map(\.pid))
    XCTAssertTrue(pids.contains(child))
    XCTAssertFalse(pids.contains(getpid()))
    XCTAssertFalse(pids.contains(1))
  }
}

struct SpawnFailed: Error {
  let status: Int32
}

final class PluginResponsibilityTests: XCTestCase {
  static let cli = """
    import os, subprocess, sys, time
    os.setsid()
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    open(sys.argv[1], "w").write(f"{os.getpid()} {child.pid}")
    time.sleep(60)
    """

  func testAHelpersCliAndItsChildAreFoundAfterTheCliParentExited() throws {
    guard PluginProcessTree.tracksResponsibility else { throw XCTSkip("this macOS has no responsibility calls") }
    let marker = FileManager.default.temporaryDirectory.appendingPathComponent("tree-\(UUID().uuidString)").path
    let script = "/usr/bin/python3 -c '\(Self.cli.replacingOccurrences(of: "'", with: "'\\''"))' \"$1\" & exit 0"
    let helperScript = "/bin/sh -c \"$1\" cli \"$2\"; sleep 60"
    var attributes: posix_spawnattr_t?
    posix_spawnattr_init(&attributes)
    defer { posix_spawnattr_destroy(&attributes) }
    posix_spawnattr_setpgroup(&attributes, 0)
    posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP))
    XCTAssertTrue(PluginProcessTree.disclaim(&attributes))
    var helper: pid_t = 0
    let argv = ["/bin/sh", "-c", helperScript, "helper", script, marker].map { strdup($0) } + [nil]
    defer { argv.forEach { free($0) } }
    let spawned = posix_spawn(&helper, "/bin/sh", nil, &attributes, argv, environ)
    guard spawned == 0, helper > 0 else { throw SpawnFailed(status: spawned) }
    defer {
      kill(helper, SIGKILL)
      waitpid(helper, nil, 0)
    }
    var pids: [pid_t] = []
    let deadline = Date().addingTimeInterval(10)
    while pids.count < 2 && Date() < deadline {
      pids = ((try? String(contentsOfFile: marker, encoding: .utf8)) ?? "").split(separator: " ").compactMap { pid_t($0) }
      usleep(50_000)
    }
    defer { pids.forEach { kill($0, SIGKILL) } }
    guard pids.count == 2 else { return XCTFail("the CLI and its child didn't both start: \(pids)") }
    XCTAssertEqual(PluginProcessTree.entry(pids[0])?.ppid, 1, "the CLI's parent shell has exited")
    let family = PluginProcessTree.family(of: helper)
    XCTAssertTrue(pids.allSatisfy { pid in family.contains { $0.pid == pid } }, "the orphaned CLI and its child are the helper's")
    PluginProcessTree.signal(family, SIGKILL)
    for pid in pids {
      let gone = Date().addingTimeInterval(3)
      while kill(pid, 0) == 0 && Date() < gone { usleep(20_000) }
      XCTAssertNotEqual(kill(pid, 0), 0)
    }
  }
}

final class PluginFamilyTests: XCTestCase {
  func spawnDisclaimed(_ script: String, _ argument: String) throws -> pid_t {
    var attributes: posix_spawnattr_t?
    posix_spawnattr_init(&attributes)
    defer { posix_spawnattr_destroy(&attributes) }
    posix_spawnattr_setpgroup(&attributes, 0)
    posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP))
    _ = PluginProcessTree.disclaim(&attributes)
    var pid: pid_t = 0
    let argv = ["/usr/bin/python3", "-c", script, argument].map { strdup($0) } + [nil]
    defer { argv.forEach { free($0) } }
    let spawned = posix_spawn(&pid, "/usr/bin/python3", nil, &attributes, argv, environ)
    guard spawned == 0, pid > 0 else { throw SpawnFailed(status: spawned) }
    return pid
  }

  func readPids(_ path: String, count: Int) -> [pid_t] {
    let deadline = Date().addingTimeInterval(10)
    var pids: [pid_t] = []
    while pids.count < count && Date() < deadline {
      pids = ((try? String(contentsOfFile: path, encoding: .utf8)) ?? "").split(separator: " ").compactMap { pid_t($0) }
      usleep(20_000)
    }
    return pids
  }

  func testAChildDetachedJustBeforeTheHelperExitsIsStillEnded() throws {
    let marker = FileManager.default.temporaryDirectory.appendingPathComponent("family-\(UUID().uuidString)").path
    let script = "import subprocess, sys, time\nchild = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], start_new_session=True)\nopen(sys.argv[1], 'w').write(str(child.pid))\ntime.sleep(0.1)"
    let queue = DispatchQueue(label: "family-test")
    let helper = try spawnDisclaimed(script, marker)
    let family = PluginFamily(root: helper, queue: queue, interval: 60)
    queue.sync { family.start() }
    waitpid(helper, nil, 0)
    let child = try XCTUnwrap(readPids(marker, count: 1).first)
    defer { kill(child, SIGKILL) }
    XCTAssertEqual(PluginProcessTree.entry(child)?.ppid, 1, "orphaned when the helper exited, well before the next timed sample")
    queue.sync {
      family.signal(SIGKILL, group: false)
      family.cancel()
    }
    let gone = Date().addingTimeInterval(3)
    while kill(child, 0) == 0 && Date() < gone { usleep(20_000) }
    XCTAssertNotEqual(kill(child, 0), 0, "the fork was noticed and sampled while the helper still ran")
  }

  func testDescendantsASampledChildStartsLaterAreEndedToo() throws {
    let marker = FileManager.default.temporaryDirectory.appendingPathComponent("family-\(UUID().uuidString)").path
    let script = "import os, subprocess, sys, time\nchild = subprocess.Popen([sys.executable, '-c', 'import subprocess, sys, time\\ntime.sleep(0.5)\\ng = subprocess.Popen([sys.executable, \"-c\", \"import time; time.sleep(60)\"])\\nopen(sys.argv[1], \"a\").write(\" \" + str(g.pid))\\ntime.sleep(60)', sys.argv[1]], start_new_session=True)\nopen(sys.argv[1], 'w').write(str(child.pid))\ntime.sleep(0.1)"
    let queue = DispatchQueue(label: "family-test")
    let helper = try spawnDisclaimed(script, marker)
    let family = PluginFamily(root: helper, queue: queue, interval: 60)
    queue.sync { family.start() }
    waitpid(helper, nil, 0)
    let pids = readPids(marker, count: 2)
    XCTAssertEqual(pids.count, 2, "the child and the grandchild it started after the helper was gone")
    defer { pids.forEach { kill($0, SIGKILL) } }
    queue.sync {
      family.signal(SIGKILL, group: false)
      family.cancel()
    }
    for pid in pids {
      let gone = Date().addingTimeInterval(3)
      while kill(pid, 0) == 0 && Date() < gone { usleep(20_000) }
      XCTAssertNotEqual(kill(pid, 0), 0)
    }
  }

  func testOnlyOurOwnChildIsEverTreatedAsOwned() throws {
    XCTAssertNil(PluginProcessTree.ownership(1), "launchd isn't ours: no group signal")
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/sleep")
    process.arguments = ["30"]
    try process.run()
    defer { process.terminate() }
    XCTAssertEqual(PluginProcessTree.ownership(process.processIdentifier), false, "a running child of ours")
  }
}
