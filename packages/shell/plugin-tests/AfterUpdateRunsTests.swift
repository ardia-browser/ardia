import XCTest

@testable import ArdiaPluginCore

final class AfterUpdateRunsTests: XCTestCase {
  var root = ""

  override func setUpWithError() throws {
    let made = FileManager.default.temporaryDirectory.appendingPathComponent("after-update-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
    root = made.path
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(atPath: root)
  }

  private func fakeCommand(_ name: String, ignoresTerm: Bool, childIgnoresTerm: Bool = false) throws -> String {
    let path = (root as NSString).appendingPathComponent(name)
    let trap = ignoresTerm ? "trap '' TERM" : "trap 'exit 0' TERM"
    let child = childIgnoresTerm ? "/bin/sh -c 'trap \"\" TERM; while :; do sleep 0.05; echo child >> \"$0.writes\"; done' \"$1\" &" : "sleep 30 &"
    let script = """
      #!/bin/sh
      \(trap)
      \(child)
      echo $! > "$1.child"
      echo $$ > "$1.ready"
      while :; do sleep 0.05; echo tick >> "$1.writes"; done
      """
    try script.write(toFile: path, atomically: true, encoding: .utf8)
    chmod(path, 0o755)
    return path
  }

  private func start(_ runs: AfterUpdateRuns, ignoresTerm: Bool, childIgnoresTerm: Bool = false, tag: String) throws -> (group: pid_t, child: pid_t, marker: String) {
    let marker = (root as NSString).appendingPathComponent(tag)
    let program = try fakeCommand("\(tag).sh", ignoresTerm: ignoresTerm, childIgnoresTerm: childIgnoresTerm)
    guard case .started(let group) = runs.spawn(program, [marker], environment: ["PATH": "/usr/bin:/bin"]) else {
      XCTFail("the fake afterUpdate command didn't start")
      return (0, 0, marker)
    }
    let ready = Date().addingTimeInterval(5)
    while Date() < ready, !FileManager.default.fileExists(atPath: marker + ".writes") { usleep(10_000) }
    let child = pid_t((try? String(contentsOfFile: marker + ".child", encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") ?? 0
    XCTAssertGreaterThan(child, 0)
    return (group, child, marker)
  }

  private func gone(_ pid: pid_t, within seconds: TimeInterval = 2) -> Bool {
    let end = Date().addingTimeInterval(seconds)
    repeat {
      if kill(pid, 0) != 0 && errno == ESRCH { return true }
      usleep(20_000)
    } while Date() < end
    return false
  }

  private func writeCount(_ marker: String) -> Int {
    ((try? String(contentsOfFile: marker + ".writes", encoding: .utf8)) ?? "").split(separator: "\n").count
  }

  private func startScript(_ runs: AfterUpdateRuns, tag: String, _ body: String) throws -> (group: pid_t, child: pid_t, marker: String) {
    let marker = (root as NSString).appendingPathComponent(tag)
    let path = marker + ".sh"
    try "#!/bin/sh\n\(body)\n".write(toFile: path, atomically: true, encoding: .utf8)
    chmod(path, 0o755)
    guard case .started(let group) = runs.spawn(path, [marker], environment: ["PATH": "/usr/bin:/bin"]) else {
      XCTFail("the fake afterUpdate command didn't start")
      return (0, 0, marker)
    }
    let ready = Date().addingTimeInterval(5)
    while Date() < ready, !FileManager.default.fileExists(atPath: marker + ".child") { usleep(10_000) }
    usleep(50_000)
    let child = pid_t((try? String(contentsOfFile: marker + ".child", encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") ?? 0
    XCTAssertGreaterThan(child, 0)
    return (group, child, marker)
  }

  static let stubbornChild = "/bin/sh -c 'trap \"\" TERM; while :; do sleep 0.05; echo child >> \"$0.writes\"; done' \"$1\" &\necho $! > \"$1.child\""

  func testALeaderThatFinishesAfterQuitBeginsLeavesItsChildToTheStop() throws {
    let runs = AfterUpdateRuns()
    let run = try startScript(runs, tag: "finishing", "\(Self.stubbornChild)\nsleep 0.3\nexit 0")
    var code: Int32 = 0
    let waiter = DispatchGroup()
    DispatchQueue.global().async(group: waiter) { code = runs.wait(group: run.group, deadline: 300, grace: 3) }
    let epoch = runs.beginQuit()
    usleep(700_000)
    XCTAssertEqual(runs.running, [run.group], "the waiter doesn't reap a leader once quit has begun")
    let stops = runs.stopAll(epoch: epoch, grace: 0.3, reapLimit: 0.5)
    XCTAssertEqual(stops, AfterUpdateQuitStops(exitedOnTerm: 0, killed: 1))
    XCTAssertEqual(waiter.wait(timeout: .now() + 2), .success)
    XCTAssertEqual(code, AfterUpdateRuns.interrupted, "a run cut short by quit never marks the update done")
    XCTAssertTrue(gone(run.child))
  }

  func testACancelledQuitStillEndsTheChildBeforeTheRunCounts() throws {
    let runs = AfterUpdateRuns()
    let run = try startScript(runs, tag: "cancelled", "\(Self.stubbornChild)\nsleep 0.3\nexit 0")
    var code: Int32 = -9
    let waiter = DispatchGroup()
    DispatchQueue.global().async(group: waiter) { code = runs.wait(group: run.group, deadline: 300, grace: 0.3) }
    runs.beginQuit()
    usleep(700_000)
    XCTAssertEqual(runs.running, [run.group])
    runs.resume()
    XCTAssertEqual(waiter.wait(timeout: .now() + 3), .success)
    XCTAssertEqual(code, 0)
    XCTAssertTrue(gone(run.child, within: 0.5), "cancelling the quit doesn't let the child outlive its run")
    XCTAssertTrue(runs.running.isEmpty)
  }

  func testACommandStartedWhileTheAppBlocksTermStillHearsIt() throws {
    let runs = AfterUpdateRuns()
    let marker = (root as NSString).appendingPathComponent("blocked")
    let program = try fakeCommand("blocked.sh", ignoresTerm: false)
    var started: AfterUpdateSpawn = .failed
    let spawner = Thread {
      var blocked = sigset_t()
      sigemptyset(&blocked)
      sigaddset(&blocked, SIGTERM)
      pthread_sigmask(SIG_BLOCK, &blocked, nil)
      started = runs.spawn(program, [marker], environment: ["PATH": "/usr/bin:/bin"])
    }
    let done = DispatchSemaphore(value: 0)
    let watcher = Thread {
      spawner.start()
      while !spawner.isFinished { usleep(5_000) }
      done.signal()
    }
    watcher.start()
    XCTAssertEqual(done.wait(timeout: .now() + 5), .success)
    guard case .started = started else { return XCTFail("didn't start") }
    let ready = Date().addingTimeInterval(5)
    while Date() < ready, !FileManager.default.fileExists(atPath: marker + ".writes") { usleep(10_000) }
    XCTAssertEqual(runs.stopAll(grace: 1, reapLimit: 0.5), AfterUpdateQuitStops(exitedOnTerm: 1, killed: 0), "the command doesn't inherit the app's blocked TERM")
  }

  func testAGroupThatKeepsForkingIsEmptiedByTheStop() throws {
    let runs = AfterUpdateRuns()
    let run = try startScript(runs, tag: "forking", "trap '' TERM\necho $$ > \"$1.child\"\nwhile :; do sleep 3 & sleep 0.02; done")
    usleep(300_000)
    let stops = runs.stopAll(grace: 0.3, reapLimit: 0.5)
    XCTAssertEqual(stops, AfterUpdateQuitStops(exitedOnTerm: 0, killed: 1))
    XCTAssertTrue(runs.running.isEmpty)
    let end = Date().addingTimeInterval(1)
    while Date() < end, kill(-run.group, 0) == 0 { usleep(20_000) }
    XCTAssertNotEqual(kill(-run.group, 0), 0, "no member of the group outlives the stop")
  }

  func testAQuitThatBeginsWhileACommandLaunchesKeepsItFromEverRunning() throws {
    let runs = AfterUpdateRuns()
    runs.afterLaunch = { runs.beginQuit() }
    let marker = (root as NSString).appendingPathComponent("launching")
    let program = try fakeCommand("launching.sh", ignoresTerm: true)
    XCTAssertEqual(runs.spawn(program, [marker], environment: ["PATH": "/usr/bin:/bin"]), .quitting)
    usleep(300_000)
    XCTAssertFalse(FileManager.default.fileExists(atPath: marker + ".ready"), "the command never ran")
    XCTAssertTrue(runs.running.isEmpty)
  }

  func testTheGateCannotCloseBetweenTheContinueDecisionAndTheContinue() throws {
    let runs = AfterUpdateRuns()
    let clock = NSLock()
    var hookEnded = 0.0
    var quitReturned = 0.0
    let quitter = DispatchGroup()
    runs.beforeContinue = {
      DispatchQueue.global().async(group: quitter) {
        runs.beginQuit()
        clock.lock()
        quitReturned = Date().timeIntervalSinceReferenceDate
        clock.unlock()
      }
      usleep(300_000)
      clock.lock()
      hookEnded = Date().timeIntervalSinceReferenceDate
      clock.unlock()
    }
    let marker = (root as NSString).appendingPathComponent("continuing")
    let program = try fakeCommand("continuing.sh", ignoresTerm: false)
    guard case .started = runs.spawn(program, [marker], environment: ["PATH": "/usr/bin:/bin"]) else { return XCTFail("didn't start") }
    XCTAssertEqual(quitter.wait(timeout: .now() + 3), .success)
    XCTAssertGreaterThan(quitReturned, hookEnded, "beginQuit waits until the child has been told to continue")
    _ = runs.stopAll(grace: 1, reapLimit: 0.5)
    XCTAssertTrue(runs.running.isEmpty)
  }

  func testTheFinalShutdownOnlyWaitsOutTheQuitAttemptsOwnDeadline() throws {
    let runs = AfterUpdateRuns()
    let run = try start(runs, ignoresTerm: true, tag: "deadline")
    let finished = DispatchSemaphore(value: 0)
    var tally = AfterUpdateQuitStops()
    let began = Date()
    runs.stopForQuit(limit: 0.4, grace: 1, reapLimit: 0.5) {
      tally = $0
      finished.signal()
    }
    usleep(100_000)
    XCTAssertNil(runs.finishQuit(grace: 1, reapLimit: 0.5), "no second TERM and KILL cycle while the quit's own stop is in flight")
    XCTAssertLessThan(Date().timeIntervalSince(began), 0.6, "it waits only for what's left of the quit's deadline")
    XCTAssertEqual(finished.wait(timeout: .now() + 3), .success)
    XCTAssertEqual(tally, AfterUpdateQuitStops(exitedOnTerm: 0, killed: 1))
    XCTAssertTrue(gone(run.child))
  }

  func testAStopThatStartsLateStillKillsByTheAttemptsDeadline() throws {
    let runs = AfterUpdateRuns()
    let run = try start(runs, ignoresTerm: true, tag: "late")
    runs.beginQuit()
    let began = Date()
    let stops = runs.stopAll(grace: 1, reapLimit: 0.5, from: uptimeNow() - 1.2)
    XCTAssertLessThan(Date().timeIntervalSince(began), 0.6, "the TERM grace counts from the quit attempt, not from when the worker ran")
    XCTAssertEqual(stops, AfterUpdateQuitStops(exitedOnTerm: 0, killed: 1))
    XCTAssertTrue(gone(run.child))
  }

  func testAWorkerThatStartsNearTheEndStillReapsWithinTheAttemptsDeadline() throws {
    let runs = AfterUpdateRuns()
    let run = try start(runs, ignoresTerm: true, tag: "very-late")
    runs.beginQuit()
    let now = uptimeNow()
    let began = Date()
    let stops = runs.stopAll(grace: 1, reapLimit: 0.5, from: now - 1.6, until: now + 0.9)
    XCTAssertLessThan(Date().timeIntervalSince(began), 0.95)
    XCTAssertEqual(stops, AfterUpdateQuitStops(exitedOnTerm: 0, killed: 1))
    XCTAssertTrue(runs.running.isEmpty, "the late worker KILLs and still reaps inside what's left of the deadline")
    XCTAssertTrue(gone(run.child))
  }

  func testTheAttemptsDeadlineCapsBothPhasesOfTheStop() throws {
    let runs = AfterUpdateRuns()
    let run = try start(runs, ignoresTerm: true, tag: "capped")
    runs.beginQuit()
    let now = uptimeNow()
    let began = Date()
    let stops = runs.stopAll(grace: 2, reapLimit: 0.5, from: now, until: now + 0.3)
    XCTAssertLessThan(Date().timeIntervalSince(began), 0.6, "neither the TERM grace nor the reap runs past the deadline")
    XCTAssertEqual(stops, AfterUpdateQuitStops(exitedOnTerm: 0, killed: 1))
    XCTAssertTrue(gone(run.child))
  }

  func testTheFinalShutdownKillsWhatTheQuitsStopHasNotReachedByItsDeadline() throws {
    let runs = AfterUpdateRuns()
    let run = try start(runs, ignoresTerm: true, tag: "missed")
    let finished = DispatchSemaphore(value: 0)
    runs.stopForQuit(limit: 0.15, grace: 2, reapLimit: 0.5) { _ in finished.signal() }
    let began = Date()
    XCTAssertNil(runs.finishQuit())
    XCTAssertLessThan(Date().timeIntervalSince(began), 0.4)
    XCTAssertTrue(gone(run.child, within: 0.4), "a KILL goes out at the deadline even while the worker still waits out its grace")
    XCTAssertEqual(finished.wait(timeout: .now() + 4), .success)
  }

  private func uptimeNow() -> TimeInterval {
    TimeInterval(clock_gettime_nsec_np(CLOCK_UPTIME_RAW)) / 1_000_000_000
  }

  func testTheFinalShutdownStopsOnItsOwnWhenNoQuitAttemptIsInFlight() throws {
    let runs = AfterUpdateRuns()
    let stale = DispatchSemaphore(value: 0)
    runs.stopForQuit(limit: 5) { _ in stale.signal() }
    XCTAssertEqual(stale.wait(timeout: .now() + 2), .success)
    runs.resume()
    let run = try start(runs, ignoresTerm: false, tag: "fallback")
    XCTAssertEqual(runs.finishQuit(grace: 1, reapLimit: 0.5), AfterUpdateQuitStops(exitedOnTerm: 1, killed: 0))
    XCTAssertTrue(gone(run.child))
  }

  func testWorkHeldBackByAPendingQuitRunsWhenTheQuitIsCancelled() throws {
    let runs = AfterUpdateRuns()
    var ran = 0
    runs.whenOpen { ran += 1 }
    XCTAssertEqual(ran, 1, "with no quit pending it runs at once")
    runs.beginQuit()
    runs.whenOpen { ran += 1 }
    runs.whenOpen { ran += 1 }
    XCTAssertEqual(ran, 1, "held back while quit is pending")
    runs.resume()
    XCTAssertEqual(ran, 3, "a cancelled quit runs what it held back")
    runs.resume()
    XCTAssertEqual(ran, 3, "and only once")
    runs.beginQuit()
    runs.whenOpen { ran += 1 }
    _ = runs.stopAll(grace: 0.1, reapLimit: 0.1)
    XCTAssertEqual(ran, 3, "a quit that goes through drops it; the next launch runs the update again")
  }

  func testAChildLeftBehindByANormalExitIsEndedBeforeTheRunCounts() throws {
    let runs = AfterUpdateRuns()
    let run = try startScript(runs, tag: "leaves-child", "\(Self.stubbornChild)\nexit 0")
    XCTAssertEqual(runs.wait(group: run.group, deadline: 10, grace: 0.3), 0)
    XCTAssertTrue(gone(run.child, within: 0.5))
    XCTAssertTrue(runs.running.isEmpty)
  }

  func testASecondQuitWaitsOutAGroupTheFirstStopStillHolds() throws {
    let runs = AfterUpdateRuns()
    let run = try startScript(runs, tag: "held", "trap '' TERM\n\(Self.stubbornChild)\nwhile :; do sleep 0.05; done")
    let first = runs.beginQuit()
    let firstStop = DispatchGroup()
    DispatchQueue.global().async(group: firstStop) { _ = runs.stopAll(epoch: first, grace: 3, reapLimit: 0.5) }
    usleep(150_000)
    runs.resume()
    let second = runs.beginQuit()
    let began = Date()
    _ = runs.stopAll(epoch: second, grace: 0.3, reapLimit: 0.5)
    XCTAssertLessThan(Date().timeIntervalSince(began), 1.5)
    XCTAssertTrue(gone(run.group, within: 0.3))
    XCTAssertTrue(gone(run.child, within: 0.3), "the second stop doesn't leave the first one's group alive")
    XCTAssertEqual(firstStop.wait(timeout: .now() + 5), .success)
  }

  func testTheGraceCoversChildrenStillCleaningUp() throws {
    let runs = AfterUpdateRuns()
    let slowChild = "/bin/sh -c 'trap \"sleep 0.3; echo cleaned > \\\"$0.cleaned\\\"; exit 0\" TERM; while :; do sleep 0.05; done' \"$1\" &\necho $! > \"$1.child\""
    let run = try startScript(runs, tag: "slow-child", "trap 'exit 0' TERM\n\(slowChild)\nwhile :; do sleep 0.05; done")
    let began = Date()
    let stops = runs.stopAll(grace: 1, reapLimit: 0.5)
    XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(began), 0.25)
    XCTAssertEqual(stops, AfterUpdateQuitStops(exitedOnTerm: 1, killed: 0))
    XCTAssertTrue(FileManager.default.fileExists(atPath: run.marker + ".cleaned"), "the child got to finish its TERM handler")
    XCTAssertTrue(gone(run.child))
  }

  func testACommandThatIgnoresTermIsKilledWithinTheDeadline() throws {
    let runs = AfterUpdateRuns()
    let run = try start(runs, ignoresTerm: true, tag: "stubborn")
    let began = Date()
    let stops = runs.stopAll(grace: 0.4, reapLimit: 0.5)
    let took = Date().timeIntervalSince(began)
    XCTAssertEqual(stops, AfterUpdateQuitStops(exitedOnTerm: 0, killed: 1))
    XCTAssertGreaterThanOrEqual(took, 0.35)
    XCTAssertLessThan(took, 1.0)
    XCTAssertTrue(runs.running.isEmpty)
    XCTAssertTrue(gone(run.group))
    XCTAssertTrue(gone(run.child))
    let after = writeCount(run.marker)
    usleep(300_000)
    XCTAssertEqual(writeCount(run.marker), after)
  }

  func testACommandThatExitsOnTermIsReaped() throws {
    let runs = AfterUpdateRuns()
    let run = try start(runs, ignoresTerm: false, tag: "polite")
    let began = Date()
    let stops = runs.stopAll(grace: 1, reapLimit: 0.5)
    XCTAssertLessThan(Date().timeIntervalSince(began), 0.9)
    XCTAssertEqual(stops, AfterUpdateQuitStops(exitedOnTerm: 1, killed: 0))
    XCTAssertTrue(runs.running.isEmpty)
    var status: Int32 = 0
    XCTAssertEqual(waitpid(run.group, &status, WNOHANG), -1)
    XCTAssertEqual(errno, ECHILD)
    XCTAssertTrue(gone(run.group))
    XCTAssertTrue(gone(run.child))
  }

  func testNothingStartsAfterQuitBegins() throws {
    let runs = AfterUpdateRuns()
    runs.beginQuit()
    let program = try fakeCommand("late.sh", ignoresTerm: false)
    let marker = (root as NSString).appendingPathComponent("late")
    XCTAssertEqual(runs.spawn(program, [marker], environment: [:]), .quitting)
    usleep(200_000)
    XCTAssertFalse(FileManager.default.fileExists(atPath: marker + ".ready"))
    XCTAssertTrue(runs.running.isEmpty)
    runs.resume()
    let stopped = AfterUpdateRuns()
    XCTAssertEqual(stopped.stopAll(grace: 0.1, reapLimit: 0.1), AfterUpdateQuitStops())
    XCTAssertEqual(stopped.spawn(program, [marker], environment: [:]), .quitting)
    XCTAssertTrue(stopped.isQuitting)
  }

  func testQuitWhileTheUpdateQueueWaitsLeavesNothingRunning() throws {
    let runs = AfterUpdateRuns()
    let stubborn = try start(runs, ignoresTerm: true, tag: "waited-stubborn")
    let polite = try start(runs, ignoresTerm: false, tag: "waited-polite")
    var results: [pid_t: Int32] = [:]
    let lock = NSLock()
    let waiters = DispatchGroup()
    for group in [stubborn.group, polite.group] {
      DispatchQueue.global().async(group: waiters) {
        let code = runs.wait(group: group, deadline: 300, grace: 3)
        lock.lock()
        results[group] = code
        lock.unlock()
      }
    }
    usleep(150_000)
    let stops = runs.stopAll(grace: 0.4, reapLimit: 0.5)
    XCTAssertEqual(stops, AfterUpdateQuitStops(exitedOnTerm: 1, killed: 1))
    XCTAssertEqual(waiters.wait(timeout: .now() + 2), .success)
    XCTAssertEqual(results[stubborn.group], AfterUpdateRuns.interrupted)
    XCTAssertEqual(results[polite.group], AfterUpdateRuns.interrupted, "an exit 0 on TERM at quit isn't a finished update")
    XCTAssertTrue(runs.running.isEmpty)
    for pid in [stubborn.group, stubborn.child, polite.group, polite.child] { XCTAssertTrue(gone(pid), "pid \(pid) is still running") }
  }

  func testAChildThatIgnoresTermIsKilledEvenWhenItsLeaderExitsAndTheWaiterIsWatching() throws {
    let runs = AfterUpdateRuns()
    let run = try start(runs, ignoresTerm: false, childIgnoresTerm: true, tag: "orphaning")
    var code: Int32 = 0
    let waiter = DispatchGroup()
    DispatchQueue.global().async(group: waiter) { code = runs.wait(group: run.group, deadline: 300, grace: 3) }
    usleep(150_000)
    let stops = runs.stopAll(grace: 0.4, reapLimit: 0.5)
    XCTAssertEqual(stops, AfterUpdateQuitStops(exitedOnTerm: 0, killed: 1), "a group counts as exited only when every member left on TERM")
    XCTAssertEqual(waiter.wait(timeout: .now() + 2), .success)
    XCTAssertEqual(code, AfterUpdateRuns.interrupted)
    XCTAssertTrue(gone(run.group))
    XCTAssertTrue(gone(run.child))
    usleep(100_000)
    let after = writeCount(run.marker)
    usleep(300_000)
    XCTAssertEqual(writeCount(run.marker), after, "nothing writes after the stop returns")
  }

  func testAStopFromACancelledQuitTouchesNothing() throws {
    let runs = AfterUpdateRuns()
    let stale = runs.beginQuit()
    runs.resume()
    let run = try start(runs, ignoresTerm: false, tag: "after-cancel")
    XCTAssertEqual(runs.stopAll(epoch: stale, grace: 0.1, reapLimit: 0.1), AfterUpdateQuitStops())
    XCTAssertFalse(runs.isQuitting)
    let next = runs.beginQuit()
    XCTAssertNotEqual(next, stale)
    XCTAssertEqual(runs.stopAll(epoch: stale, grace: 0.1, reapLimit: 0.1), AfterUpdateQuitStops())
    XCTAssertEqual(runs.running, [run.group])
    XCTAssertEqual(runs.stopAll(epoch: next, grace: 1, reapLimit: 0.5), AfterUpdateQuitStops(exitedOnTerm: 1, killed: 0))
    XCTAssertTrue(gone(run.child))
  }

  func testANormalRunStillReportsItsExitCode() throws {
    let runs = AfterUpdateRuns()
    let path = (root as NSString).appendingPathComponent("quick.sh")
    try "#!/bin/sh\nexit 3\n".write(toFile: path, atomically: true, encoding: .utf8)
    chmod(path, 0o755)
    guard case .started(let group) = runs.spawn(path, [], environment: [:]) else { return XCTFail("didn't start") }
    XCTAssertEqual(runs.wait(group: group, deadline: 10, grace: 1), 3)
    XCTAssertTrue(runs.running.isEmpty)
    XCTAssertEqual(runs.stopAll(grace: 0.1, reapLimit: 0.1), AfterUpdateQuitStops())
  }
}
