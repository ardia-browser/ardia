import ArdiaBrowser
import Foundation

extension ChatGPTAccount {
  static let maximumAnswerCharacters = 64 * 1024
  static let maximumErrorBytes = 64 * 1024

  func streamAnswer(instructions: String, prompt: String, onText: (String) -> Void) async throws -> ChatGPTModel {
    let model = try await currentModel()
    var connection = try await validConnection()
    for attempt in 0..<2 {
      do {
        try await stream(connection: connection, model: model, instructions: instructions, prompt: prompt, onText: onText)
        return model
      } catch ChatGPTFailure.rejected(401) where attempt == 0 {
        connection = try await validConnection(forceRefresh: true)
      } catch let failure as ChatGPTFailure {
        failed(failure)
        throw failure
      }
    }
    throw ChatGPTFailure.rejected(401)
  }

  private func stream(connection: ChatGPTConnection, model: ChatGPTModel, instructions: String, prompt: String, onText: (String) -> Void) async throws {
    var request = URLRequest(url: connection.endpoints.api.appending(path: "responses"), timeoutInterval: 180)
    request.httpMethod = "POST"
    request.setValue("Bearer \(connection.tokens.accessToken)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    request.httpBody = ChatGPTResponses.body(model: model.slug, instructions: instructions, prompt: prompt)
    let bytes: URLSession.AsyncBytes
    let status: Int
    do {
      let (stream, response) = try await ChatGPTHTTP.session.bytes(for: request)
      bytes = stream
      status = (response as? HTTPURLResponse)?.statusCode ?? 0
    } catch {
      try Task.checkCancellation()
      throw ChatGPTFailure.network
    }
    guard status == 200 else {
      var body = Data()
      for try await byte in bytes {
        body.append(byte)
        if body.count >= Self.maximumErrorBytes { break }
      }
      throw ChatGPTFailure.api(body, status: status)
    }
    var events = ServerSentEvents()
    var text = ""
    do {
      for try await line in bytes.lines {
        try Task.checkCancellation()
        guard let payload = events.feed(line) else { continue }
        switch ChatGPTResponses.event(payload, status: status) {
        case .delta(let delta):
          text += delta
          guard text.count <= Self.maximumAnswerCharacters else { throw ChatGPTFailure.streamInterrupted }
          onText(text)
        case .completed:
          return
        case .failed(let failure):
          throw failure
        case .incomplete:
          throw ChatGPTFailure.streamInterrupted
        case .ignored:
          break
        }
      }
    } catch let failure as ChatGPTFailure {
      throw failure
    } catch {
      try Task.checkCancellation()
      throw ChatGPTFailure.streamInterrupted
    }
    try Task.checkCancellation()
    throw ChatGPTFailure.streamInterrupted
  }
}
