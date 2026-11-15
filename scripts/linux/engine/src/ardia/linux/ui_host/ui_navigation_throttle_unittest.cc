#include "ardia/linux/ui_host/ui_navigation_throttle.h"

#include "testing/gtest/include/gtest/gtest.h"
#include "url/gurl.h"

namespace ardia_linux {

TEST(UiNavigationRuleTest, TheHostCommitsOnlyItsOwnDocuments) {
  EXPECT_TRUE(UiDocumentMayCommit(UiDocument::kHost, true,
                                  GURL("chrome://ardia-app/index.html")));
  EXPECT_FALSE(UiDocumentMayCommit(UiDocument::kHost, true,
                                   GURL("chrome://settings/")));
  EXPECT_FALSE(UiDocumentMayCommit(UiDocument::kHost, true,
                                   GURL("https://example.com/")));
  EXPECT_FALSE(UiDocumentMayCommit(UiDocument::kHost, true,
                                   GURL("about:blank")));
}

TEST(UiNavigationRuleTest, AppWindowsStayBlank) {
  EXPECT_TRUE(
      UiDocumentMayCommit(UiDocument::kAppWindow, true, GURL("about:blank")));
  EXPECT_FALSE(UiDocumentMayCommit(UiDocument::kAppWindow, true,
                                   GURL("chrome://ardia-app/index.html")));
  EXPECT_FALSE(UiDocumentMayCommit(UiDocument::kAppWindow, true,
                                   GURL("https://example.com/")));
}

TEST(UiNavigationRuleTest, FramesAreBlankOrSrcdoc) {
  for (UiDocument document : {UiDocument::kHost, UiDocument::kAppWindow}) {
    EXPECT_TRUE(UiDocumentMayCommit(document, false, GURL("about:blank")));
    EXPECT_TRUE(UiDocumentMayCommit(document, false, GURL("about:srcdoc")));
    EXPECT_FALSE(
        UiDocumentMayCommit(document, false, GURL("https://example.com/")));
    EXPECT_FALSE(UiDocumentMayCommit(document, false,
                                     GURL("chrome://ardia-app/index.html")));
  }
}

}
