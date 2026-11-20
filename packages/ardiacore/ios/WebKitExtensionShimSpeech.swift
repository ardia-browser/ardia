import AVFoundation

@MainActor
final class WebKitExtensionSpeech: NSObject, AVSpeechSynthesizerDelegate {
  struct Spoken {
    let id: String
    let extensionId: String
    let utterance: AVSpeechUtterance
    let length: Int
    let wantsEvents: Bool
  }

  static let eventTypes = ["start", "end", "word", "pause", "resume"]

  private let synthesizer = AVSpeechSynthesizer()
  private var queue: [Spoken] = []
  private var current: Spoken?
  private let deliver: (_ extensionId: String, _ id: String, _ event: [String: Any]) -> Void

  init(deliver: @escaping (_ extensionId: String, _ id: String, _ event: [String: Any]) -> Void) {
    self.deliver = deliver
    super.init()
    synthesizer.delegate = self
  }

  var isSpeaking: Bool { synthesizer.isSpeaking }

  static func voices() -> [[String: Any]] {
    AVSpeechSynthesisVoice.speechVoices().map { voice in
      ["voiceName": voice.name, "lang": voice.language, "remote": false, "eventTypes": eventTypes]
    }
  }

  func speak(_ text: String, options: [String: Any], id: String, extensionId: String) -> String? {
    let utterance = AVSpeechUtterance(string: text)
    if let name = options["voiceName"] as? String, !name.isEmpty {
      guard let voice = AVSpeechSynthesisVoice.speechVoices().first(where: { $0.name == name }) else { return "Voice not found." }
      utterance.voice = voice
    } else if let lang = options["lang"] as? String, !lang.isEmpty {
      utterance.voice = AVSpeechSynthesisVoice(language: lang)
    }
    let rate = (options["rate"] as? NSNumber)?.floatValue ?? 1
    guard (0.1...10).contains(rate) else { return "Invalid rate." }
    utterance.rate = min(AVSpeechUtteranceMaximumSpeechRate, max(AVSpeechUtteranceMinimumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * rate))
    let pitch = (options["pitch"] as? NSNumber)?.floatValue ?? 1
    guard (0...2).contains(pitch) else { return "Invalid pitch." }
    utterance.pitchMultiplier = min(2, max(0.5, pitch))
    let volume = (options["volume"] as? NSNumber)?.floatValue ?? 1
    guard (0...1).contains(volume) else { return "Invalid volume." }
    utterance.volume = volume
    let spoken = Spoken(id: id, extensionId: extensionId, utterance: utterance, length: (text as NSString).length, wantsEvents: options["__events"] as? Bool ?? false)
    if options["enqueue"] as? Bool != true { stop(interrupting: true) }
    queue.append(spoken)
    if current == nil { next() }
    return nil
  }

  func stop(interrupting: Bool = true) {
    let dropped = queue
    queue.removeAll()
    for spoken in dropped { send(spoken, "cancelled", index: 0) }
    if let current {
      self.current = nil
      send(current, "interrupted", index: 0)
      synthesizer.stopSpeaking(at: .immediate)
    }
  }

  func stop(extensionId: String) {
    queue.removeAll { $0.extensionId == extensionId }
    if current?.extensionId == extensionId { stop() }
  }

  func pause() {
    guard synthesizer.isSpeaking, synthesizer.pauseSpeaking(at: .immediate), let current else { return }
    send(current, "pause", index: 0)
  }

  func resume() {
    guard synthesizer.isPaused, synthesizer.continueSpeaking(), let current else { return }
    send(current, "resume", index: 0)
  }

  private func next() {
    guard current == nil, !queue.isEmpty else { return }
    let spoken = queue.removeFirst()
    current = spoken
    synthesizer.speak(spoken.utterance)
  }

  private func send(_ spoken: Spoken, _ type: String, index: Int, length: Int? = nil) {
    guard spoken.wantsEvents else { return }
    var event: [String: Any] = ["type": type, "charIndex": index]
    if let length { event["length"] = length }
    deliver(spoken.extensionId, spoken.id, event)
  }

  private func spoken(_ utterance: AVSpeechUtterance) -> Spoken? { current?.utterance === utterance ? current : nil }

  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
    MainActor.assumeIsolated {
      guard let spoken = spoken(utterance) else { return }
      send(spoken, "start", index: 0)
    }
  }

  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString characterRange: NSRange, utterance: AVSpeechUtterance) {
    MainActor.assumeIsolated {
      guard let spoken = spoken(utterance) else { return }
      send(spoken, "word", index: characterRange.location, length: characterRange.length)
    }
  }

  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    MainActor.assumeIsolated {
      guard let spoken = spoken(utterance) else { return }
      current = nil
      send(spoken, "end", index: spoken.length)
      next()
    }
  }

  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    MainActor.assumeIsolated {
      guard let spoken = spoken(utterance) else { return }
      current = nil
      send(spoken, "interrupted", index: 0)
      next()
    }
  }
}
