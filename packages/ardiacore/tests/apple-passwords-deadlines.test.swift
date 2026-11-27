import Foundation
import Testing

private func openPipes() -> Int {
  (0..<getdtablesize()).filter { fd in
    var info = stat()
    return fstat(fd, &info) == 0 && info.st_mode & S_IFMT == S_IFIFO
  }.count
}

private func logins(_ host: String) async -> Result<[ApplePasswordsEntry], ApplePasswordsClient.Problem> {
  await withCheckedContinuation { done in client.logins(host: host) { done.resume(returning: $0) } }
}

@Suite struct ApplePasswordsClientDeadlines {
  @Test func `answered requests leave no deadline holding a dead helper's pipe`() async throws {
    let before = openPipes()
    #expect(await begin() == .awaitingCode)
    #expect(await finish(fakeCode) == .paired)
    #expect((try? await logins("example.localhost").get())?.isEmpty == false)
    #expect(openPipes() > before, "the live helper holds its pipe")
    try await Task.sleep(for: .seconds(2.5))
    killHelper()
    try await Task.sleep(for: .seconds(1.5))
    #expect(await state() == "notConnected")
    #expect(openPipes() == before, "no deadline of an answered request keeps the dead helper's pipe open")
  }
}
