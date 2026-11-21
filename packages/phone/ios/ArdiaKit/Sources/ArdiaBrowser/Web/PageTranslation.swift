import Foundation

public enum PageTranslation {
  static let proxyHostSuffix = ".translate.goog"
  static let startHost = "translate.google.com"

  public static func url(translating page: URL, into language: String) -> URL? {
    var components = URLComponents(string: "https://\(startHost)/translate")
    components?.queryItems = [
      URLQueryItem(name: "sl", value: "auto"),
      URLQueryItem(name: "tl", value: language),
      URLQueryItem(name: "u", value: page.absoluteString),
    ]
    return components?.url
  }

  public static func chosenLanguage(in url: URL) -> String? {
    guard let host = url.host()?.lowercased(), let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
    let name: String
    if host.hasSuffix(proxyHostSuffix) {
      name = "_x_tr_tl"
    } else if host == startHost, url.path() == "/translate" {
      name = "tl"
    } else {
      return nil
    }
    guard let value = items.last(where: { $0.name == name })?.value, isLanguageCode(value) else { return nil }
    return value
  }

  public static func systemLanguage(preferred: [String] = Locale.preferredLanguages) -> String {
    guard let first = preferred.first else { return "en" }
    let language = Locale.Language(identifier: first)
    let code = language.languageCode?.identifier ?? String(first.prefix(2))
    if code == "zh" {
      return language.script?.identifier == "Hant" || language.region?.identifier == "TW" || language.region?.identifier == "HK" ? "zh-TW" : "zh-CN"
    }
    return code
  }

  public static func displayName(of language: String, in locale: Locale = .current) -> String? {
    locale.localizedString(forIdentifier: language)
  }

  static func isLanguageCode(_ value: String) -> Bool {
    guard (2...12).contains(value.count), value != "auto" else { return false }
    return value.allSatisfy { $0.isASCII && ($0.isLetter || $0 == "-") }
  }
}
