import Foundation

let usage = """
  make-fixtures.sh [--messages PATH] [--mail PATH] [--sms SENDER|SECONDS_AGO|TEXT]... [--sms-body SENDER|SECONDS_AGO|TEXT]...
                   [--sms-mine SENDER|SECONDS_AGO|TEXT]... [--email SENDER|SECONDS_AGO|SUBJECT|SUMMARY]...
                   [--email-junk SENDER|SECONDS_AGO|SUBJECT|SUMMARY]...
  Creates or appends to a fake chat.db and a fake Envelope Index with the given messages, dated SECONDS_AGO before now.
  --sms-body stores the text only in attributedBody, as Messages does on recent macOS. --sms-mine marks it sent by you.
  --email-junk files the email in Junk, which Ardia skips.
  A literal \\n in TEXT, SUBJECT or SUMMARY becomes a line break. Fake data only.
  """

var messagesPath: String?
var mailPath: String?
var texts: [VaultDeliveredFixtureText] = []
var mails: [VaultDeliveredFixtureMail] = []

func fields(_ value: String, _ count: Int) -> [String] {
  let parts = value.split(separator: "|", maxSplits: count - 1, omittingEmptySubsequences: false).map { $0.replacingOccurrences(of: "\\n", with: "\n") }
  guard parts.count == count, Double(parts[1]) != nil else {
    FileHandle.standardError.write(Data("bad value: \(value)\n\(usage)\n".utf8))
    exit(2)
  }
  return parts
}

var arguments = CommandLine.arguments.dropFirst().makeIterator()
while let flag = arguments.next() {
  if flag == "-h" || flag == "--help" {
    print(usage)
    exit(0)
  }
  guard let value = arguments.next() else {
    FileHandle.standardError.write(Data("\(flag) needs a value\n\(usage)\n".utf8))
    exit(2)
  }
  switch flag {
  case "--messages": messagesPath = value
  case "--mail": mailPath = value
  case "--sms", "--sms-body", "--sms-mine":
    let parts = fields(value, 3)
    texts.append(VaultDeliveredFixtureText(sender: parts[0], secondsAgo: Double(parts[1]) ?? 0, text: parts[2], attributed: flag == "--sms-body", fromMe: flag == "--sms-mine"))
  case "--email", "--email-junk":
    let parts = fields(value, 4)
    var mail = VaultDeliveredFixtureMail(sender: parts[0], secondsAgo: Double(parts[1]) ?? 0, subject: parts[2], summary: parts[3])
    if flag == "--email-junk" { mail.mailbox = "imap://fixture%40example.com@imap.example.com/Junk" }
    mails.append(mail)
  default:
    FileHandle.standardError.write(Data("unknown flag \(flag)\n\(usage)\n".utf8))
    exit(2)
  }
}

do {
  if let messagesPath { try VaultDeliveredFixtures.writeMessages(messagesPath, texts) }
  if let mailPath { try VaultDeliveredFixtures.writeMail(mailPath, mails) }
  print("wrote \(texts.count) texts and \(mails.count) emails")
} catch {
  FileHandle.standardError.write(Data("failed: \(error)\n".utf8))
  exit(1)
}
