import ArdiaBrowser
import Foundation
import FoundationModels
import Observation

@MainActor
@Observable
final class ResearchSession: Identifiable {
  enum Phase: Equatable {
    case searching
    case reading(done: Int, total: Int)
    case writing
    case done
    case failed(String)
  }

  enum Writer: Equatable {
    case chatGPT(model: String)
    case onDevice(fallback: String?)
    case excerpts(reason: String)
  }

  static let responseTokens = 650
  static let instructionTokens = 260
  static let charactersPerToken = 3
  static let readConcurrency = 3
  static let chatGPTCharacterBudget = 24_000

  struct PageRead: Sendable {
    var index: Int
    var content: ReadableContent?
  }

  let id = UUID()
  let query: String
  let forcesExcerpts: Bool
  let chatGPT: ChatGPTAccount?
  private(set) var phase: Phase = .searching
  private(set) var links: [ResearchLink] = []
  private(set) var sources: [ResearchSource] = []
  private(set) var answer = ""
  private(set) var writer: Writer?
  let readAloud = ReadAloud()

  @ObservationIgnored private var task: Task<Void, Never>?
  @ObservationIgnored private let loader: ResearchPageLoader

  init(query: String, forcesExcerpts: Bool = false, chatGPT: ChatGPTAccount? = nil, blocker: ContentBlocker? = nil) {
    self.query = query
    loader = ResearchPageLoader(blocker: blocker)
    self.forcesExcerpts = forcesExcerpts
    self.chatGPT = chatGPT
  }

  var isFinished: Bool {
    switch phase {
    case .done, .failed: true
    default: false
    }
  }

  func start() {
    guard task == nil else { return }
    task = Task { await run() }
  }

  func retry() {
    task?.cancel()
    task = nil
    phase = .searching
    links = []
    sources = []
    answer = ""
    writer = nil
    readAloud.reset()
    start()
  }

  func rewrite() {
    guard !sources.isEmpty, isFinished else { return retry() }
    task?.cancel()
    answer = ""
    writer = nil
    readAloud.reset()
    phase = .writing
    task = Task {
      do {
        try await write()
        try Task.checkCancellation()
        finish()
      } catch {}
    }
  }

  func cancel() {
    task?.cancel()
    task = nil
    readAloud.stop()
  }

  func source(_ number: Int) -> ResearchSource? {
    sources.first { $0.id == number }
  }

  private func run() async {
    do {
      links = try await loader.searchLinks(for: query)
      try Task.checkCancellation()
      guard !links.isEmpty else {
        phase = .failed(String(localized: "Couldn’t find pages for this search."))
        return
      }
      sources = try await readSources(links)
      guard !sources.isEmpty else {
        phase = .failed(String(localized: "Couldn’t read any of the pages for this search."))
        return
      }
      phase = .writing
      try await write()
      try Task.checkCancellation()
      finish()
    } catch is CancellationError {
    } catch {
      phase = .failed(String(localized: "Couldn’t reach the web. Check your connection and try again."))
    }
  }

  private func finish() {
    if case .failed = phase { return }
    phase = .done
    readAloud.answerReady(ResearchAnswer.spoken(answer))
  }

