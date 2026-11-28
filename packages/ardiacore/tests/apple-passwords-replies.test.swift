import Foundation
import Testing

final class LaunchConfig {
  static let shared = LaunchConfig()
  var environmentForChildProcesses: [String: String] { [:] }
}

private struct Hostile {
  let id: String
  let value: Any
}

private let hostile: [Hostile] = {
  let file = ProcessInfo.processInfo.environment["ARDIA_HOSTILE_JSON_FILE"] ?? ""
  let data = (try? Data(contentsOf: URL(fileURLWithPath: file))) ?? Data("[]".utf8)
  let list = (try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])) as? [[String: Any]] ?? []
  return list.map { item in
    if let units = item["units"] as? [Int] {
      let chars = units.map { UInt16(truncatingIfNeeded: $0) }
      return Hostile(id: item["id"] as? String ?? "", value: NSString(characters: chars, length: chars.count))
    }
    return Hostile(id: item["id"] as? String ?? "", value: item["value"] ?? NSNull())
  }
}()

private func fits(_ text: String) -> Bool {
  let units = (text as NSString)
  guard units.length <= ApplePasswordsMatch.savedMax else { return false }
  var i = 0
  while i < units.length {
    let unit = units.character(at: i)
    if unit == 0 || UTF16.isTrailSurrogate(unit) { return false }
    if UTF16.isLeadSurrogate(unit) {
      guard i + 1 < units.length, UTF16.isTrailSurrogate(units.character(at: i + 1)) else { return false }
      i += 1
    }
    i += 1
  }
  return true
}

private func frame(_ body: Data, length: UInt32? = nil) -> Data {
  var size = (length ?? UInt32(body.count)).littleEndian
  var data = Data(bytes: &size, count: 4)
  data.append(body)
  return data
}

@Suite struct ApplePasswordsReplies {
  @Test func `the hostile list arrived`() {
    #expect(hostile.count > 100)
  }

  @Test func `a login name, a site or a password from the helper is used only when it is text that a save would take`() {
    let good = ApplePasswordsReply.entries(["Entries": [["USR": "ada@example.test", "sites": ["example.test"], "PWD": "Not Included"]]])
    #expect(good == [ApplePasswordsEntry(user: "ada@example.test", sites: ["example.test"])], "positive control")
    #expect(ApplePasswordsReply.password(["Entries": [["USR": "ada", "sites": ["example.test"], "PWD": "fixture-pw-ada-1"]]], host: "example.test", user: "ada") == "fixture-pw-ada-1")
    for each in hostile {
      for answer: [String: Any] in [["Entries": [["USR": each.value, "sites": [each.value, "example.test"], "PWD": each.value]]], ["Entries": each.value], ["Entry_0": each.value]] {
        for entry in ApplePasswordsReply.entries(answer) {
          #expect(fits(entry.user), "\(each.id): a login name that a save wouldn't take was kept")
          #expect(entry.sites.allSatisfy(fits), "\(each.id): a site that a save wouldn't take was kept")
        }
        let user = each.value as? String ?? "ada"
        if let password = ApplePasswordsReply.password(answer, host: "example.test", user: user) {
          #expect(fits(password) && !password.isEmpty, "\(each.id): a password that a save wouldn't take was filled")
        }
      }
    }
  }

  @Test func `a list of more entries than Passwords could show is cut, not taken whole`() {
    let many = (0..<5000).map { ["USR": "user\($0)", "sites": ["example.test"]] as [String: Any] }
    #expect(ApplePasswordsReply.entries(["Entries": many]).count == ApplePasswordsReply.entriesMax)
  }

