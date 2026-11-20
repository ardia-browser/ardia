struct ArdiaVaultProfiles: Sendable, Equatable {
  private(set) var names: Set<String> = []

  @discardableResult
  mutating func replace(with profiles: [String]) -> Bool {
    let next = Set(profiles)
    guard next != names else { return false }
    names = next
    return true
  }

  func serves(_ profile: String, base: String) -> Bool {
    names.contains(profile) || names.contains(base)
  }

  func backedUp(loaded: [String], isPrivate: (String) -> Bool) -> [String] {
    loaded.filter { !isPrivate($0) && names.contains($0) }
  }
}
