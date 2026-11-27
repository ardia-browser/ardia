import Foundation
import Testing

@Suite struct ApplePasswordsClientSessions {
  @Test func `a helper that died while its exit waited in the queue ends its session before the next helper starts`() async throws {
    #expect(await begin() == .awaitingCode)
    #expect(await finish(fakeCode) == .paired)
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
