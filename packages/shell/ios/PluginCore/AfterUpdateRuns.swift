import Darwin
import Foundation

struct AfterUpdateQuitStops: Equatable {
  var exitedOnTerm = 0
  var killed = 0

  var isEmpty: Bool { exitedOnTerm == 0 && killed == 0 }

  static func + (a: AfterUpdateQuitStops, b: AfterUpdateQuitStops) -> AfterUpdateQuitStops {
    AfterUpdateQuitStops(exitedOnTerm: a.exitedOnTerm + b.exitedOnTerm, killed: a.killed + b.killed)
  }
}

enum AfterUpdateSpawn: Equatable {
  case started(pid_t)
  case failed
  case quitting
}

final class AfterUpdateRuns {
  static let shared = AfterUpdateRuns()
  static let quitGrace: TimeInterval = 1
  static let quitReapLimit: TimeInterval = 0.5
  static let interrupted: Int32 = -2
  static let stuckLimit: TimeInterval = 10

  private let lock = NSLock()
  private var groups: Set<pid_t> = []
  private var stops: [pid_t: Int] = [:]
  private var pinned: [pid_t: Int] = [:]
  private var stoppedByQuit: Set<pid_t> = []
  private var killedAtDeadline: Set<pid_t> = []
  private var reapedByStop: [pid_t: Int32] = [:]
  private var quitting = false
  private var epoch = 0
  private var deferred: [() -> Void] = []
  private var quitStop: (epoch: Int, deadline: TimeInterval, done: DispatchGroup)?
  var afterLaunch: (() -> Void)?
  var beforeContinue: (() -> Void)?

  var isQuitting: Bool {
    lock.lock()
    defer { lock.unlock() }
    return quitting
  }

  var running: Set<pid_t> {
    lock.lock()
    defer { lock.unlock() }
    return groups
  }

  @discardableResult
  func beginQuit() -> Int {
    lock.lock()
    defer { lock.unlock() }
    if !quitting {
      quitting = true
      epoch += 1
    }
    return epoch
  }

  func resume() {
    lock.lock()
    quitting = false
    quitStop = nil
    killedAtDeadline = []
    let jobs = deferred
    deferred = []
    lock.unlock()
    jobs.forEach { $0() }
  }

  func whenOpen(_ job: @escaping () -> Void) {
    lock.lock()
    guard !quitting else {
      deferred.append(job)
      lock.unlock()
      return
    }
    lock.unlock()
    job()
  }

  func stopForQuit(
    limit: TimeInterval, grace: TimeInterval = AfterUpdateRuns.quitGrace, reapLimit: TimeInterval = AfterUpdateRuns.quitReapLimit,
    finished: @escaping (AfterUpdateQuitStops) -> Void
  ) {
    let done = DispatchGroup()
    done.enter()
    lock.lock()
    if !quitting {
      quitting = true
      epoch += 1
    }
    let mine = epoch
    let began = Self.now()
    quitStop = (mine, began + limit, done)
    lock.unlock()
    DispatchQueue.global(qos: .userInitiated).async {
      finished(self.stopAll(epoch: mine, grace: grace, reapLimit: reapLimit, from: began, until: began + limit))
      done.leave()
    }
  }

  func finishQuit(grace: TimeInterval = AfterUpdateRuns.quitGrace, reapLimit: TimeInterval = AfterUpdateRuns.quitReapLimit) -> AfterUpdateQuitStops? {
    lock.lock()
    let inFlight = quitting ? quitStop.flatMap { $0.epoch == epoch ? $0 : nil } : nil
    lock.unlock()
    guard let inFlight else { return stopAll(grace: grace, reapLimit: reapLimit) }
    if inFlight.done.wait(timeout: .now() + max(0, inFlight.deadline - Self.now())) == .timedOut {
      for group in running where !groupGone(group) {
        lock.lock()
        killedAtDeadline.insert(group)
        lock.unlock()
        send(SIGKILL, to: group)
      }
    }
    return nil
  }

