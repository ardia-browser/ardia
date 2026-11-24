import Darwin
import Foundation

enum ChildProcessCpu {
  static let queue = DispatchQueue(label: "ardia.child-process-cpu", qos: .utility)

  private struct Known {
    let started: UInt64
    let renderer: Bool
  }

  private static var known: [pid_t: Known] = [:]
  private static let ticksToNanos: Double = {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    return info.denom == 0 ? 1 : Double(info.numer) / Double(info.denom)
  }()

  static func sample(_ reply: @escaping ([[String: Any]]) -> Void) {
    queue.async { reply(read()) }
  }

  private static func read() -> [[String: Any]] {
    let me = getpid()
    var pids = [pid_t](repeating: 0, count: 1024)
    let bytes = pids.withUnsafeMutableBytes { buffer in
      proc_listpids(UInt32(PROC_PPID_ONLY), UInt32(me), buffer.baseAddress, Int32(buffer.count))
    }
    guard bytes > 0 else { return [] }
    let count = min(pids.count, Int(bytes) / MemoryLayout<pid_t>.size)
    var alive: [pid_t: Known] = [:]
    var rows: [[String: Any]] = []
    for pid in pids.prefix(count) where pid > 0 {
      guard let usage = rusage(pid) else { continue }
      let started = usage.ri_proc_start_abstime
      let renderer = known[pid].flatMap { $0.started == started ? $0.renderer : nil } ?? isRenderer(pid)
      guard parent(of: pid) == me, rusage(pid)?.ri_proc_start_abstime == started else { continue }
      alive[pid] = Known(started: started, renderer: renderer)
      guard renderer else { continue }
      let cpuMs = Double(usage.ri_user_time &+ usage.ri_system_time) * ticksToNanos / 1_000_000
      rows.append(["pid": Int(pid), "started": Double(started), "cpuMs": cpuMs])
    }
    known = alive
    return rows
  }

  private static func rusage(_ pid: pid_t) -> rusage_info_v2? {
    var usage = rusage_info_v2()
    let read = withUnsafeMutablePointer(to: &usage) {
      $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V2, $0) }
    }
    return read == 0 ? usage : nil
  }

  private static func parent(of pid: pid_t) -> pid_t? {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size ? pid_t(info.pbi_ppid) : nil
  }

  private static func isRenderer(_ pid: pid_t) -> Bool {
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    var size = 0
    guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 0 else { return false }
    var args = [UInt8](repeating: 0, count: size)
    guard sysctl(&mib, 3, &args, &size, nil, 0) == 0 else { return false }
    let line = String(decoding: args.prefix(size).map { $0 == 0 ? 0x20 : $0 }, as: UTF8.self)
    return line.contains(" --type=renderer") && !line.contains(" --extension-process")
  }
}
