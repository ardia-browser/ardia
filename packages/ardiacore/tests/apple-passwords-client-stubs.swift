import Foundation

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

let client = ApplePasswordsClient.shared
let fakeCode = ProcessInfo.processInfo.environment["ARDIA_FAKE_CODE"] ?? ""
func state() async -> String { await withCheckedContinuation { done in client.status { done.resume(returning: $0) } } }
func begin() async -> ApplePasswordsClient.Outcome { await withCheckedContinuation { done in client.beginPairing { done.resume(returning: $0) } } }
func finish(_ code: String) async -> ApplePasswordsClient.Outcome { await withCheckedContinuation { done in client.finishPairing(code: code) { done.resume(returning: $0) } } }

func killHelper() {
  let kill = Process()
  kill.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
  kill.arguments = ["-9", "-f", ProcessInfo.processInfo.environment["ARDIA_FAKE_DIR"] ?? "no-such-dir"]
  try? kill.run()
  kill.waitUntilExit()
}
