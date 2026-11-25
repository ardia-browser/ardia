import AVFoundation
import Foundation
import PhononTTS

@MainActor
public final class TalkSpeaker {
  public static let sampleRate = Phonon.sampleRate

  public private(set) var isSpeaking = false
  public private(set) var isPaused = false
  public private(set) var voice: String
  public private(set) var currentBlock = 0
  public private(set) var blocks: [String] = []
  public var voices: [String] { tts.voices }
  public var onFinished: (() -> Void)?
  public var onFirstAudio: ((Duration) -> Void)?
  public var onFailure: ((String) -> Void)?
  public var onUtterance: ((Int, String) -> Void)?
  public var onProgress: ((Double) -> Void)?

  private let tts: Phonon
  private let engine = AVAudioEngine()
  private let node = AVAudioPlayerNode()
  private let timePitch = AVAudioUnitTimePitch()
  private let format: AVAudioFormat
  private var nextBlock = 0
  private var worker: Task<Void, Never>?
  private var scheduledBlocks: [Int] = []
  private var generation = 0
  private var askedAt: ContinuousClock.Instant?
  private var recording: AVAudioFile?
  private var configurationObserver: NSObjectProtocol?
  private var needsRestart = false
  private var requestedVoice: String?
  private var voiceChange: Task<Void, Error>?

  public static func load(models: URL, voice: String?) async throws -> TalkSpeaker {
    let tts = try await Phonon.load(models: models, language: .english)
    let speaker = try TalkSpeaker(tts: tts)
    if let voice, voice != tts.voice, tts.voices.contains(voice) { try await speaker.setVoice(voice) }
    return speaker
  }

  private init(tts: Phonon) throws {
    self.tts = tts
    voice = tts.voice
    guard let format = AVAudioFormat(standardFormatWithSampleRate: Phonon.sampleRate, channels: 1) else {
      throw PhononError(description: "No audio format for Phonon's samples")
    }
    self.format = format
    engine.attach(node)
    engine.attach(timePitch)
    try engine.connectNode(node, to: timePitch, format: format)
    try engine.connectNode(timePitch, to: engine.mainMixerNode, format: format)
    configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.engineChanged() }
    }
  }

  isolated deinit {
    if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
    worker?.cancel()
    node.stop()
    engine.stop()
  }

  public var rate: Float {
    get { timePitch.rate }
    set { timePitch.rate = min(max(newValue, 0.5), 2) }
  }

  public func setVoice(_ name: String) async throws {
    requestedVoice = name
    while let pending = voiceChange { _ = try? await pending.value }
    guard requestedVoice == name, name != voice else { return }
    let change = Task { try await tts.setVoice(name) }
    voiceChange = change
    defer { voiceChange = nil }
    try await change.value
    voice = name
  }

  public func record(to url: URL) throws {
    try? FileManager.default.removeItem(at: url)
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVSampleRateKey: Phonon.sampleRate,
      AVNumberOfChannelsKey: 1,
      AVLinearPCMBitDepthKey: 16,
      AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsBigEndianKey: false,
    ]
    recording = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
  }

  public func finishRecording() {
    guard let recording, recording.length > 0 else { return }
    recording.close()
    self.recording = nil
  }

  public func play(_ texts: [String], from index: Int = 0) {
    halt()
    blocks = texts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    guard index < blocks.count else { return }
    nextBlock = max(index, 0)
    currentBlock = nextBlock
    isSpeaking = true
    isPaused = false
    askedAt = .now
    reportProgress()
    let current = generation
    worker = Task { [weak self] in await self?.drain(generation: current) }
  }

  public func pause() {
    guard isSpeaking, !isPaused else { return }
    isPaused = true
    node.pause()
    engine.pause()
  }

  public func resume() {
    guard isSpeaking, isPaused else { return }
    isPaused = false
    if needsRestart {
      play(blocks, from: currentBlock)
      return
    }
    do {
      if !engine.isRunning { try engine.start() }
      try node.playAudio()
    } catch {
      play(blocks, from: currentBlock)
    }
  }

  public func stop() {
    halt()
    blocks = []
    currentBlock = 0
  }

  private func halt() {
    generation += 1
    worker?.cancel()
    worker = nil
    scheduledBlocks.removeAll()
    askedAt = nil
    needsRestart = false
    isSpeaking = false
    isPaused = false
    node.stop()
  }

  private func engineChanged() {
    guard isSpeaking, !engine.isRunning else { return }
    if isPaused {
      needsRestart = true
    } else {
      play(blocks, from: currentBlock)
    }
  }

  private func drain(generation current: Int) async {
    while current == generation, nextBlock < blocks.count {
      let index = nextBlock
      nextBlock += 1
      onUtterance?(index, blocks[index])
      do {
        try startEngine()
        for try await chunk in tts.stream(blocks[index]) {
          guard current == generation, !Task.isCancelled else { break }
          schedule(chunk, block: index, generation: current)
        }
      } catch {
        guard current == generation, !Task.isCancelled else { return }
        let message = (error as? PhononError)?.description ?? error.localizedDescription
        stop()
        onFailure?(message)
        return
      }
    }
    guard current == generation else { return }
    worker = nil
    settleIfDone()
  }

  private func startEngine() throws {
    guard !isPaused else { return }
    if !engine.isRunning {
      engine.prepare()
      try engine.start()
    }
    if !node.isPlaying, !isPaused { try node.playAudio() }
  }

  private func schedule(_ samples: [Float], block: Int, generation current: Int) {
    guard !samples.isEmpty, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)), let channel = buffer.floatChannelData?[0] else { return }
    buffer.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { source in
      if let base = source.baseAddress { channel.update(from: base, count: samples.count) }
    }
    if let recording { try? recording.write(from: buffer) }
    if let askedAt {
      onFirstAudio?(ContinuousClock.now - askedAt)
      self.askedAt = nil
    }
    if scheduledBlocks.isEmpty, block != currentBlock {
      currentBlock = block
      reportProgress()
    }
    scheduledBlocks.append(block)
    node.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
      Task { @MainActor [weak self] in self?.played(generation: current) }
    }
  }

  private func played(generation current: Int) {
    guard current == generation, !scheduledBlocks.isEmpty else { return }
    scheduledBlocks.removeFirst()
    if let playing = scheduledBlocks.first, playing != currentBlock {
      currentBlock = playing
      reportProgress()
    }
    settleIfDone()
  }

  private func reportProgress() {
    guard !blocks.isEmpty else { return }
    onProgress?(Double(currentBlock) / Double(blocks.count))
  }

  private func settleIfDone() {
    guard isSpeaking, scheduledBlocks.isEmpty, worker == nil, nextBlock >= blocks.count else { return }
    isSpeaking = false
    isPaused = false
    onProgress?(1)
    onFinished?()
  }
}
