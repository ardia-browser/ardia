import ArdiaBrowser
import Foundation

@MainActor
enum PhoneHandoff {
  private static var activity: NSUserActivity?
  private static weak var owner: AnyObject?

  static func offer(_ url: URL?, title: String, from owner: AnyObject) {
    guard let url, BrowserURL.isSyncable(url.absoluteString) else {
      withdraw(owner)
      return
    }
    if let current = Self.activity, current.webpageURL == url, current.title == title, Self.owner === owner { return }
    let activity = Self.activity ?? NSUserActivity(activityType: NSUserActivityTypeBrowsingWeb)
    activity.isEligibleForHandoff = true
    activity.webpageURL = url
    activity.title = title
    Self.activity = activity
    Self.owner = owner
    activity.becomeCurrent()
  }

  static func withdraw(_ owner: AnyObject) {
    guard Self.owner === owner else { return }
    activity?.invalidate()
    activity = nil
    Self.owner = nil
  }
}
