import Foundation

public enum RegistrableDomain {
  private struct Rules: Sendable {
    var exact: Set<String> = []
    var wildcard: Set<String> = []
    var exception: Set<String> = []
  }

  private static let rules: Rules = load()

  public static func of(_ host: String) -> String {
    let host = host.lowercased()
    guard !isAddress(host) else { return host }
    let labels = host.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
    guard labels.count > 1 else { return host }
    var suffixLabel = labels.count - 1
    for index in labels.indices {
      let candidate = labels[index...].joined(separator: ".")
      if rules.exception.contains(candidate) {
        suffixLabel = index + 1
        break
      }
      if rules.exact.contains(candidate) {
        suffixLabel = index
        break
      }
      if index + 1 < labels.count, rules.wildcard.contains(labels[(index + 1)...].joined(separator: ".")) {
        suffixLabel = index
        break
      }
    }
    guard suffixLabel > 0 else { return host }
    return labels[(suffixLabel - 1)...].joined(separator: ".")
  }

  private static func isAddress(_ host: String) -> Bool {
    host.hasPrefix("[") || host.allSatisfy { $0 == "." || $0.isASCII && $0.isNumber }
  }

  private static func load() -> Rules {
    var rules = Rules()
    guard let url = Bundle.module.url(forResource: "public_suffix_list", withExtension: "dat"),
          let text = try? String(contentsOf: url, encoding: .utf8) else { return rules }
    for raw in text.split(whereSeparator: \.isNewline) {
      let line = raw.trimmingCharacters(in: .whitespaces).lowercased()
      if line.isEmpty || line.hasPrefix("//") { continue }
      if line.hasPrefix("!") {
        rules.exception.insert(String(line.dropFirst()))
      } else if line.hasPrefix("*.") {
        rules.wildcard.insert(String(line.dropFirst(2)))
      } else {
        rules.exact.insert(line)
      }
    }
    return rules
  }
}
