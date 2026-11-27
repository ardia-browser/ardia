import Foundation
import Testing

private let alphabet = Set("abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789")
private func samples(_ rules: StrongPassword.Rules = .init(), count: Int = 300) -> [String] { (0..<count).compactMap { _ in StrongPassword.make(rules) } }

@Suite struct StrongPasswords {
  @Test func `with no limits it is four groups of four letters and digits, with a digit, a capital and a small letter`() {
    let made = samples()
    #expect(made.count == 300)
    for password in made {
      let groups = password.split(separator: "-", omittingEmptySubsequences: false)
      #expect(password.count == 19)
      #expect(groups.count == 4 && groups.allSatisfy { $0.count == 4 })
      #expect(groups.joined().allSatisfy(alphabet.contains))
      #expect(password.contains(where: \.isNumber) && password.contains(where: \.isUppercase) && password.contains(where: \.isLowercase))
    }
    #expect(Set(made).count == made.count)
  }

  @Test func `a maxlength too short for the groups drops the hyphens, and one under 16 cuts it to the maxlength`() {
    for (maxLength, length) in [(19, 19), (40, 19), (18, 16), (16, 16), (12, 12), (4, 4)] {
      for password in samples(.init(maxLength: maxLength), count: 50) {
        #expect(password.count == length, "maxlength \(maxLength)")
        #expect(password.allSatisfy(alphabet.contains) == (length < 19), "maxlength \(maxLength)")
      }
    }
  }

  @Test func `a minlength past 19 adds groups, and one between 16 and 19 keeps the four`() {
    #expect(samples(.init(minLength: 17), count: 20).allSatisfy { $0.count == 19 })
    #expect(samples(.init(minLength: 24), count: 20).allSatisfy { $0.count == 24 && $0.split(separator: "-").count == 5 })
    #expect(samples(.init(minLength: 22, maxLength: 22), count: 20).allSatisfy { $0.count == 22 && $0.allSatisfy(alphabet.contains) })
  }

  @Test func `a pattern the groups can't meet gets the plain shape that does, and one nothing meets or that doesn't parse is ignored`() {
    let whole = { (pattern: String) in try! NSRegularExpression(pattern: "^(?:\(pattern))$") }
    let lettersOnly = "[A-Za-z0-9]{8,20}"
    for password in samples(.init(pattern: lettersOnly), count: 50) {
      #expect(whole(lettersOnly).firstMatch(in: password, range: NSRange(password.startIndex..., in: password)) != nil)
      #expect(password.count == 16)
    }
    #expect(samples(.init(pattern: "[a-z0-9-]+"), count: 20).allSatisfy { $0.count == 19 })
    #expect(samples(.init(pattern: "(?=.*[!@#]).{8,}"), count: 20).allSatisfy { $0.count == 19 })
    #expect(samples(.init(pattern: "[unclosed"), count: 20).allSatisfy { $0.count == 19 })
    #expect(samples(.init(pattern: "-?[A-Za-z0-9-]{4}"), count: 20).allSatisfy { $0.count == 19 })
  }
}
