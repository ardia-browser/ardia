import Foundation

enum AutofillCardNumber {
  static let longest = 19

  static func digits(_ text: String) -> String {
    String(text.unicodeScalars.lazy.filter { $0.value >= 48 && $0.value <= 57 }.prefix(longest).map(Character.init))
  }

  private static func leading(_ digits: String, _ count: Int) -> Int? {
    guard digits.count >= count else { return nil }
    return Int(digits.prefix(count))
  }

  private static func starts(_ digits: String, in range: ClosedRange<Int>, width: Int) -> Bool {
    leading(digits, width).map(range.contains) ?? false
  }

  static func network(_ digits: String) -> String {
    if starts(digits, in: 34...34, width: 2) || starts(digits, in: 37...37, width: 2) { return "amex" }
    if digits.hasPrefix("4") { return "visa" }
    if starts(digits, in: 51...55, width: 2) || starts(digits, in: 2221...2720, width: 4) { return "mastercard" }
    if digits.hasPrefix("6011") || starts(digits, in: 644...649, width: 3) || digits.hasPrefix("65") { return "discover" }
    if starts(digits, in: 3528...3589, width: 4) { return "jcb" }
    if starts(digits, in: 300...305, width: 3) || digits.hasPrefix("36") || digits.hasPrefix("38") || digits.hasPrefix("39") { return "diners" }
    if digits.hasPrefix("62") { return "unionpay" }
    return "card"
  }

  static func lengths(_ network: String) -> ClosedRange<Int> {
    switch network {
    case "amex": return 15...15
    case "visa": return 13...19
    case "mastercard": return 16...16
    case "diners": return 14...19
    case "discover", "jcb", "unionpay": return 16...19
    default: return 12...19
    }
  }

  static func groups(_ network: String, count: Int) -> [Int] {
    if network == "amex" { return [4, 6, 5] }
    if network == "diners" && count == 14 { return [4, 6, 4] }
    return [4, 4, 4, 4, 3]
  }

  static func formatted(_ digits: String) -> String {
    var parts: [Substring] = []
    var rest = Substring(digits)
    for size in groups(network(digits), count: digits.count) where !rest.isEmpty {
      parts.append(rest.prefix(size))
      rest = rest.dropFirst(size)
    }
    if !rest.isEmpty { parts.append(rest) }
    return parts.joined(separator: " ")
  }

  static func passesLuhn(_ digits: String) -> Bool {
    guard !digits.isEmpty else { return false }
    var sum = 0
    for (index, character) in digits.reversed().enumerated() {
      guard let value = character.wholeNumberValue else { return false }
      let doubled = index % 2 == 1 ? value * 2 : value
      sum += doubled > 9 ? doubled - 9 : doubled
    }
    return sum % 10 == 0
  }

  static func isComplete(_ digits: String) -> Bool {
    lengths(network(digits)).contains(digits.count) && passesLuhn(digits)
  }

  static func caret(afterDigits count: Int, in formatted: String) -> Int {
    guard count > 0 else { return 0 }
    var seen = 0
    for (offset, character) in formatted.enumerated() where character != " " {
      seen += 1
      if seen == count { return offset + 1 }
    }
    return formatted.count
  }

  static func summary(_ digits: String) -> [String: Any] {
    ["digits": digits.count, "network": network(digits), "complete": isComplete(digits), "luhn": passesLuhn(digits)]
  }
}
