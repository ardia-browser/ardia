import Foundation
import Testing
@testable import ArdiaBrowser

struct SpokenAnswerTests {
  @Test func cleaningDropsCitationsLinksAndMarkdown() {
    let answer = """
      ## The **Golden Gate** Bridge
      It opened in 1937 [1][2] and spans 1,280 m [3, 4].
      - Designed by *Joseph Strauss* [2]
      1. Painted `International Orange` [5]
      See [the history](https://example.com/history) for more.
      Key facts:
      """
    #expect(SpokenAnswer.text(answer) == """
      The Golden Gate Bridge.
      It opened in 1937 and spans 1,280 m.
      Designed by Joseph Strauss.
      Painted International Orange.
      See the history for more.
      Key facts.
      """)
  }

  @Test func aLineWithNoEndGetsAFullStop() {
    #expect(SpokenAnswer.text("Everest is tall [1]. It was first climbed in 1953.") == "Everest is tall. It was first climbed in 1953.")
    #expect(SpokenAnswer.text("A partial line with no end") == "A partial line with no end.")
    #expect(SpokenAnswer.text("Dr. Smith paid 3.5 million vs. the plan") == "Dr. Smith paid 3.5 million vs. the plan.")
  }

  @Test func blocksAreTheCleanedLinesInOrder() {
    #expect(SpokenAnswer.blocks("## History\nThe bridge opened in 1937 [1].\n\n- Orange [2]") == ["History.", "The bridge opened in 1937.", "Orange."])
    #expect(SpokenAnswer.blocks("  \n") == [])
  }

  @Test func languageGateWaitsForEnoughTextThenDecides() {
    #expect(SpokenAnswer.language(of: "Short.") == .undecided)
    #expect(SpokenAnswer.language(of: "The Golden Gate Bridge opened in 1937 and is painted orange.") == .english)
    #expect(SpokenAnswer.language(of: "Le pont du Golden Gate a été inauguré en 1937 et il est peint en orange.") == .other("fr"))
    #expect(!SpokenAnswer.isReadable("Der Eiffelturm wurde 1889 für die Weltausstellung in Paris gebaut. Er ist hoch."))
    #expect(SpokenAnswer.isReadable("The Golden Gate Bridge opened in 1937 [1]. It is painted orange."))
    #expect(SpokenAnswer.isReadable("Yes [1]."))
    #expect(SpokenAnswer.isReadable("Café au lait, naïve résumé."))
    #expect(!SpokenAnswer.isReadable("東京は日本の首都です。"))
    #expect(!SpokenAnswer.isReadable("Москва — столица."))
    #expect(!SpokenAnswer.isReadable("[1]"))
  }

  @Test func proximityScriptReadsTimesAndStates() throws {
    let script = try #require(ProximityScript("6:far, 2:near ,9:1,bogus,10:sideways"))
    #expect(script.steps == [.init(after: 2, isNear: true), .init(after: 6, isNear: false), .init(after: 9, isNear: true)])
    #expect(ProximityScript("") == nil)
    #expect(ProximityScript("x:near") == nil)
  }

  @Test func holdingToTheEarBeforeTheAnswerStartsItWhenReady() {
    var listening = EarListening()
    #expect(listening.proximity(isNear: true) == .none)
    #expect(listening.answerReady() == .start(.earpiece))
    #expect(listening.state == .playing(.earpiece))
  }

  @Test func aReadyAnswerWaitsForTheEarOrTheSpeakerButton() {
    var listening = EarListening()
    #expect(listening.answerReady() == .none)
    #expect(listening.state == .waiting)
    #expect(listening.answerReady() == .none)
  }

  @Test func loweringThePhonePausesAndRaisingItResumes() {
    var listening = EarListening()
    _ = listening.answerReady()
    #expect(listening.proximity(isNear: true) == .start(.earpiece))
    #expect(listening.proximity(isNear: true) == .none)
    #expect(listening.proximity(isNear: false) == .pause)
    #expect(listening.state == .paused(.earpiece))
    #expect(listening.proximity(isNear: true) == .resume(.earpiece))
    listening.finished()
    #expect(listening.proximity(isNear: false) == .none)
    #expect(listening.proximity(isNear: true) == .start(.earpiece))
  }

  @Test func speakerPlaybackSurvivesLoweringAndMovesToTheEar() {
    var listening = EarListening()
    #expect(listening.toggleSpeaker() == .none)
    _ = listening.answerReady()
    #expect(listening.toggleSpeaker() == .start(.speaker))
    #expect(listening.proximity(isNear: false) == .none)
    #expect(listening.proximity(isNear: true) == .reroute(.earpiece))
    #expect(listening.toggleSpeaker() == .reroute(.speaker))
    #expect(listening.toggleSpeaker() == .pause)
    #expect(listening.toggleSpeaker() == .resume(.speaker))
  }

  @Test func aFailedEarpieceRouteLeavesSpeechPaused() {
    var listening = EarListening()
    _ = listening.answerReady()
    #expect(listening.proximity(isNear: true) == .start(.earpiece))
    listening.routeFailed()
    #expect(listening.state == .paused(.earpiece))
    #expect(listening.proximity(isNear: false) == .none)
    #expect(listening.proximity(isNear: true) == .resume(.earpiece))
  }

  @Test func aNewAnswerWaitsAgain() {
    var listening = EarListening()
    _ = listening.answerReady()
    _ = listening.toggleSpeaker()
    listening.reset()
    #expect(listening.state == .waiting)
    #expect(listening.toggleSpeaker() == .none)
  }
}
