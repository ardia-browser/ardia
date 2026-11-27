import AppKit
import Foundation
import NaturalLanguage
@_weakLinked import Translation

public typealias ArdiaTranslateReply = @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<CChar>?) -> Void

enum TranslateText {
  static func isUnchanged(_ parts: [String], from pieces: [String]) -> Bool {
    parts.joined().filter { !$0.isWhitespace } == pieces.joined().filter { !$0.isWhitespace }
  }
}

private func ownedString(_ text: String) -> UnsafeMutablePointer<CChar>? {
  strdup(text)
}

private func encode(_ value: Any) -> String {
  guard JSONSerialization.isValidJSONObject(["v": value]),
    let data = try? JSONSerialization.data(withJSONObject: ["v": value]),
    let text = String(data: data, encoding: .utf8)
  else { return "{\"v\":null}" }
  return text
}

private func failure(_ error: Error) -> String {
  let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
  return encode(["error": message])
}

private func decode(_ text: UnsafePointer<CChar>?) -> [String: Any] {
  guard let text, let data = String(cString: text).data(using: .utf8),
    let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  else { return [:] }
  return object
}

@_cdecl("ardia_translate_free")
public func ardiaTranslateFree(_ text: UnsafeMutablePointer<CChar>?) {
  free(text)
}

@_cdecl("ardia_translate_available")
public func ardiaTranslateAvailable() -> Bool {
  if #available(macOS 26.0, *) { return true }
  return false
}

@_cdecl("ardia_translate_user_languages")
public func ardiaTranslateUserLanguages() -> UnsafeMutablePointer<CChar>? {
  ownedString(encode(Locale.preferredLanguages))
}

@_cdecl("ardia_translate_language_name")
public func ardiaTranslateLanguageName(_ identifier: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
  guard let identifier else { return nil }
  let id = String(cString: identifier)
  return ownedString(Locale(identifier: "en").localizedString(forIdentifier: id) ?? id)
}

@_cdecl("ardia_translate_detect")
public func ardiaTranslateDetect(_ text: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
  guard let text else { return nil }
  let recognizer = NLLanguageRecognizer()
  recognizer.processString(String(cString: text))
  guard let (language, confidence) = recognizer.languageHypotheses(withMaximum: 1).first, confidence >= 0.5 else { return nil }
  return ownedString(language.rawValue)
}

@_cdecl("ardia_translate_call")
public func ardiaTranslateCall(
  _ op: UnsafePointer<CChar>?, _ args: UnsafePointer<CChar>?, _ context: UnsafeMutableRawPointer?, _ reply: ArdiaTranslateReply?
) {
  let name = op.map { String(cString: $0) } ?? ""
  let input = TranslateInput(decode(args))
  let box = ReplyBox(context, reply)
  Task { @MainActor in
    box.send(await run(name, input.value))
  }
}

private final class TranslateInput: @unchecked Sendable {
  let value: [String: Any]
  init(_ value: [String: Any]) { self.value = value }
}

private final class ReplyBox: @unchecked Sendable {
  let context: UnsafeMutableRawPointer?
  let reply: ArdiaTranslateReply?
  init(_ context: UnsafeMutableRawPointer?, _ reply: ArdiaTranslateReply?) {
    self.context = context
    self.reply = reply
  }
  func send(_ text: String) {
    text.withCString { reply?(context, $0) }
  }
}

@MainActor
private func run(_ op: String, _ input: [String: Any]) async -> String {
  let source = input["source"] as? String ?? ""
  let target = input["target"] as? String ?? ""
  let owner = input["owner"] as? String ?? ""
  guard #available(macOS 26.0, *) else {
    return op == "status" ? encode("unsupported") : op == "supportedLanguages" ? encode([String]()) : failure(TranslateError.unavailable)
  }
  switch op {
  case "status":
    switch await LanguageAvailability().status(from: Locale.Language(identifier: source), to: Locale.Language(identifier: target)) {
    case .installed: return encode("installed")
    case .supported: return encode("supported")
    default: return encode("unsupported")
    }
  case "supportedLanguages":
    return encode(await LanguageAvailability().supportedLanguages.map { $0.minimalIdentifier })
  case "prepare":
    do {
      try await DownloadPrompt.run(source: Locale.Language(identifier: source), target: Locale.Language(identifier: target))
      return encode(true)
    } catch {
      return failure(error)
    }
  case "translateBlocks":
    let blocks = (input["blocks"] as? [[String]]) ?? []
    let answers = await TranslationSessions.translateBlocks(source: source, target: target, owner: owner, blocks)
    return encode(answers.map { $0.map { $0 as Any } ?? NSNull() })
  case "open":
    TranslationSessions.open(owner: owner)
    return encode(true)
  case "cancel":
    TranslationSessions.cancel(owner: owner)
    return encode(true)
  default:
    return failure(TranslateError.unavailable)
  }
}
