import AppKit
import ExpoModulesCore
import NaturalLanguage
import SwiftUI
@_weakLinked import Translation

public class TranslateModule: Module, TranslateNative {
  static var available: Bool {
    if #available(macOS 26.0, *) { return true }
    return false
  }

  static func userLanguages() -> [String] { Locale.preferredLanguages }

  static func languageName(_ identifier: String) -> String { Locale(identifier: "en").localizedString(forIdentifier: identifier) ?? identifier }

  static func detect(_ text: String) -> String? {
    let recognizer = NLLanguageRecognizer()
    recognizer.processString(text)
    guard let (language, confidence) = recognizer.languageHypotheses(withMaximum: 1).first, confidence >= 0.5 else { return nil }
    return language.rawValue
  }

  static func status(_ source: String, _ target: String) async -> String {
    guard #available(macOS 26.0, *) else { return "unsupported" }
    switch await LanguageAvailability().status(from: Locale.Language(identifier: source), to: Locale.Language(identifier: target)) {
    case .installed: return "installed"
    case .supported: return "supported"
    default: return "unsupported"
    }
  }

  static func supportedLanguages() async -> [String] {
    guard #available(macOS 26.0, *) else { return [] }
    return await LanguageAvailability().supportedLanguages.map { $0.minimalIdentifier }
  }

  static func prepare(_ source: String, _ target: String) async throws {
    guard #available(macOS 26.0, *) else { throw TranslateError.unavailable }
    try await DownloadPrompt.run(source: Locale.Language(identifier: source), target: Locale.Language(identifier: target))
  }

  static func translateBlocks(_ source: String, _ target: String, _ blocks: [[String]], _ owner: String) async -> [[String]?] {
    guard #available(macOS 26.0, *) else { return blocks.map { _ in nil } }
    return await TranslationSessions.translateBlocks(source: source, target: target, owner: owner, blocks)
  }

  static func `open`(_ owner: String) async {
    guard #available(macOS 26.0, *) else { return }
    await TranslationSessions.open(owner: owner)
  }

  static func cancel(_ owner: String) async {
    guard #available(macOS 26.0, *) else { return }
    await TranslationSessions.cancel(owner: owner)
  }

  static func translate(_ source: String, _ target: String, _ texts: [String]) async throws -> [String?] {
    guard #available(macOS 26.0, *) else { throw TranslateError.unavailable }
    return try await TranslationSessions.translate(source: source, target: target, texts)
  }

  public func definition() -> ModuleDefinition {
    Name(Self.moduleName)

    Self.availableConstant

    Self.userLanguagesFunction

    Self.languageNameFunction

    Self.detectFunction

    Self.statusFunction

    Self.supportedLanguagesFunction

    Self.prepareFunction

    Self.translateBlocksFunction

    Self.openFunction

    Self.cancelFunction

    Self.translateFunction
  }
}

extension TranslateModule {
  static func isUnchanged(_ parts: [String], from pieces: [String]) -> Bool {
    parts.joined().filter { !$0.isWhitespace } == pieces.joined().filter { !$0.isWhitespace }
  }
}
