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

  @Test func `a minlength of 200 gets a valid password at once (no page pattern can reach the generator)`() {
    let rules = LoginListField.rules(maxLength: nil, minLength: NSNumber(value: 200))
    let done = DispatchSemaphore(value: 0)
    let made = Made()
    Thread.detachNewThread {
      made.value = StrongPassword.make(rules)
      done.signal()
    }
    #expect(done.wait(timeout: .now() + 2) == .success, "make returned within 2 s")
    guard let password = made.value else { return }
    #expect(password.count >= 200)
    #expect(password.filter { $0 != "-" }.allSatisfy(alphabet.contains))
    #expect(password.contains(where: \.isNumber) && password.contains(where: \.isUppercase) && password.contains(where: \.isLowercase))
  }
}

@Suite struct PatternedStrongPasswords {
  @Test func `a new-password field with any pattern gets 16 letters and digits with no hyphens, within its lengths`() {
    for password in samples(.init(patterned: true), count: 50) {
      #expect(password.count == 16 && password.allSatisfy(alphabet.contains))
    }
    #expect(samples(.init(maxLength: 12, patterned: true), count: 20).allSatisfy { $0.count == 12 && $0.allSatisfy(alphabet.contains) })
    #expect(samples(.init(minLength: 24, patterned: true), count: 20).allSatisfy { $0.count == 24 && $0.allSatisfy(alphabet.contains) })
  }

  @Test func `a report only says whether the field has a pattern, as a true boolean`() {
    #expect(LoginListField.rules(maxLength: nil, minLength: nil, patterned: NSNumber(value: true)) == .init(patterned: true))
    #expect(LoginListField.rules(maxLength: nil, minLength: nil, patterned: "(a+)+$") == .init())
    #expect(LoginListField.rules(maxLength: nil, minLength: nil, patterned: NSNumber(value: 7)) == .init())
  }
}

private final class Made: @unchecked Sendable { var value: String? }
