// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_TAB_RESTORE_H_
#define CHROME_BROWSER_ARDIA_AC_TAB_RESTORE_H_

namespace content {
class WebContents;
}

namespace ardia {

void StartTabHistoryCleaner();
bool CanKeepTabHistory(content::WebContents* contents);
bool KeepTabHistory(content::WebContents* contents);
bool KeepTabHistoryWhenClosed(content::WebContents* contents);

}

#endif
