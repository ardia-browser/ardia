import Foundation
import Testing

private let fakeDir = URL(fileURLWithPath: ProcessInfo.processInfo.environment["ARDIA_FAKE_DIR"] ?? "")

private func setMode(_ mode: [String: Any]) throws {
  try JSONSerialization.data(withJSONObject: mode).write(to: fakeDir.appendingPathComponent("mode.json"))
}

private func lines(_ name: String) -> [[String: Any]] {
  let text = (try? String(contentsOf: fakeDir.appendingPathComponent(name), encoding: .utf8)) ?? ""
  return text.split(separator: "\n").compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
}

private func stored(_ user: String) -> Bool {
  let data = (try? Data(contentsOf: fakeDir.appendingPathComponent("fixtures.json"))) ?? Data()
  let logins = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["logins"] as? [[String: Any]] ?? []
  return logins.contains { $0["user"] as? String == user }
}

private func save(_ host: String, _ user: String, _ password: String) async -> Result<Void, ApplePasswordsClient.Problem> {
  await withCheckedContinuation { done in client.save(host: host, user: user, password: password, update: false) { done.resume(returning: $0) } }
}

@Suite(.serialized) struct ApplePasswordsClientSaves {
  @Test func `a save names the page by its bare host and its reply never says whether the user saved`() async throws {
    #expect(await begin() == .awaitingCode)
    #expect(await finish(fakeCode) == .paired)

    try setMode(["saveChoice": "notNow"])
    #expect((try? await save("plain.localhost", "declined@save.test", "fixture-pw-declined-1").get()) != nil, "Not Now in the helper's window answers STATUS 0")
    #expect(!stored("declined@save.test"), "Not Now stores nothing")

    try setMode(["saveChoice": "save"])
    #expect((try? await save("plain.localhost", "taken@save.test", "fixture-pw-taken-2").get()) != nil, "Save Password answers the same")
    #expect(stored("taken@save.test"))

    let sent = lines("requests.jsonl").filter { $0["cmd"] as? Int == ApplePasswordsClient.saveCmd }.compactMap { $0["host"] as? String }
    #expect(sent == ["plain.localhost", "plain.localhost"], "NURL is the bare host, as Apple's extension sends it")
    #expect(lines("asked.jsonl").map { $0["choice"] as? String } == ["notNow", "save"])
  }
}
