import Foundation
import Testing

struct EngineReplyErrorTests {
  @Test func compactEnvelopeIsAnError() {
    #expect(EngineReplyError.message(#"{"error":"x"}"#) == "x")
  }

  @Test func spacedEnvelopeIsAnError() {
    #expect(EngineReplyError.message("  \n{ \"error\" \t: \"x\" }") == "x")
  }

  @Test func nonStringErrorIsDescribed() {
    #expect(EngineReplyError.message(#"{"error":3}"#) == "3")
  }

  @Test func errorInsideTheBodyIsNotAnError() {
    let rows = (0..<50_000).map { i in #"{"t":"error","u":"https://example.com/\#(i)","v":{"error":"\"error\""}}"# }
    let reply = #"{"entries":["# + rows.joined(separator: ",") + "]}"
    let started = Date()
    #expect(EngineReplyError.message(reply) == nil)
    #expect(Date().timeIntervalSince(started) < 0.05)
  }

  @Test func brokenReplyWithANestedErrorIsNotAnError() {
    #expect(EngineReplyError.message(#"{"items":[{"error":"x"}]"#) == nil)
    #expect(EngineReplyError.message(#"[{"error":"x"}"#) == nil)
  }

  @Test func otherShapesAreNotErrors() {
    #expect(EngineReplyError.message(#"{"ok":true}"#) == nil)
    #expect(EngineReplyError.message(#"{"errors":["x"]}"#) == nil)
    #expect(EngineReplyError.message(#"["error"]"#) == nil)
    #expect(EngineReplyError.message(#""error""#) == nil)
    #expect(EngineReplyError.message("") == nil)
  }

  @Test func brokenEnvelopeSaysSo() {
    #expect(EngineReplyError.message(#"{"error":"#) == "the engine's reply isn't JSON")
  }
}
