import Foundation

public struct PageSummaryOutline: Equatable, Sendable {
  public struct Row: Equatable, Sendable, Identifiable {
    public var id: Int
    public var symbol: String?
    public var label: String?
    public var info: String

    public init(id: Int, symbol: String? = nil, label: String? = nil, info: String) {
      self.id = id
      self.symbol = symbol
      self.label = label
      self.info = info
    }
  }

  public static let leadMark = "= "
  public static let fieldSeparator: Character = "|"

  public var lead: String?
  public var rows: [Row]

  public var isEmpty: Bool { lead == nil && rows.isEmpty }

  public init(lead: String? = nil, rows: [Row] = []) {
    self.lead = lead
    self.rows = rows
  }

  public enum Format: Sendable {
    case written
    case excerpts
  }

  public init(_ text: String, finished: Bool, format: Format = .written) {
    switch format {
    case .written: self.init(finished ? text : Self.wholeLines(text))
    case .excerpts: self.init(excerpts: text)
    }
  }

  public init(excerpts text: String) {
    var lead: String?
    var rows: [Row] = []
    for raw in text.split(whereSeparator: \.isNewline) {
      let line = raw.trimmingCharacters(in: .whitespaces)
      let info = Self.clean(Self.bulletBody(line) ?? line)
      guard !info.isEmpty, !["-", "•", "*"].contains(info) else { continue }
      if lead == nil { lead = info } else { rows.append(Row(id: rows.count, info: info)) }
    }
    self.lead = lead
    self.rows = rows
  }

  public init(_ text: String) {
    var lead: String?
    var rows: [Row] = []
    func add(_ row: Row) {
      var row = row
      if lead == nil, rows.isEmpty, row.symbol == nil, row.label == nil {
        lead = row.info
        return
      }
      row.id = rows.count
      rows.append(row)
    }
    for raw in Self.unrun(text).split(whereSeparator: \.isNewline) {
      let line = raw.trimmingCharacters(in: .whitespaces)
      guard !line.isEmpty, !["-", "•", "*", "="].contains(line) else { continue }
      if line.hasPrefix(Self.leadMark) {
        let body = Self.clean(String(line.dropFirst(Self.leadMark.count)))
        if !body.isEmpty { add(Row(id: 0, info: body)) }
        continue
      }
      guard let body = Self.bulletBody(line) else {
        let plain = Self.clean(line)
        if !plain.isEmpty { add(Row(id: 0, info: plain)) }
        continue
      }
      let fields = body.split(separator: Self.fieldSeparator, maxSplits: 2, omittingEmptySubsequences: false).map { Self.clean(String($0)) }
      var row = Row(id: 0, info: "")
      switch fields.count {
      case 3...:
        row.symbol = Self.symbolName(fields[0])
        row.label = fields[1].isEmpty ? nil : fields[1]
        row.info = fields[2]
      case 2:
        if let symbol = Self.symbolName(fields[0]), !fields[0].contains(" ") { row.symbol = symbol } else { row.label = fields[0].isEmpty ? nil : fields[0] }
        row.info = fields[1]
      default:
        row.info = fields.first ?? ""
      }
      if row.info.isEmpty, let label = row.label {
        row.info = label
        row.label = nil
      }
      if !row.info.isEmpty { add(row) }
    }
    self.lead = lead
    self.rows = rows
  }

  public static func wholeLines(_ text: String) -> String {
    let lines = unrun(text)
    guard let end = lines.lastIndex(where: \.isNewline) else { return "" }
    return String(lines[..<end])
  }

  static func unrun(_ text: String) -> String {
    text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).map { line -> String in
      guard bulletBody(line.trimmingCharacters(in: .whitespaces)) == nil else { return String(line) }
      return String(line).replacing(/([.!?](?:["'”’)\]]|\[\d+\])*)[ \t]+[-•*][ \t]+((?:[a-z0-9]+\.)*[a-z][a-z0-9]*)[ \t]*\|[ \t]*([^|\n]{2,60}?)[ \t]*\|/) { match in
        "\(match.1)\n- \(match.2) | \(match.3) |"
      }
    }
    .joined(separator: "\n")
  }

  static func bulletBody(_ line: String) -> String? {
    for mark in ["- ", "• ", "* "] where line.hasPrefix(mark) { return String(line.dropFirst(mark.count)) }
    return nil
  }

  static func clean(_ text: String) -> String {
    ResearchAnswer.withoutCitations(text).replacingOccurrences(of: "**", with: "").trimmingCharacters(in: .whitespaces)
  }

  static func symbolName(_ field: String) -> String? {
    let name = field.trimmingCharacters(in: CharacterSet(charactersIn: "`\"' ")).lowercased()
    guard !name.isEmpty, name.count <= 48, name.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "." }) else { return nil }
    return name
  }
}