  @Test func `a Verification code entry keeps only text a save would take, and a code only of 4 to 10 letters and digits`() {
    #expect(ApplePasswordsReply.codes(["Entries": [["username": "ada", "domain": "example.test", "code": "135790", "source": "totp"]]]) == [ApplePasswordsCode(user: "ada", domain: "example.test", source: "totp", code: "135790")])
    for each in hostile {
      for code in ApplePasswordsReply.codes(["Entries": [["username": each.value, "domain": each.value, "code": each.value, "source": each.value]]]) {
        #expect(fits(code.user) && fits(code.domain) && fits(code.source), "\(each.id): a code entry's text was kept")
        #expect(code.code.isEmpty || code.code.range(of: "^[A-Za-z0-9]{4,10}$", options: .regularExpression) != nil, "\(each.id): a code that can't be filled was kept")
      }
    }
  }

  @Test func `a frame longer than the pipe's limit ends the read instead of growing without bound`() {
    var buffer = frame(Data(), length: UInt32(ApplePasswordsPipe.maxMessageBytes + 1))
    #expect(ApplePasswordsPipe.frames(&buffer) == nil)
    var nearly = frame(Data(repeating: 0x20, count: 16), length: UInt32(ApplePasswordsPipe.maxMessageBytes))
    #expect(ApplePasswordsPipe.frames(&nearly)?.isEmpty == true, "a frame within the limit waits for the rest")
  }

  @Test func `only a JSON object becomes a message; any other body is dropped and the next frame still reads`() {
    for each in hostile {
      let body = (try? JSONSerialization.data(withJSONObject: each.value, options: [.fragmentsAllowed])) ?? Data(String(describing: each.value).utf8)
      var buffer = frame(body) + frame(Data(#"{"cmd":4}"#.utf8))
      let messages = ApplePasswordsPipe.frames(&buffer) ?? []
      #expect(messages.last?["cmd"] as? Int == 4, "\(each.id): the frame after it was lost")
      #expect(messages.count <= 2 && buffer.isEmpty, "\(each.id)")
    }
    var broken = frame(Data([0xff, 0xfe, 0x00])) + frame(Data(#"{"cmd":2}"#.utf8))
    #expect(ApplePasswordsPipe.frames(&broken)?.map { $0["cmd"] as? Int } == [2])
  }

  @Test func `a Pairing reply whose number or salt is longer than the group's is refused before any arithmetic`() {
    var srp = ApplePasswordsSRP(base64: true)
    let long = Data(repeating: 7, count: 750_000).base64EncodedString()
    for (s, b) in [(long, Data([1, 2, 3]).base64EncodedString()), (Data(repeating: 1, count: 16).base64EncodedString(), long)] {
      let reply = (try! JSONSerialization.data(withJSONObject: ["TID": srp.tid, "MSG": 1, "s": s, "B": b, "PROTO": 1])).base64EncodedString()
      let started = Date()
      #expect(throws: (any Error).self) { _ = try srp.second(after: reply, code: "123456") }
      #expect(Date().timeIntervalSince(started) < 1)
    }
  }

  @Test func `a hostile Pairing reply or sealed message is refused, never a crash or a session`() throws {
    for each in hostile {
      var srp = ApplePasswordsSRP(base64: true)
      let text = each.value as? String ?? String(describing: each.value)
      let wrapped = (try? JSONSerialization.data(withJSONObject: ["TID": srp.tid, "MSG": 1, "s": each.value, "B": each.value, "PROTO": 1])).map { $0.base64EncodedString() } ?? ""
      #expect(throws: (any Error).self, "\(each.id)") { _ = try srp.second(after: text, code: "123456") }
      let started = Date()
      let answered = try? srp.second(after: wrapped, code: "123456")
      #expect(Date().timeIntervalSince(started) < 5, "\(each.id): a Pairing round (about 1.5 s unoptimized when the value is a real number) took \(Date().timeIntervalSince(started)) s")
      if answered != nil, let b = each.value as? String {
        #expect(Data(base64Encoded: b).map { (1...ApplePasswordsSRP.length).contains($0.count) } == true, "\(each.id): only a value the size of the group is taken as the helper's number")
      }
      #expect(throws: (any Error).self, "\(each.id)") { try srp.third(text) }
      #expect(srp.open(each.value) == nil, "\(each.id)")
      #expect(srp.open(["TID": srp.tid, "SDATA": each.value]) == nil, "\(each.id)")
    }
  }
}
