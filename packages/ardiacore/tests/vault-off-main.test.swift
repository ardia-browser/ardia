import Foundation
import Testing

@Suite("Vault work stays off the main thread")
struct VaultOffMainTests {
  @Test func `vault work on a background thread goes ahead`() async {
    await Task.detached { VaultOffMain.check() }.value
  }

  @Test func `vault work on the main thread stops a debug build`() async {
    await #expect(processExitsWith: .failure) {
      await MainActor.run { VaultOffMain.check() }
    }
  }
}
