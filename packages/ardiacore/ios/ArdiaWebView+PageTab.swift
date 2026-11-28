import AppKit

extension ArdiaWebView: PageTab {
  func startPage() {}

  func closePage() { closeBrowser() }

  func copyScreenshot(_ completion: @escaping ([String: Any]) -> Void) {
    let backingScale = window?.backingScaleFactor ?? 2
    copyPagePicture { picture in completion(PageScreenshot.copy(picture, backingScale: backingScale)) }
  }

  func downloadFavicon(_ url: String, completion: @escaping ([String: Any]?) -> Void) {
    downloadFavicon(url, name: nil, completion: completion)
  }
}
