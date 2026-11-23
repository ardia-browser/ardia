import Foundation

enum VaultSharedSites {
  static let groups: [[String]] = [
    ["google.com", "youtube.com", "gmail.com"],
    ["live.com", "microsoft.com", "microsoftonline.com", "outlook.com", "office.com", "office365.com", "hotmail.com", "xbox.com", "skype.com", "msn.com", "bing.com"],
    ["apple.com", "icloud.com"],
    ["amazon.com", "amazon.ca", "amazon.co.uk", "amazon.de", "amazon.fr", "amazon.it", "amazon.es", "amazon.co.jp", "amazon.com.au", "amazon.in"],
    ["facebook.com", "messenger.com"],
    ["atlassian.com", "atlassian.net", "bitbucket.org", "trello.com"],
    ["adobe.com", "behance.net"],
    ["ebay.com", "ebay.ca", "ebay.co.uk", "ebay.de", "ebay.fr", "ebay.it", "ebay.com.au"],
    ["steampowered.com", "steamcommunity.com"],
    ["wikipedia.org", "wikimedia.org", "wiktionary.org", "wikidata.org", "mediawiki.org"],
    ["airbnb.com", "airbnb.ca", "airbnb.co.uk", "airbnb.de", "airbnb.fr"],
    ["dropbox.com", "getdropbox.com"],
    ["ea.com", "origin.com"],
    ["epicgames.com", "unrealengine.com", "fortnite.com"],
    ["playstation.com", "sonyentertainmentnetwork.com"],
  ]

  private static let byDomain: [String: Int] = {
    var table: [String: Int] = [:]
    for (index, group) in groups.enumerated() { for domain in group { table[domain] = index } }
    return table
  }()

  static func group(of domain: String) -> Int? { byDomain[domain] }

  static func shared(_ a: String, _ b: String) -> Bool {
    guard a != b, let first = byDomain[a], let second = byDomain[b] else { return false }
    return first == second
  }
}