  private func readSources(_ links: [ResearchLink]) async throws -> [ResearchSource] {
    let wanted = min(ResearchSearch.resultLimit, links.count)
    phase = .reading(done: 0, total: wanted)
    var pages: [Int: ReadableContent] = [:]
    let loader = loader
    let concurrency = Self.readConcurrency
    await withTaskGroup(of: PageRead.self) { group in
      var next = 0
      var inFlight = 0
      func schedule() {
        while next < links.count, inFlight < concurrency, pages.count + inFlight < wanted {
          let index = next
          let link = links[index]
          group.addTask { PageRead(index: index, content: await loader.read(link)) }
          next += 1
          inFlight += 1
        }
      }
      schedule()
      while let read = await group.next() {
        inFlight -= 1
        if let content = read.content, Self.isReadable(content) { pages[read.index] = content }
        phase = .reading(done: min(pages.count, wanted), total: wanted)
        schedule()
      }
    }
    try Task.checkCancellation()
    var sources: [ResearchSource] = []
    for (index, link) in links.enumerated() {
      guard let page = pages[index] else { continue }
      let host = link.url.host()?.replacingOccurrences(of: "www.", with: "") ?? link.url.absoluteString
      sources.append(ResearchSource(
        id: sources.count + 1,
        url: link.url,
        title: page.title.isEmpty ? link.title : page.title,
        siteName: page.siteName.isEmpty ? host : page.siteName,
        paragraphs: page.paragraphs
      ))
    }
    return sources
  }

  static func isReadable(_ content: ReadableContent) -> Bool {
    content.paragraphs.reduce(0) { $0 + $1.count } >= ResearchDigest.minimumSourceCharacters
  }

  private func write() async throws {
    let model = SystemLanguageModel.default
    if forcesExcerpts {
      quoteSources(reason: String(localized: "Showing the most relevant lines from the pages."))
      return
    }
    var fallback: String?
    if let chatGPT, chatGPT.isConnected {
      do {
        let prompt = ResearchDigest.prompt(query: query, sources: sources, characterBudget: Self.chatGPTCharacterBudget)
        let used = try await chatGPT.streamAnswer(instructions: ResearchDigest.instructions, prompt: prompt) { answer = $0 }
        writer = .chatGPT(model: used.displayName)
        return
      } catch is CancellationError {
        throw CancellationError()
      } catch {
        try Task.checkCancellation()
        answer = ""
        fallback = (error as? ChatGPTFailure ?? .network).message
      }
    }
    guard case .available = model.availability else {
      quoteSources(reason: [fallback, Self.unavailableReason(model.availability)].compactMap(\.self).joined(separator: " "))
      return
    }
    let budget = max((model.contextSize - Self.responseTokens - Self.instructionTokens) * Self.charactersPerToken, 2000)
    for share in [budget, budget / 2] {
      do {
        try await stream(model: model, characterBudget: share)
        writer = .onDevice(fallback: fallback)
        return
      } catch is CancellationError {
        throw CancellationError()
      } catch {
        answer = ""
      }
    }
    quoteSources(reason: [fallback, String(localized: "Apple Intelligence couldn’t answer this one, so here are the most relevant lines from the pages.")].compactMap(\.self).joined(separator: " "))
  }

  private func stream(model: SystemLanguageModel, characterBudget: Int) async throws {
    let session = LanguageModelSession(model: model, instructions: ResearchDigest.instructions)
    let prompt = ResearchDigest.prompt(query: query, sources: sources, characterBudget: characterBudget)
    let options = GenerationOptions(temperature: 0.3, maximumResponseTokens: Self.responseTokens)
    for try await snapshot in session.streamResponse(to: prompt, options: options) {
      try Task.checkCancellation()
      answer = snapshot.content
    }
  }

  private func quoteSources(reason: String) {
    answer = ResearchDigest.extractiveAnswer(query: query, sources: sources)
    if answer.isEmpty { phase = .failed(String(localized: "Couldn’t read any of the pages for this search.")) }
    writer = .excerpts(reason: reason)
  }

  static func unavailableReason(_ availability: SystemLanguageModel.Availability) -> String {
    switch availability {
    case .unavailable(.appleIntelligenceNotEnabled):
      String(localized: "Turn on Apple Intelligence in Settings for a written answer. Until then, here are the most relevant lines from the pages.")
    case .unavailable(.modelNotReady):
      String(localized: "Apple Intelligence is still downloading. Until it’s ready, here are the most relevant lines from the pages.")
    default:
      String(localized: "This iPhone can’t run Apple Intelligence, so here are the most relevant lines from the pages.")
    }
  }
}
