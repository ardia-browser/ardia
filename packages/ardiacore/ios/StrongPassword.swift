import Foundation
import Security

enum StrongPassword {
  struct Rules: Equatable {
    var minLength = 0
    var maxLength = 0
  }

  static let alphabet = Array("abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789")
  private static let groupSize = 4
  private static let groups = 4
  private static let separator: Character = "-"
  private static let plainLength = 16

  private enum Shape: Equatable {
    case grouped(Int)
    case plain(Int)
  }

  static func make(_ rules: Rules = .init()) -> String? {
    shapes(rules).first.flatMap(build)
  }

  private static func shapes(_ rules: Rules) -> [Shape] {
    let groupCount = max(groups, (rules.minLength + 1 + groupSize) / (groupSize + 1))
    let groupedLength = groupCount * (groupSize + 1) - 1
    let plain = max(plainLength, rules.minLength)
    let fits = { (length: Int) in rules.maxLength <= 0 || length <= rules.maxLength }
    var out: [Shape] = []
    if fits(groupedLength) { out.append(.grouped(groupCount)) }
    out.append(.plain(fits(plain) ? plain : rules.maxLength))
    return out
  }

  private static func build(_ shape: Shape) -> String? {
    switch shape {
    case .grouped(let count): grouped(count)
    case .plain(let length): mixed(length).map { String($0) }
    }
  }

  private static func grouped(_ count: Int) -> String? {
    guard let letters = mixed(count * groupSize) else { return nil }
    return stride(from: 0, to: letters.count, by: groupSize).map { String(letters[$0..<$0 + groupSize]) }.joined(separator: String(separator))
  }

  private static func mixed(_ length: Int) -> [Character]? {
    for _ in 0..<100 {
      guard let picked = indices(length, below: alphabet.count) else { return nil }
      let letters = picked.map { alphabet[$0] }
      if length < 3 || (letters.contains(where: \.isNumber) && letters.contains(where: \.isUppercase) && letters.contains(where: \.isLowercase)) { return letters }
    }
    return nil
  }

  private static func indices(_ count: Int, below bound: Int) -> [Int]? {
    let limit = 256 - 256 % bound
    var out: [Int] = []
    while out.count < count {
      var bytes = [UInt8](repeating: 0, count: count * 2)
      guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
      out += bytes.filter { Int($0) < limit }.map { Int($0) % bound }
    }
    return Array(out.prefix(count))
  }
}
