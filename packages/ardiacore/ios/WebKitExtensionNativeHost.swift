import Foundation

@MainActor
final class WebKitExtensionNativeHost {
  nonisolated static let errorDomain = "dev.ardia.webkit.nativeMessaging"
  nonisolated static let skipped: Set<String> = ["com.apple.passwordmanager"]
  nonisolated static let maxIncoming = 1024 * 1024
  nonisolated static let maxOutgoing = 64 * 1024 * 1024
  nonisolated static let killDelay: TimeInterval = 2

  nonisolated static func folders() -> [URL] {
    let home = FileManager.default.homeDirectoryForCurrentUser
    return [
      URL(fileURLWithPath: ArdiaHost.dataDirectory, isDirectory: true).appendingPathComponent("NativeMessagingHosts", isDirectory: true),
      home.appendingPathComponent("Library/Application Support/Google/Chrome/NativeMessagingHosts", isDirectory: true),
      home.appendingPathComponent("Library/Application Support/Chromium/NativeMessagingHosts", isDirectory: true),
      URL(fileURLWithPath: "/Library/Application Support/Chromium/NativeMessagingHosts", isDirectory: true),
      URL(fileURLWithPath: "/Library/Google/Chrome/NativeMessagingHosts", isDirectory: true),
    ]
  }

  nonisolated static func isValidName(_ name: String) -> Bool {
    name.range(of: "\\A[a-z0-9_]+(\\.[a-z0-9_]+)*\\z", options: .regularExpression) != nil
  }

  nonisolated static func error(_ message: String) -> NSError {
    NSError(domain: errorDomain, code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }

  static let notFound = error("Specified native messaging host not found.")
  static let forbidden = error("Access to the specified native messaging host is forbidden.")
  static let exited = error("Native host has exited.")
  static let broken = error("Error when communicating with the native messaging host.")
  static let unanswered = error("Native host didn't answer in time.")

  nonisolated static func manifest(named name: String, in folders: [URL] = folders()) -> [String: Any]? {
    guard isValidName(name), !skipped.contains(name) else { return nil }
    for folder in folders {
      guard let data = try? Data(contentsOf: folder.appendingPathComponent("\(name).json")),
        let manifest = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
        manifest["name"] as? String == name, manifest["type"] as? String == "stdio",
        let path = manifest["path"] as? String, path.hasPrefix("/")
      else { continue }
      return manifest
    }
    return nil
  }

  nonisolated static func allows(_ manifest: [String: Any], extensionId: String) -> Bool {
    (manifest["allowed_origins"] as? [String] ?? []).contains("chrome-extension://\(extensionId)/")
  }

  nonisolated static func frame(_ message: Any) -> Data? {
    guard JSONSerialization.isValidJSONObject([message]),
      let body = try? JSONSerialization.data(withJSONObject: message, options: [.fragmentsAllowed]),
      body.count <= maxOutgoing, let count = UInt32(exactly: body.count)
    else { return nil }
    var length = count.littleEndian
    var data = Data(bytes: &length, count: 4)
    data.append(body)
    return data
  }

  static func unframe(_ buffer: inout Data) throws -> [Any] {
    var messages: [Any] = []
    while buffer.count >= 4 {
      let length = buffer.prefix(4).withUnsafeBytes { Int(UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self))) }
      guard length <= maxIncoming else { throw broken }
      guard buffer.count >= 4 + length else { break }
      let body = buffer.subdata(in: buffer.startIndex + 4..<buffer.startIndex + 4 + length)
      buffer.removeSubrange(buffer.startIndex..<buffer.startIndex + 4 + length)
      guard let message = try? JSONSerialization.jsonObject(with: body, options: [.fragmentsAllowed]) else { throw broken }
      messages.append(message)
    }
    return messages
  }

  let extensionId: String
  private let process = Process()
  private let input = Pipe()
  private let output = Pipe()
  private let writer = DispatchQueue(label: "dev.ardia.webkit.nativeHost.writer")
  private var buffer = Data()
  private var finished = false
  private let onMessage: (Any) -> Void
  private let onExit: (NSError?) -> Void

  private init(extensionId: String, onMessage: @escaping (Any) -> Void, onExit: @escaping (NSError?) -> Void) {
    self.extensionId = extensionId
    self.onMessage = onMessage
    self.onExit = onExit
  }

  deinit {
    output.fileHandleForReading.readabilityHandler = nil
    if process.isRunning { process.terminate() }
  }

  static func launch(_ name: String, extensionId: String, onMessage: @escaping (Any) -> Void, onExit: @escaping (NSError?) -> Void) throws -> WebKitExtensionNativeHost {
    guard let manifest = manifest(named: name), let path = manifest["path"] as? String else { throw notFound }
    guard allows(manifest, extensionId: extensionId) else { throw forbidden }
    let host = WebKitExtensionNativeHost(extensionId: extensionId, onMessage: onMessage, onExit: onExit)
    host.process.executableURL = URL(fileURLWithPath: path)
    host.process.arguments = ["chrome-extension://\(extensionId)/"]
    host.process.currentDirectoryURL = URL(fileURLWithPath: path).deletingLastPathComponent()
    host.process.standardInput = host.input
    host.process.standardOutput = host.output
    host.process.standardError = FileHandle.nullDevice
    _ = fcntl(host.input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)
    host.output.fileHandleForReading.readabilityHandler = { [weak host] handle in
      let chunk = handle.availableData
      guard let host else { return }
      DispatchQueue.main.async { MainActor.assumeIsolated { host.received(chunk) } }
    }
    do {
      try host.process.run()
    } catch {
      ArdiaEvents.emit("webKit.counted", data: ArdiaConsentStamp.begin().onto(["name": "nativeHostFailure"]))
      throw broken
    }
    ArdiaEvents.emit("webKit.counted", data: ArdiaConsentStamp.begin().onto(["name": "nativeHostLaunch"]))
    return host
  }

  private func received(_ chunk: Data) {
    guard !finished else { return }
    if chunk.isEmpty { return finish(Self.exited) }
    buffer.append(chunk)
    do {
      for message in try Self.unframe(&buffer) { onMessage(message) }
    } catch {
      finish(Self.broken)
    }
  }

  @discardableResult
  func send(_ message: Any) -> Bool {
    guard !finished, let data = Self.frame(message) else { return false }
    let handle = input.fileHandleForWriting
    writer.async { [weak self] in
      do {
        try handle.write(contentsOf: data)
      } catch {
        DispatchQueue.main.async { [weak self] in MainActor.assumeIsolated { self?.finish(Self.broken) } }
      }
    }
    return true
  }

  func close() {
    guard !finished else { return }
    finished = true
    output.fileHandleForReading.readabilityHandler = nil
    let handle = input.fileHandleForWriting
    writer.async { try? handle.close() }
    guard process.isRunning else { return }
    process.terminate()
    let pid = process.processIdentifier
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.killDelay) { [process] in
      if process.isRunning { kill(pid, SIGKILL) }
    }
  }

  func finish(_ error: NSError?) {
    guard !finished else { return }
    if error === Self.broken { ArdiaEvents.emit("webKit.counted", data: ArdiaConsentStamp.begin().onto(["name": "nativeHostFailure"])) }
    close()
    onExit(error)
  }
}
