import Foundation

public struct ChatGPTModel: Equatable, Hashable, Sendable, Codable, Identifiable {
  public var slug: String
  public var displayName: String

  public var id: String { slug }

  public init(slug: String, displayName: String) {
    self.slug = slug
    self.displayName = displayName
  }

  public static func catalog(_ data: Data) throws(ChatGPTFailure) -> [ChatGPTModel] {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw .rejected(nil) }
    if let models = object["models"] as? [[String: Any]] {
      return models.compactMap { model in
        guard model["visibility"] as? String == "list",
              let slug = (model["slug"] as? String)?.trimmingCharacters(in: .whitespaces), !slug.isEmpty, slug.count <= 200 else { return nil }
        let name = (model["display_name"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
        return ChatGPTModel(slug: slug, displayName: name.isEmpty ? slug : String(name.prefix(200)))
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
  public static func body(model: String, instructions: String, prompt: String) -> Data {
    let object: [String: Any] = [
      "model": model,
      "instructions": instructions,
      "input": [["role": "user", "content": prompt]],
      "store": false,
      "stream": true,
    ]
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
