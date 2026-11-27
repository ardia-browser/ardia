import Foundation
import Testing

final class LaunchConfig {
  static let shared = LaunchConfig()
  var environmentForChildProcesses: [String: String] { ProcessInfo.processInfo.environment }
  func testValue(_ key: String) -> String? { key == "applePasswordsManifest" ? ProcessInfo.processInfo.environment["ARDIA_FAKE_MANIFEST"] : nil }
}

enum WebKitHub { static let passkeysEntitled = false }

final class ArdiaConsentStamp {
  static func begin() -> ArdiaConsentStamp { ArdiaConsentStamp() }
  func onto(_ data: [String: Any]) -> [String: Any] { data }
}

enum ArdiaEvents { static func emit(_ name: String, data: [String: Any]) {} }

private let client = ApplePasswordsClient.shared
private func state() async -> String { await withCheckedContinuation { done in client.status { done.resume(returning: $0) } } }
private func begin() async -> ApplePasswordsClient.Outcome { await withCheckedContinuation { done in client.beginPairing { done.resume(returning: $0) } } }
private func finish(_ code: String) async -> ApplePasswordsClient.Outcome { await withCheckedContinuation { done in client.finishPairing(code: code) { done.resume(returning: $0) } } }

private func killHelper() {
  let kill = Process()
  kill.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
  kill.arguments = ["-9", "-f", ProcessInfo.processInfo.environment["ARDIA_FAKE_DIR"] ?? "no-such-dir"]
  try? kill.run()
  kill.waitUntilExit()
}

@Suite struct ApplePasswordsClientSessions {
  @Test func `a helper that died while its exit waited in the queue ends its session before the next helper starts`() async throws {
    #expect(await begin() == .awaitingCode)
    #expect(await finish(ProcessInfo.processInfo.environment["ARDIA_FAKE_CODE"] ?? "") == .paired)
    #expect(await state() == "connected")
    try await Task.sleep(for: .seconds(2.5))
    let held = DispatchSemaphore(value: 0)
    client.status { _ in held.wait() }
    let next = Task { await begin() }
    try await Task.sleep(for: .milliseconds(200))
    killHelper()
    try await Task.sleep(for: .seconds(1))
    held.signal()
    _ = await next.value
    #expect(await state() != "connected", "a session whose helper died is never reported connected under the next helper")
    killHelper()
  }
}
