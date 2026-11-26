import Darwin
import Foundation

struct PluginUsage: Equatable {
  let memoryBytes: UInt64
  let cpuNanos: UInt64

  static let timebase: (numer: UInt64, denom: UInt64) = {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    return (UInt64(max(1, info.numer)), UInt64(max(1, info.denom)))
  }()

  static func sample(_ pid: pid_t) -> PluginUsage? {
    guard pid > 0 else { return nil }
    var info = rusage_info_v4()
    let status = withUnsafeMutablePointer(to: &info) { pointer in
      pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
    }
    guard status == 0 else { return nil }
    let ticks = info.ri_user_time &+ info.ri_system_time
    return PluginUsage(memoryBytes: info.ri_phys_footprint, cpuNanos: ticks.multipliedReportingOverflow(by: timebase.numer).partialValue / timebase.denom)
  }
}
