import AppKit
import ExpoModulesCore
import NaturalLanguage
import SwiftUI
@_weakLinked import Translation

@available(macOS 26.0, *)
@MainActor
enum TranslationSessions {
  private static var sessions: [String: TranslationSession] = [:]
  private static var lowLatencyPairs: Set<String> = []
  private static var making: [String: Task<TranslationSession, Never>] = [:]
  private static var standardInstalledPairs: [String: Bool] = [:]
  private static var uses = 0
  private static let idleSeconds = 60.0

  private struct PassageKey: Hashable {
    let source: String
    let target: String
    let pieces: [String]
  }

  private static var memo: [PassageKey: [String]] = [:]
  private static let work = SharedWork<PassageKey, [String]>()
  private static let packWork = SharedWork<[PassageKey], [[String]?]>()
  private static let retryWork = SharedWork<PassageKey, [String]>()
  private static let memoLimit = 5000

  static func translations(source: String, target: String, standard: Bool = false, _ requests: [TranslationSession.Request]) async throws -> [TranslationSession.Response] {
    try await run(source: source, target: target, standard: standard) { try await $0.translations(from: requests) }
  }

  static func translate(source: String, target: String, _ texts: [String]) async throws -> [String?] {
    let requests = texts.enumerated().map { TranslationSession.Request(sourceText: $0.element, clientIdentifier: String($0.offset)) }
    var out: [String?] = texts.map { _ in nil }
    for response in try await translations(source: source, target: target, requests) {
      if let i = response.clientIdentifier.flatMap(Int.init), out.indices.contains(i) { out[i] = response.targetText }
    }
    return out
  }

  static func translateBlocks(source: String, target: String, owner: String, _ blocks: [[String]]) async -> [[String]?] {
    let keys = blocks.map { PassageKey(source: source, target: target, pieces: $0) }
    var found: [PassageKey: [String]] = [:]
    var fresh: [PassageKey] = []
    var seen: Set<PassageKey> = []
    for key in keys where seen.insert(key).inserted {
      if let known = memo[key] { found[key] = known } else { fresh.append(key) }
    }
    let groups = attributedAvailable ? PackedPassages.packs(fresh.map(\.pieces)).map { Array(fresh[$0]) } : fresh.map { [$0] }
    await withTaskGroup(of: [(PassageKey, [String]?)].self) { group in
      for keys in groups { group.addTask { @MainActor in await translateGroup(keys, owner: owner) } }
      for await results in group {
        for case let (key, parts?) in results { found[key] = parts }
      }
    }
    return keys.map { found[$0] }
  }

  private static func translateGroup(_ keys: [PassageKey], owner: String) async -> [(PassageKey, [String]?)] {
    guard keys.count > 1 else { return [(keys[0], await passage(keys[0], owner: owner))] }
    let packed = await packWork.value(for: keys, owner: owner) { await translatePack(keys) } ?? keys.map { _ in nil }
    let answers = await PackedFollowUp.settle(
      keys, packed: packed, owner: owner, work: work, retries: retryWork,
      unchanged: { key, parts in TranslateModule.isUnchanged(parts, from: key.pieces) },
      alone: { key in await translateFresh(key) },
      again: { key, parts in await askAgain(key, parts) })
    for (key, answer) in zip(keys, answers) {
      if let answer, !TranslateModule.isUnchanged(answer, from: key.pieces) { remember(key, answer) }
    }
    return Array(zip(keys, answers))
  }

  private static func translatePack(_ keys: [PassageKey]) async -> [[String]?]? {
    guard #available(macOS 26.4, *), let first = keys.first else { return nil }
    let pieces = keys.map(\.pieces)
    let text = PackedPassages.text(pieces)
    guard let translated = try? await run(source: first.source, target: first.target, { try await $0.translate(text).attributedTargetText })
    else { return nil }
    return PackedPassages.parts(of: translated, over: pieces)
  }

  private static var attributedAvailable: Bool {
    if #available(macOS 26.4, *) { return true }
    return false
  }

  static func open(owner: String) {
    work.open(owner: owner)
    packWork.open(owner: owner)
    retryWork.open(owner: owner)
  }

  static func cancel(owner: String) {
    work.cancel(owner: owner)
    packWork.cancel(owner: owner)
    retryWork.cancel(owner: owner)
  }