  func spawn(_ program: String, _ arguments: [String], environment: [String: String], directory: String = NSTemporaryDirectory()) -> AfterUpdateSpawn {
    var attributes: posix_spawnattr_t?
    var actions: posix_spawn_file_actions_t?
    guard posix_spawnattr_init(&attributes) == 0 else { return .failed }
    defer { posix_spawnattr_destroy(&attributes) }
    guard posix_spawn_file_actions_init(&actions) == 0 else { return .failed }
    defer { posix_spawn_file_actions_destroy(&actions) }
    guard !isQuitting else { return .quitting }
    var noSignalsBlocked = sigset_t()
    var defaultSignals = sigset_t()
    sigemptyset(&noSignalsBlocked)
    sigfillset(&defaultSignals)
    let flags = POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_START_SUSPENDED | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF
    guard posix_spawnattr_setflags(&attributes, Int16(flags)) == 0, posix_spawnattr_setpgroup(&attributes, 0) == 0,
      posix_spawnattr_setsigmask(&attributes, &noSignalsBlocked) == 0, posix_spawnattr_setsigdefault(&attributes, &defaultSignals) == 0
    else {
      return .failed
    }
    for fd: Int32 in [0, 1, 2] {
      guard posix_spawn_file_actions_addopen(&actions, fd, "/dev/null", fd == 0 ? O_RDONLY : O_WRONLY, 0) == 0 else { return .failed }
    }
    guard posix_spawn_file_actions_addchdir_np(&actions, directory) == 0 else { return .failed }
    let argv = ([program] + arguments).map { strdup($0) } + [nil]
    let envp = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
    defer { (argv + envp).forEach { free($0) } }
    var pid: pid_t = 0
    guard posix_spawn(&pid, program, &actions, &attributes, argv, envp) == 0 else { return .failed }
    afterLaunch?()
    lock.lock()
    guard !quitting else {
      lock.unlock()
      kill(pid, SIGKILL)
      var status: Int32 = 0
      while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
      return .quitting
    }
    groups.insert(pid)
    beforeContinue?()
    kill(pid, SIGCONT)
    lock.unlock()
    return .started(pid)
  }

  func wait(group: pid_t, deadline: TimeInterval, grace: TimeInterval) -> Int32 {
    let end = Self.now() + deadline
    var exited = false
    while Self.now() < end {
      if leaderExited(group) {
        exited = true
        break
      }
      usleep(100_000)
    }
    let status = reap(group, grace: grace)
    lock.lock()
    let stopped = stoppedByQuit.remove(group) != nil
    lock.unlock()
    if stopped { return Self.interrupted }
    guard let status else { return -1 }
    return exited && (status & 0x7f) == 0 ? (status >> 8) & 0xff : -1
  }

  func stopAll(
    epoch wanted: Int? = nil, grace: TimeInterval = AfterUpdateRuns.quitGrace, reapLimit: TimeInterval = AfterUpdateRuns.quitReapLimit, from began: TimeInterval? = nil,
    until deadline: TimeInterval? = nil
  ) -> AfterUpdateQuitStops {
    let base = began ?? Self.now()
    lock.lock()
    if wanted == nil, !quitting {
      quitting = true
      epoch += 1
    }
    guard quitting, wanted == nil || wanted == epoch else {
      lock.unlock()
      return AfterUpdateQuitStops()
    }
    let targets = groups
    let counted = targets.filter { stops[$0] == nil && !stoppedByQuit.contains($0) }
    for group in targets { stops[group, default: 0] += 1 }
    stoppedByQuit.formUnion(targets)
    lock.unlock()
    var tally = AfterUpdateQuitStops()
    guard !targets.isEmpty else { return tally }
    for group in targets { send(SIGTERM, to: group) }
    var pending = targets
    let cap = deadline ?? .infinity
    let end = min(base + grace, cap)
    while !pending.isEmpty {
      for group in pending where groupGone(group) {
        pending.remove(group)
        if counted.contains(group), !wasKilledAtDeadline(group) { tally.exitedOnTerm += 1 }
      }
      guard !pending.isEmpty, Self.now() < end else { break }
      usleep(10_000)
    }
    tally.killed = counted.count - tally.exitedOnTerm
    var unreaped = targets
    let reapEnd = min(max(base + grace + reapLimit, Self.now() + reapLimit), cap)
    while !unreaped.isEmpty {
      for group in unreaped {
        if groupGone(group) {
          if reapForStop(group) { unreaped.remove(group) }
        } else {
          send(SIGKILL, to: group)
        }
      }
      guard !unreaped.isEmpty, Self.now() < reapEnd else { break }
      usleep(5_000)
    }
    lock.lock()
    for group in targets {
      let left = (stops[group] ?? 1) - 1
      stops[group] = left > 0 ? left : nil
    }
    lock.unlock()
    return tally
  }

