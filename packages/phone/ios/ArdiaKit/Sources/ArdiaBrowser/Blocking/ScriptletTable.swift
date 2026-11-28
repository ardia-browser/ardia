import Foundation

public struct ScriptletTable: Codable, Equatable, Sendable {
  var bodies: [[String]] = []
  var hosts: [String: [Int]] = [:]
  var exceptions: [String: [Int]] = [:]

  enum Filter: Equatable {
    case run(hosts: [String], excluded: [String], body: [String])
    case exception(hosts: [String], body: [String])
    case skip
  }

  static let supported: [String: String] = [
    "trusted-replace-argument": "trusted-replace-argument",
    "trusted-ra": "trusted-replace-argument",
  ]

  static func trusts(listID: String) -> Bool { listID.hasPrefix("ublock-") }

  var isEmpty: Bool { hosts.isEmpty }

  private mutating func index(of body: [String]) -> Int {
    if let found = bodies.firstIndex(of: body) { return found }
    bodies.append(body)
    return bodies.count - 1
  }

  mutating func add(_ body: [String], on hosts: [String]) {
    let at = index(of: body)
    for host in hosts where !(self.hosts[host]?.contains(at) ?? false) { self.hosts[host, default: []].append(at) }
  }

  mutating func except(_ body: [String], on hosts: [String]) {
    let at = index(of: body)
    for host in hosts where !(exceptions[host]?.contains(at) ?? false) { exceptions[host, default: []].append(at) }
  }

  mutating func merge(_ other: ScriptletTable) {
    for (host, indices) in other.hosts.sorted(by: { $0.key < $1.key }) { for at in indices { add(other.bodies[at], on: [host]) } }
    for (host, indices) in other.exceptions.sorted(by: { $0.key < $1.key }) { for at in indices { except(other.bodies[at], on: [host]) } }
  }

  func bodies(forHost host: String?) -> [[String]] {
    guard let host = host?.lowercased(), !host.isEmpty else { return [] }
    let suffixes = FilterListConverter.suffixes(of: host).map(String.init)
    let excepted = suffixes.flatMap { exceptions[$0] ?? [] }.map { bodies[$0] }
    if excepted.contains([]) { return [] }
    var result: [[String]] = []
    for body in suffixes.flatMap({ hosts[$0] ?? [] }).map({ bodies[$0] }) where !excepted.contains(body) && !result.contains(body) { result.append(body) }
    return result
  }

  var script: String? {
    guard !isEmpty else { return nil }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(self) else { return nil }
    return BlockingScripts.scriptlets + "(" + String(decoding: data, as: UTF8.self) + ");"
  }

  static func parse(_ line: String, trusted: Bool) -> Filter? {
    let isException: Bool
    let marker: Range<String.Index>
    if let found = line.range(of: "#@#+js(") {
      isException = true
      marker = found
    } else if let found = line.range(of: "##+js(") {
      isException = false
      marker = found
    } else {
      return nil
    }
    guard line.hasSuffix(")") else { return .skip }
    var hosts: [String] = []
    var excluded: [String] = []
    for part in line[..<marker.lowerBound].split(separator: ",") {
      let entry = part.trimmingCharacters(in: .whitespaces)
      let negative = entry.hasPrefix("~")
      guard let domain = FilterListConverter.normalizeDomain(negative ? String(entry.dropFirst()) : entry) else {
        if negative { return .skip }
        continue
      }
      if negative { excluded.append(domain) } else { hosts.append(domain) }
    }
    guard !hosts.isEmpty, !isException || excluded.isEmpty else { return .skip }
    guard let args = arguments(line[marker.upperBound..<line.index(before: line.endIndex)]) else { return .skip }
    guard let first = args.first else { return isException ? .exception(hosts: hosts, body: []) : .skip }
    let requested = first.hasSuffix(".js") ? String(first.dropLast(3)) : first
    guard let name = supported[requested], trusted || isException || !name.hasPrefix("trusted-") else { return .skip }
    let body = [name] + args.dropFirst()
    if isException { return .exception(hosts: hosts, body: body) }
    guard runs(body) else { return .skip }
    return .run(hosts: hosts, excluded: excluded, body: body)
  }

  static func runs(_ body: [String]) -> Bool {
    switch body.first {
    case "trusted-replace-argument":
      guard body.count >= 3, !body[1].isEmpty, body[2].wholeMatch(of: /-?[0-9]+/) != nil else { return false }
      let value = body.count > 3 ? body[3] : ""
      let extra = body.dropFirst(4)
      guard extra.count % 2 == 0, stride(from: extra.startIndex, to: extra.endIndex, by: 2).allSatisfy({ extra[$0] == "condition" }) else { return false }
      for prefix in ["repl:", "add:", "json:"] where value.hasPrefix(prefix) { return false }
      return !(value.hasPrefix("{") && value.hasSuffix("}"))
    default:
      return false
    }
  }

  var isWellFormed: Bool {
    let valid = 0..<bodies.count
    return hosts.values.allSatisfy { $0.allSatisfy(valid.contains) } && exceptions.values.allSatisfy { $0.allSatisfy(valid.contains) }
  }

  static let quotes: Set<Character> = ["'", "\"", "`"]

  static func arguments(_ text: Substring) -> [String]? {
    var args: [String] = []
    var index = text.startIndex
    func skipSpaces() { while index < text.endIndex, text[index] == " " || text[index] == "\t" { index = text.index(after: index) } }
    skipSpaces()
    if index == text.endIndex { return [] }
    while true {
      skipSpaces()
      var value = ""
      if index < text.endIndex, quotes.contains(text[index]) {
        let quote = text[index]
        index = text.index(after: index)
        var closed = false
        while index < text.endIndex {
          let character = text[index]
          if character == "\\", text.index(after: index) < text.endIndex, text[text.index(after: index)] == quote {
            value.append(quote)
            index = text.index(index, offsetBy: 2)
            continue
          }
          index = text.index(after: index)
          if character == quote {
            closed = true
            break
          }
          value.append(character)
        }
        guard closed else { return nil }
        skipSpaces()
        guard index == text.endIndex || text[index] == "," else { return nil }
      } else {
        while index < text.endIndex, text[index] != "," {
          if text[index] == "\\", text.index(after: index) < text.endIndex, text[text.index(after: index)] == "," {
            value.append(",")
            index = text.index(index, offsetBy: 2)
            continue
          }
          value.append(text[index])
          index = text.index(after: index)
        }
        value = value.trimmingCharacters(in: .whitespaces)
      }
      args.append(value)
      guard index < text.endIndex else { return args }
      index = text.index(after: index)
    }
  }
}
