import Darwin
import Foundation
import JavaScriptCore

final class HostGlobals {
  static let maxTimerMs = Double(Int32.max)
  static let maxRandomBytes = 65536

  private let context: JSContext
  private let queue: DispatchQueue
  private var channel: HostChannel?
  private var lineHandler: JSValue?
  private var timerHandler: JSValue?
  private var earlyLines: [String] = []
  private var timers = PluginTimerQueue()
  private var timerSource: DispatchSourceTimer?
  private var armedFor: UInt64?

  init(context: JSContext, queue: DispatchQueue) {
    self.context = context
    self.queue = queue
  }

  func attach(_ channel: HostChannel) {
    self.channel = channel
  }

  func deliver(_ line: String) {
    guard let handler = lineHandler else {
      if earlyLines.count < 256 { earlyLines.append(line) }
      return
    }
    handler.call(withArguments: [line])
  }

  static func write(_ text: String) {
    FileHandle.standardError.write(Data((text.hasSuffix("\n") ? text : text + "\n").utf8))
  }

  private func armTimerSource() {
    guard let due = timers.nextDue() else { return }
    if armedFor == due { return }
    let source: DispatchSourceTimer
    if let existing = timerSource {
      source = existing
    } else {
      source = DispatchSource.makeTimerSource(queue: queue)
      source.setEventHandler { [weak self] in self?.fireDueTimers() }
      timerSource = source
      source.resume()
    }
    armedFor = due
    source.schedule(deadline: DispatchTime(uptimeNanoseconds: due))
  }

  private func fireDueTimers() {
    armedFor = nil
    let now = DispatchTime.now().uptimeNanoseconds
    while let id = timers.popDue(now: now) {
      timerHandler?.call(withArguments: [id])
    }
    armTimerSource()
  }

  func native() -> JSValue {
    let object = JSValue(newObjectIn: context)!
    let log: @convention(block) (String, String) -> Void = { level, text in
      let tag = level == "log" ? "" : "[\(level)] "
      Self.write(tag + text)
    }
    let onLine: @convention(block) (JSValue) -> Void = { [weak self] handler in
      guard let self else { return }
      self.lineHandler = handler
      let early = self.earlyLines
      self.earlyLines = []
      for line in early { handler.call(withArguments: [line]) }
    }
    let onTimer: @convention(block) (JSValue) -> Void = { [weak self] handler in self?.timerHandler = handler }
    let schedule: @convention(block) (Double, Double) -> Bool = { [weak self] id, ms in
      guard let self else { return false }
      let delay = ms.isFinite ? min(Self.maxTimerMs, max(0, ms)) : 0
      let due = DispatchTime.now().uptimeNanoseconds + UInt64(delay) * 1_000_000
      guard self.timers.schedule(id, due: due) else { return false }
      self.armTimerSource()
      return true
    }
    let cancel: @convention(block) (Double) -> Void = { [weak self] id in
      self?.timers.cancel(id)
    }
    let send: @convention(block) (String) -> Any = { [weak self] line in
      guard let channel = self?.channel else { return "the channel to Ardia is closed" }
      return channel.send(line)?.message ?? NSNull()
    }
    let btoa: @convention(block) (String) -> Any = { text in PluginBase64.encode(text) ?? NSNull() }
    let atob: @convention(block) (String) -> Any = { text in PluginBase64.decode(text) ?? NSNull() }
    let randomUUID: @convention(block) () -> String = { UUID().uuidString.lowercased() }
    let randomBytes: @convention(block) (Int) -> [UInt8] = { count in
      var bytes = [UInt8](repeating: 0, count: min(Self.maxRandomBytes, max(0, count)))
      if !bytes.isEmpty { arc4random_buf(&bytes, bytes.count) }
      return bytes
    }
    let parseURL: @convention(block) (String, JSValue) -> Any = { input, base in
      PluginURLParser.parse(input, base: base.isString ? base.toString() : nil) ?? NSNull()
    }
    let functions: [String: Any] = [
      "log": log, "onLine": onLine, "onTimer": onTimer, "schedule": schedule, "cancel": cancel, "send": send, "btoa": btoa, "atob": atob, "randomUUID": randomUUID,
      "randomBytes": randomBytes, "parseURL": parseURL,
    ]
    for (name, function) in functions { object.setObject(function, forKeyedSubscript: name as NSString) }
    return object
  }
}