  private func wasKilledAtDeadline(_ group: pid_t) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return killedAtDeadline.contains(group)
  }

  private static func now() -> TimeInterval {
    TimeInterval(clock_gettime_nsec_np(CLOCK_UPTIME_RAW)) / 1_000_000_000
  }

  @discardableResult
  private func send(_ number: Int32, to group: pid_t, when allowed: () -> Bool = { true }) -> Int32? {
    lock.lock()
    guard groups.contains(group), allowed() else {
      lock.unlock()
      return nil
    }
    pinned[group, default: 0] += 1
    lock.unlock()
    let result = kill(-group, number)
    unpin(group)
    return result
  }

  private func unpin(_ group: pid_t) {
    lock.lock()
    let left = (pinned[group] ?? 1) - 1
    pinned[group] = left > 0 ? left : nil
    lock.unlock()
  }

  @discardableResult
  private func signalUnlessQuitting(_ group: pid_t, _ number: Int32) -> Bool {
    send(number, to: group) { stops[group] == nil && !quitting } != nil
  }

  private func groupGone(_ group: pid_t) -> Bool {
    guard let alive = send(0, to: group) else { return true }
    guard alive != 0 else { return false }
    usleep(5_000)
    guard let still = send(0, to: group) else { return true }
    return still != 0
  }

  private func leaderExited(_ group: pid_t) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard groups.contains(group) else { return true }
    var info = siginfo_t()
    var got = waitid(P_PID, id_t(group), &info, WEXITED | WNOHANG | WNOWAIT)
    while got < 0 && errno == EINTR { got = waitid(P_PID, id_t(group), &info, WEXITED | WNOHANG | WNOWAIT) }
    return got < 0 || info.si_pid == group
  }

  private func reap(_ group: pid_t, grace: TimeInterval) -> Int32? {
    var ended = false
    var stuckAfter: TimeInterval?
    while true {
      if !ended {
        ended = endGroup(group, grace: grace)
        if ended { stuckAfter = Self.now() + Self.stuckLimit }
      }
      let empty = groupGone(group)
      if ended, !empty {
        signalUnlessQuitting(group, SIGKILL)
        if let stuckAfter, Self.now() >= stuckAfter, !isQuitting { return nil }
      }
      lock.lock()
      if let status = reapedByStop.removeValue(forKey: group) {
        lock.unlock()
        return status
      }
      guard groups.contains(group) else {
        lock.unlock()
        return nil
      }
      if ended, empty, stops[group] == nil, pinned[group] == nil, !quitting {
        var status: Int32 = 0
        let got = waitpid(group, &status, WNOHANG)
        if got == group || (got < 0 && errno != EINTR) {
          groups.remove(group)
          lock.unlock()
          return got == group ? status : nil
        }
      }
      lock.unlock()
      usleep(10_000)
    }
  }

  private func endGroup(_ group: pid_t, grace: TimeInterval) -> Bool {
    guard signalUnlessQuitting(group, SIGTERM) else { return false }
    let graceEnd = Self.now() + grace
    while !groupGone(group), Self.now() < graceEnd { usleep(20_000) }
    return groupGone(group) || signalUnlessQuitting(group, SIGKILL)
  }

  private func reapForStop(_ group: pid_t) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard groups.contains(group) else { return true }
    guard pinned[group] == nil else { return false }
    var status: Int32 = 0
    let got = waitpid(group, &status, WNOHANG)
    if got == group {
      groups.remove(group)
      reapedByStop[group] = status
      return true
    }
    if got < 0 && errno != EINTR {
      groups.remove(group)
      return true
    }
    return false
  }
}