  private static func passage(_ key: PassageKey, owner: String) async -> [String]? {
    if let known = memo[key] { return known }
    let parts = await work.value(for: key, owner: owner) { await translateFresh(key) }
    if let parts, !TranslateModule.isUnchanged(parts, from: key.pieces) { remember(key, parts) }
    return parts
  }

  private static func translateFresh(_ key: PassageKey) async -> [String]? {
    let first = await translateOnce(key, standard: false)
    if let first, !TranslateModule.isUnchanged(first, from: key.pieces) { return first }
    return await askAgain(key, first)
  }

  private static func askAgain(_ key: PassageKey, _ first: [String]?) async -> [String]? {
    guard !Task.isCancelled, lowLatencyPairs.contains(pairKey(key.source, key.target)), worthAskingAgain(key.pieces),
      await standardInstalled(source: key.source, target: key.target),
      let again = await translateOnce(key, standard: true)
    else { return first }
    return first == nil || !TranslateModule.isUnchanged(again, from: key.pieces) ? again : first
  }

  private static func translateOnce(_ key: PassageKey, standard: Bool) async -> [String]? {
    await PassageDispatch.translate(
      key.pieces,
      plain: { text in
        try? await run(source: key.source, target: key.target, standard: standard, { try await $0.translate(text).targetText })
      },
      linked: attributedAvailable ? { pieces in
        guard #available(macOS 26.4, *) else { return nil }
        let text = LinkedPieces.text(pieces)
        guard let translated = try? await run(source: key.source, target: key.target, standard: standard, { try await $0.translate(text).attributedTargetText })
        else { return nil }
        return LinkedPieces.parts(of: translated, over: pieces)
      } : nil
    )
  }


  private static func worthAskingAgain(_ pieces: [String]) -> Bool {
    let text = pieces.joined()
    let tokenizer = NLTokenizer(unit: .word)
    tokenizer.string = text
    var words = 0
    tokenizer.enumerateTokens(in: text.startIndex..<text.endIndex) { _, _ in
      words += 1
      return words < 2
    }
    return words >= 2
  }

  private static func standardInstalled(source: String, target: String) async -> Bool {
    let pair = pairKey(source, target)
    if let known = standardInstalledPairs[pair] { return known }
    let installed = await LanguageAvailability().status(from: Locale.Language(identifier: source), to: Locale.Language(identifier: target)) == .installed
    standardInstalledPairs[pair] = installed
    return installed
  }

  private static func pairKey(_ source: String, _ target: String) -> String { "\(source)>\(target)" }

  private static func remember(_ key: PassageKey, _ parts: [String]) {
    if memo.count >= memoLimit { memo.removeAll() }
    memo[key] = parts
  }

  private static func run<T: Sendable>(source: String, target: String, standard: Bool = false, _ work: @escaping @MainActor (TranslationSession) async throws -> T) async throws -> T {
    defer { forgetWhenIdle() }
    let key = standard ? "\(pairKey(source, target))>standard" : pairKey(source, target)
    let session = await session(for: key, source: source, target: target, standard: standard)
    do {
      return try await work(session)
    } catch {
      if sessions[key] === session { sessions[key] = nil }
      throw error
    }
  }

  private static func session(for key: String, source: String, target: String, standard: Bool) async -> TranslationSession {
    if let cached = sessions[key] { return cached }
    if let pending = making[key] { return await pending.value }
    let task = Task { @MainActor in await make(source: source, target: target, standard: standard) }
    making[key] = task
    let made = await task.value
    if making[key] == task { making[key] = nil }
    sessions[key] = made
    return made
  }

  private static func forgetWhenIdle() {
    uses += 1
    let use = uses
    Task { @MainActor in
      try? await Task.sleep(for: .seconds(idleSeconds))
      if uses == use {
        sessions.removeAll()
        standardInstalledPairs.removeAll()
      }
    }
  }

  private static func make(source: String, target: String, standard: Bool) async -> TranslationSession {
    let from = Locale.Language(identifier: source), to = Locale.Language(identifier: target)
    if standard { return TranslationSession(installedSource: from, target: to) }
    if #available(macOS 26.4, *), await LanguageAvailability(preferredStrategy: .lowLatency).status(from: from, to: to) == .installed {
      lowLatencyPairs.insert(pairKey(source, target))
      return TranslationSession(installedSource: from, target: to, preferredStrategy: .lowLatency)
    }
    lowLatencyPairs.remove(pairKey(source, target))
    return TranslationSession(installedSource: from, target: to)
  }
}
