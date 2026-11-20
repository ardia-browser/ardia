import Testing

@Suite("Autofill card numbers")
struct AutofillCardTests {
  @Test("Rejects what is not a complete card", arguments: [
    "", "4111111111111112", "411111111111", "37828224631000", "5555555555554444000",
  ])
  func rejectsIncompleteNumbers(number: String) {
    #expect(AutofillCardNumber.isComplete(number) == false)
  }

  @Test func `a letter fails the Luhn check`() {
    #expect(AutofillCardNumber.passesLuhn("41a1") == false)
  }

  @Test func `digits keep at most 19 ASCII digits`() {
    #expect(AutofillCardNumber.digits("4111 1111-1111.1111 1111 9999") == "4111111111111111111")
    #expect(AutofillCardNumber.digits("٤١١١") == "")
  }

  @Test("Test numbers are complete and name their network", arguments: [
    ("4111111111111111", "visa"), ("5555555555554444", "mastercard"), ("2223003122003222", "mastercard"),
    ("378282246310005", "amex"), ("6011111111111117", "discover"), ("3530111333300000", "jcb"),
    ("30569309025904", "diners"), ("6200000000000005", "unionpay"),
  ])
  func acceptsTestNumbers(number: String, network: String) {
    #expect(AutofillCardNumber.network(number) == network)
    #expect(AutofillCardNumber.isComplete(number))
  }

  @Test("Unknown or too-short prefixes are a plain card", arguments: ["9", "3"])
  func unknownPrefix(number: String) {
    #expect(AutofillCardNumber.network(number) == "card")
  }

  @Test("Groups digits as the card prints them", arguments: [
    ("4111111111111111", "4111 1111 1111 1111"),
    ("378282246310005", "3782 822463 10005"),
    ("30569309025904", "3056 930902 5904"),
    ("4111111111111111111", "4111 1111 1111 1111 111"),
    ("41111", "4111 1"),
    ("", ""),
  ])
  func groupsAsPrinted(number: String, printed: String) {
    #expect(AutofillCardNumber.formatted(number) == printed)
  }

  @Test("Keeps the caret after the same digit", arguments: [
    (0, "4111 1111", 0), (4, "4111 1111", 4), (5, "4111 1111", 6), (99, "4111", 4),
  ])
  func keepsTheCaret(digits: Int, text: String, caret: Int) {
    #expect(AutofillCardNumber.caret(afterDigits: digits, in: text) == caret)
  }
}
