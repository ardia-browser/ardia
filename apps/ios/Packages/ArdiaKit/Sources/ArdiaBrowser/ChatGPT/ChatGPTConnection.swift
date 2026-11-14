import Foundation

public struct ChatGPTConnection: Codable, Equatable, Sendable {
  public var clientID: String
  public var identity: ChatGPTIdentity
  public var tokens: ChatGPTTokens
  public var endpoints: ChatGPTEndpoints
  public var models: [ChatGPTModel]
  public var chosenModel: String?

  public init(clientID: String, identity: ChatGPTIdentity, tokens: ChatGPTTokens, endpoints: ChatGPTEndpoints, models: [ChatGPTModel] = [], chosenModel: String? = nil) {
    self.clientID = clientID
    self.identity = identity
    self.tokens = tokens
    self.endpoints = endpoints
    self.models = models
    self.chosenModel = chosenModel
  }

  public var model: ChatGPTModel? {
    models.first { $0.slug == chosenModel } ?? models.first
  }

  public mutating func refreshed(with next: ChatGPTTokens, now: Date = .now) throws(ChatGPTFailure) {
    if let idToken = next.idToken {
      let identity = try ChatGPTIdentity.verify(idToken: idToken, issuer: endpoints.issuer, clientID: clientID, nonce: nil, now: now)
      guard identity.subject == self.identity.subject else { throw .accountMismatch }
      self.identity = identity
    }
    tokens = next
  }
}
