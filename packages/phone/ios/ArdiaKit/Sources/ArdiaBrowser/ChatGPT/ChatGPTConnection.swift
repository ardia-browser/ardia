import Foundation

public struct ChatGPTConnection: Codable, Equatable, Sendable {
  public var clientID: String
  public var identity: ChatGPTIdentity
  public var tokens: ChatGPTTokens
  public var endpoints: ChatGPTEndpoints
  public var models: [ChatGPTModel]
  public var chosenModel: String?
  public var chosenEffort: String?

  public init(clientID: String, identity: ChatGPTIdentity, tokens: ChatGPTTokens, endpoints: ChatGPTEndpoints, models: [ChatGPTModel] = [], chosenModel: String? = nil, chosenEffort: String? = nil) {
    self.clientID = clientID
    self.identity = identity
    self.tokens = tokens
    self.endpoints = endpoints
    self.models = models
    self.chosenModel = chosenModel
    self.chosenEffort = chosenEffort
  }

  public var effort: String? {
    guard let chosenEffort, model?.efforts.contains(chosenEffort) == true else { return nil }
    return chosenEffort
  }

  public var model: ChatGPTModel? {
    models.first { $0.slug == chosenModel } ?? models.first
  }

  public mutating func confirm(_ identity: ChatGPTIdentity) throws(ChatGPTFailure) {
    guard identity.subject == self.identity.subject else { throw .accountMismatch }
    self.identity = identity
  }
}
