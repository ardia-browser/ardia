import Foundation

public struct ChatGPTModel: Equatable, Hashable, Sendable, Codable, Identifiable {
  public var slug: String
  public var displayName: String
  public var efforts: [String]
  public var defaultEffort: String?

  public var id: String { slug }

  public init(slug: String, displayName: String, efforts: [String] = [], defaultEffort: String? = nil) {
    self.slug = slug
    self.displayName = displayName
    self.efforts = efforts
    self.defaultEffort = defaultEffort
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    slug = try container.decode(String.self, forKey: .slug)
    displayName = try container.decode(String.self, forKey: .displayName)
    efforts = try container.decodeIfPresent([String].self, forKey: .efforts) ?? []
    defaultEffort = try container.decodeIfPresent(String.self, forKey: .defaultEffort)
  }

  static func isEffort(_ value: String) -> Bool {
    !value.isEmpty && value.count <= 20 && value.allSatisfy { $0.isASCII && ($0.isLowercase || $0 == "_") }
  }

  public static func catalog(_ data: Data) throws(ChatGPTFailure) -> [ChatGPTModel] {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw .rejected(nil) }
    if let models = object["models"] as? [[String: Any]] {
      return models.compactMap { model in
        guard model["visibility"] as? String == "list",
              let slug = (model["slug"] as? String)?.trimmingCharacters(in: .whitespaces), !slug.isEmpty, slug.count <= 200 else { return nil }
        let name = (model["display_name"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
        let levels = (model["supported_reasoning_levels"] as? [[String: Any]] ?? []).compactMap { $0["effort"] as? String }.filter(isEffort)
        let efforts = Array(levels.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }.prefix(8))
        let usual = (model["default_reasoning_level"] as? String).flatMap { efforts.contains($0) ? $0 : nil }
        return ChatGPTModel(slug: slug, displayName: name.isEmpty ? slug : String(name.prefix(200)), efforts: efforts, defaultEffort: usual)
      }
    }
    if let models = object["data"] as? [[String: Any]] {
      return models.compactMap { model in
        guard let id = model["id"] as? String, !id.isEmpty else { return nil }
        return ChatGPTModel(slug: id, displayName: id)
      }
    }
    throw .rejected(nil)
  }
}

public enum ChatGPTResponses {
  public static func body(model: String, instructions: String, prompt: String, effort: String? = nil) -> Data {
    var object: [String: Any] = [
      "model": model,
      "instructions": instructions,
      "input": [["role": "user", "content": prompt]],
      "store": false,
      "stream": true,
    ]
    if let effort { object["reasoning"] = ["effort": effort] }
    return (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
  }

  public enum Event: Equatable, Sendable {
    case delta(String)
    case completed
    case failed(ChatGPTFailure)
    case incomplete
    case ignored
  }

  public static func event(_ payload: String, status: Int?) -> Event {
    guard let data = payload.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let type = object["type"] as? String else { return .ignored }
    switch type {
    case "response.output_text.delta":
      return (object["delta"] as? String).map(Event.delta) ?? .ignored
    case "response.completed":
      return .completed
    case "response.incomplete":
      return .incomplete
    case "response.failed", "error":
      return .failed(ChatGPTFailure.api(data, status: status))
    default:
      return .ignored
    }
  }
}

public struct ServerSentEvents: Sendable {
  private var data: [String] = []

  public init() {}

  public mutating func feed(_ line: String) -> String? {
    if line.isEmpty {
      defer { data = [] }
      return data.isEmpty ? nil : data.joined(separator: "\n")
    }
    if line.hasPrefix(":") { return nil }
    guard line.hasPrefix("data:") else { return nil }
    var value = line.dropFirst(5)
    if value.first == " " { value = value.dropFirst() }
    data.append(String(value))
    let joined = data.joined(separator: "\n")
    guard joined == "[DONE]" || (try? JSONSerialization.jsonObject(with: Data(joined.utf8))) != nil else { return nil }
    data = []
    return joined
  }

  public mutating func finish() -> String? { feed("") }
}
