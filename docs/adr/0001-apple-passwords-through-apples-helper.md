---
status: proposed
---

# Apple Passwords through Apple's own helper

Ardia fills and saves Apple Passwords by talking to the helper Apple ships for its iCloud Passwords browser extension, paired once with the code the Passwords app shows, the way Yab does. Apple publishes no API that lists a site's saved logins for a browser: the system Passwords panel shows every login and cannot save, and Apple's extension works only in Chromium tabs, asks for the code every launch and saves unreliably. The helper's protocol is not public, so a macOS update can change it; the feature depends on Ardia being signed with Apple's `com.apple.developer.web-browser.public-key-credential` entitlement, without which macOS will not start the helper.
