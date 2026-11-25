import AVFoundation
import ExpoModulesCore
import Foundation
import Speech

final class PhoneSpeechRecorder: @unchecked Sendable {
  struct Events: Sendable {
    let text: @Sendable (String, Bool) -> Void
    let level: @Sendable (Double) -> Void
    let failure: @Sendable (String?) -> Void
  }

  static let levelInterval: CFTimeInterval = 0.05
  static let speechDomain = "kAFAssistantErrorDomain"
  static let noSpeechCodes: Set<Int> = [203, 1110]
  static let languageCodes: Set<Int> = [1700]

  private let recognizer: SFSpeechRecognizer
  private let engine = AVAudioEngine()
  private let request = SFSpeechAudioBufferRecognitionRequest()
  private let lock = NSLock()
  private var task: SFSpeechRecognitionTask?
  private var lastLevel: CFTimeInterval = 0
  private var stopped = false

  init(recognizer: SFSpeechRecognizer) {
    self.recognizer = recognizer
  }

  func start(_ events: Events) throws {
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
      try session.setActive(true, options: .notifyOthersOnDeactivation)
      request.shouldReportPartialResults = true
      request.addsPunctuation = false
      if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
      let input = engine.inputNode
      let format = input.outputFormat(forBus: 0)
      let request = request
      input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
        request.append(buffer)
        guard let self, self.shouldSendLevel() else { return }
        events.level(Self.level(of: buffer))
      }
      engine.prepare()
      try engine.start()
    } catch {
      stop()
      throw error
    }
    let made = recognizer.recognitionTask(with: request) { result, error in
      if let result {
        events.text(result.bestTranscription.formattedString, result.isFinal)
      } else if let error {
        events.failure(Self.problem(error))
      }
    }
    lock.withLock { task = made }
  }

  func stop() {
    let running: SFSpeechRecognitionTask? = lock.withLock {
      guard !stopped else { return nil }
      stopped = true
      defer { task = nil }
      return task
    }
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    request.endAudio()
    running?.finish()
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func shouldSendLevel() -> Bool {
    let now = CACurrentMediaTime()
    return lock.withLock {
      guard now - lastLevel >= Self.levelInterval else { return false }
      lastLevel = now
      return true
    }
  }

  static func level(of buffer: AVAudioPCMBuffer) -> Double {
    guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
    var sum: Float = 0
    for index in 0..<Int(buffer.frameLength) { sum += channel[index] * channel[index] }
    let rms = sqrt(sum / Float(buffer.frameLength))
    let decibels = 20 * log10(max(rms, 0.000_01))
    return Double(min(max((decibels + 50) / 45, 0), 1))
  }

  static func problem(_ error: Error) -> String? {
    let error = error as NSError
    guard error.domain == speechDomain else { return "service" }
    if noSpeechCodes.contains(error.code) { return nil }
    if languageCodes.contains(error.code) { return "language" }
    return "service"
  }
}

enum PhoneSpeechAccess {
  static var recognizer: SFSpeechRecognizer? {
    guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else { return nil }
    return recognizer
  }

  static var hasMicrophone: Bool { AVAudioApplication.shared.recordPermission == .granted }

  static var hasRecognition: Bool { SFSpeechRecognizer.authorizationStatus() == .authorized }

  static func request() async -> String {
    guard recognizer != nil else { return "unavailable" }
    let recognition = await withCheckedContinuation { (continuation: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
      SFSpeechRecognizer.requestAuthorization { status in continuation.resume(returning: status) }
    }
    let microphone = await AVAudioApplication.requestRecordPermission()
    return recognition == .authorized && microphone ? "granted" : "denied"
  }
}

public final class SpeechModule: Module {
  private let lock = NSLock()
  private var recorder: PhoneSpeechRecorder?
  private var session = 0
  private var open = true

  public func definition() -> ModuleDefinition {
    Name("ArdiaPhoneSpeech")

    Events("onSpeech")

    OnDestroy {
      self.lock.withLock { self.open = false }
      self.stopRecording()
    }

    AsyncFunction("isAvailable") { () -> Bool in
      PhoneSpeechAccess.recognizer != nil
    }.runOnQueue(.main)

    AsyncFunction("requestAccess") { (promise: Promise) in
      Task { promise.resolve(await PhoneSpeechAccess.request()) }
    }

    AsyncFunction("start") { (id: Int) throws in
      self.stopRecording()
      guard PhoneSpeechAccess.hasMicrophone else { throw PagePayloads.error("ERR_NO_MICROPHONE", "Ardia can't use the microphone") }
      guard PhoneSpeechAccess.hasRecognition else { throw PagePayloads.error("ERR_NO_RECOGNITION", "Ardia isn't allowed to recognize speech") }
      guard let recognizer = PhoneSpeechAccess.recognizer else { throw PagePayloads.error("ERR_NO_RECOGNIZER", "Speech recognition isn't available on this iPhone") }
      let made = PhoneSpeechRecorder(recognizer: recognizer)
      self.lock.withLock {
        self.session = id
        self.recorder = made
      }
      do {
        try made.start(
          PhoneSpeechRecorder.Events(
            text: { [weak self] text, isFinal in self?.send(id, ["type": "text", "session": id, "text": text, "isFinal": isFinal]) },
            level: { [weak self] level in self?.send(id, ["type": "level", "session": id, "level": level]) },
            failure: { [weak self] problem in self?.send(id, ["type": "failure", "session": id, "problem": problem ?? NSNull()]) }
          )
        )
      } catch {
        self.lock.withLock { if self.recorder === made { self.recorder = nil } }
        throw PagePayloads.error("ERR_SPEECH_START", "The microphone couldn't start")
      }
    }.runOnQueue(.main)

    AsyncFunction("stop") {
      self.stopRecording()
    }.runOnQueue(.main)
  }

  private func send(_ id: Int, _ event: [String: Any]) {
    let current = lock.withLock { open && id == session && recorder != nil }
    guard current else { return }
    sendEvent("onSpeech", event)
  }

  private func stopRecording() {
    let running: PhoneSpeechRecorder? = lock.withLock {
      defer { recorder = nil }
      return recorder
    }
    running?.stop()
  }
}
