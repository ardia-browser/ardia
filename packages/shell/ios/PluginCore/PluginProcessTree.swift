import Darwin
import Foundation

struct PluginProcessMember: Hashable {
  let pid: pid_t
  let started: UInt64
}

enum PluginProcessTree {
  private typealias Disclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
  private typealias Responsible = @convention(c) (pid_t) -> pid_t
  private static let disclaimer: Disclaim? = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim").map { unsafeBitCast($0, to: Disclaim.self) }
  private static let responsibleFor: Responsible? = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid").map { unsafeBitCast($0, to: Responsible.self) }

  static var tracksResponsibility: Bool { disclaimer != nil && responsibleFor != nil }

  static func disclaim(_ attributes: inout posix_spawnattr_t?) -> Bool {
    guard let disclaimer, responsibleFor != nil else { return false }
    return disclaimer(&attributes, 1) == 0
  }

  struct Entry {
    let pid: pid_t
    let ppid: pid_t
    let pgid: pid_t
    let started: UInt64
  }

  static func entry(_ pid: pid_t) -> Entry? {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
    return Entry(pid: pid, ppid: pid_t(info.pbi_ppid), pgid: pid_t(info.pbi_pgid), started: info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
  }

  static func table() -> [Entry] {
    let count = proc_listallpids(nil, 0)
    guard count > 0 else { return [] }
    var pids = [pid_t](repeating: 0, count: Int(count) + 64)
    let got = proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size))
    return pids.prefix(Int(max(0, got))).filter { $0 > 0 }.compactMap(entry)
  }

  static func family(of root: pid_t, byResponsibility: Bool = tracksResponsibility) -> Set<PluginProcessMember> {
    let entries = table()
    let excluded: Set<pid_t> = [0, 1, getpid()]
    var pids: Set<pid_t> = [root]
    if byResponsibility, let responsibleFor {
      for e in entries where !excluded.contains(e.pid) && responsibleFor(e.pid) == root { pids.insert(e.pid) }
    }
    var grew = true
    while grew {
      grew = false
      for e in entries where !pids.contains(e.pid) && !excluded.contains(e.pid) && (pids.contains(e.ppid) || pids.contains(e.pgid)) {
        pids.insert(e.pid)
        grew = true
      }
    }
    return Set(entries.filter { pids.contains($0.pid) && !excluded.contains($0.pid) }.map { PluginProcessMember(pid: $0.pid, started: $0.started) })
  }

  static func ownership(_ pid: pid_t) -> Bool? {
    var info = siginfo_t()
    var got = waitid(P_PID, id_t(pid), &info, WEXITED | WNOHANG | WNOWAIT)
    while got < 0 && errno == EINTR { got = waitid(P_PID, id_t(pid), &info, WEXITED | WNOHANG | WNOWAIT) }
    if got < 0 { return nil }
    return info.si_pid == pid
  }

  static func withDescendants(_ given: Set<PluginProcessMember>) -> Set<PluginProcessMember> {
    let entries = table()
    let excluded: Set<pid_t> = [0, 1, getpid()]
    let listed = Dictionary(entries.map { ($0.pid, $0.started) }, uniquingKeysWith: { a, _ in a })
    let members = given.filter { listed[$0.pid] == $0.started }
    var pids = Set(members.map(\.pid))
    var grew = true
    while grew {
      grew = false
      for e in entries where !pids.contains(e.pid) && !excluded.contains(e.pid) && (pids.contains(e.ppid) || pids.contains(e.pgid)) {
        pids.insert(e.pid)
        grew = true
      }
    }
    let known = Dictionary(members.map { ($0.pid, $0) }, uniquingKeysWith: { a, _ in a })
    return Set(entries.filter { pids.contains($0.pid) && !excluded.contains($0.pid) }.map { known[$0.pid] ?? PluginProcessMember(pid: $0.pid, started: $0.started) })
  }

  static func alive(_ members: Set<PluginProcessMember>) -> Set<PluginProcessMember> {
    members.filter { entry($0.pid)?.started == $0.started }
  }

  static func signal(_ members: Set<PluginProcessMember>, _ signal: Int32) {
    for member in members where entry(member.pid)?.started == member.started { kill(member.pid, signal) }
  }
}

final class PluginFamily {
  let root: pid_t
  private(set) var members: Set<PluginProcessMember> = []
  private let queue: DispatchQueue
  private let interval: TimeInterval
  private var forks: DispatchSourceProcess?
  private var timer: DispatchSourceTimer?
  private var samplePending = false

  init(root: pid_t, queue: DispatchQueue, interval: TimeInterval = 1) {
    self.root = root
    self.queue = queue
    self.interval = interval
  }

  func start() {
    let forks = DispatchSource.makeProcessSource(identifier: root, eventMask: .fork, queue: queue)
    forks.setEventHandler { [weak self] in self?.requestSample() }
    forks.activate()
    self.forks = forks
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + interval, repeating: interval)
    timer.setEventHandler { [weak self] in self?.sample() }
    timer.activate()
    self.timer = timer
    sample()
  }

  private func requestSample() {
    guard !samplePending else { return }
    samplePending = true
    queue.async { [weak self] in
      guard let self else { return }
      self.samplePending = false
      self.sample()
    }
  }

  func sample() {
    members = PluginProcessTree.alive(members).union(PluginProcessTree.family(of: root))
  }

  func signal(_ signal: Int32, group: Bool) {
    sample()
    members = PluginProcessTree.withDescendants(PluginProcessTree.alive(members))
    if group { kill(-root, signal) }
    PluginProcessTree.signal(members, signal)
  }

  func cancel() {
    forks?.cancel()
    forks = nil
    timer?.cancel()
    timer = nil
  }
}
