import ExpoModulesCore

public class TelemetryLocalModule: Module, TelemetryLocalNative {
  private static func reply(_ exported: TelemetryLocalStore.Exported?) -> [String: Any]? {
    exported.map { ["path": $0.path, "bytes": $0.bytes, "lines": $0.lines] }
  }

  static func append(_ day: String, _ text: String) { TelemetryLocalStore.append(day: day, text: text) }

  static func appendNow(_ day: String, _ text: String) { TelemetryLocalStore.appendNow(day: day, text: text) }

  static func configure(_ maxBytes: Int, _ keepDays: Int) { TelemetryLocalStore.configure(maxBytes: maxBytes, keepDays: keepDays) }

  static func prune(_ now: Double, _ promise: Promise) {
    TelemetryLocalStore.pruneAndMeasure(now: now) { stats, writeMs in
      promise.resolve([
        "bytes": stats.bytes, "lines": stats.lines, "files": stats.files, "droppedLines": stats.droppedLines,
        "pruneMs": stats.pruneMs, "writeMs": writeMs,
      ])
    }
  }

  static func clear(_ promise: Promise) { TelemetryLocalStore.clear { promise.resolve(nil) } }

  static func exportForReport(_ since: Double, _ promise: Promise) { TelemetryLocalStore.exportForReport(since: since) { promise.resolve(Self.reply($0)) } }

  static func exportToDownloads(_ now: Double, _ promise: Promise) { TelemetryLocalStore.exportToDownloads(now: now) { promise.resolve(Self.reply($0)) } }

  public func definition() -> ModuleDefinition {
    Name(Self.moduleName)

    Self.appendFunction
    Self.appendNowFunction
    Self.configureFunction
    Self.pruneFunction
    Self.clearFunction
    Self.exportForReportFunction
    Self.exportToDownloadsFunction
  }
}
