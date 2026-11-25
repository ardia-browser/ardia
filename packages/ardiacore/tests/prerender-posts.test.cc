#include "../../../engine/ardiacore/src/ardia/core/ac_prerender_posts.h"

#include <cstdio>
#include <string>
#include <vector>

using namespace ardiacore;

static int failures = 0;
static const char* current_case = "";
#define CHECK(cond)                                                                    \
  do {                                                                                 \
    if (!(cond)) {                                                                     \
      std::printf("FAIL %s: %s:%d: %s\n", current_case, __FILE__, __LINE__, #cond);   \
      failures++;                                                                      \
    }                                                                                  \
  } while (0)

using Posts = PrerenderPosts<std::string>;
using Verdict = Posts::Verdict;

static std::vector<std::string> Kinds(const std::vector<Posts::Post>& posts) {
  std::vector<std::string> kinds;
  for (const auto& [kind, json] : posts) {
    kinds.push_back(kind);
  }
  return kinds;
}

static void APageThatIsNotPrerenderingPostsStraightAway() {
  current_case = "a page that is not prerendering posts straight away";
  Posts posts;
  CHECK(posts.Take("a", false, "hello", "{}") == Verdict::kSend);
  CHECK(posts.Take("a", false, "theme", "{}") == Verdict::kSend);
  CHECK(posts.Release("a").empty());
}

static void APrerenderingPageHoldsEveryPostAndOnlyTheFirstAsksForActivation() {
  current_case = "a prerendering page holds every post, and only the first asks to be released on activation";
  Posts posts;
  CHECK(posts.Take("a", true, "hello", "{\"top\":true}") == Verdict::kHoldUntilActivated);
  CHECK(posts.Take("a", true, "theme", "{}") == Verdict::kHold);
  CHECK(posts.Take("a", true, "media", "{}") == Verdict::kHold);
  const auto released = posts.Release("a");
  CHECK(released.size() == 3);
  current_case = "release hands the held posts back in order, once, and later posts are sent straight away";
  CHECK((Kinds(released) == std::vector<std::string>{"hello", "theme", "media"}));
  CHECK(released[0].second == "{\"top\":true}");
  CHECK(posts.Release("a").empty());
  CHECK(posts.Take("a", false, "theme", "{}") == Verdict::kSend);
}

static void APostFromThePagesOwnPrerenderingChangeHandlerGoesOutLast() {
  current_case = "a post the page makes after it stops prerendering but before release goes out last";
  Posts posts;
  CHECK(posts.Take("a", true, "hello", "{}") == Verdict::kHoldUntilActivated);
  CHECK(posts.Take("a", false, "theme", "{}") == Verdict::kHold);
  CHECK((Kinds(posts.Release("a")) == std::vector<std::string>{"hello", "theme"}));
  CHECK(posts.Take("a", false, "theme", "{}") == Verdict::kSend);
}

static void AFrameThatLoadsAnotherPrerenderingDocumentDropsWhatTheOldOneHeld() {
  current_case = "a frame that loads another prerendering document drops what the old one held";
  Posts posts;
  CHECK(posts.Take("a", true, "hello", "{}") == Verdict::kHoldUntilActivated);
  CHECK(posts.Take("b", true, "hello", "{}") == Verdict::kHoldUntilActivated);
  CHECK(posts.Release("a").empty());
  CHECK((Kinds(posts.Release("b")) == std::vector<std::string>{"hello"}));
}

static void TheOldDocumentsActivationReleasesNothingOnceAnotherDocumentPosted() {
  current_case = "once another document posted, the old document's activation releases nothing";
  Posts posts;
  CHECK(posts.Take("a", true, "hello", "{}") == Verdict::kHoldUntilActivated);
  CHECK(posts.Take("b", false, "hello", "{}") == Verdict::kSend);
  CHECK(posts.Release("a").empty());
}

static void ATalkativePrerenderingPageKeepsOnlyItsFirstPostsUpToACount() {
  current_case = "a talkative prerendering page keeps only its first posts, up to a count";
  Posts posts;
  CHECK(posts.Take("a", true, "first", "{}") == Verdict::kHoldUntilActivated);
  for (size_t i = 1; i < kMaxPrerenderPosts + 20; i++) {
    CHECK(posts.Take("a", true, "more", "{}") == Verdict::kHold);
  }
  const auto released = posts.Release("a");
  CHECK(released.size() == kMaxPrerenderPosts);
  CHECK(released.front().first == "first");
}

static void ATalkativePrerenderingPageKeepsOnlyThePostsThatFitItsSize() {
  current_case = "a talkative prerendering page keeps only the posts that fit its size";
  Posts posts;
  const std::string big(kMaxPrerenderPostBytes / 2, 'x');
  CHECK(posts.Take("a", true, "one", big) == Verdict::kHoldUntilActivated);
  CHECK(posts.Take("a", true, "two", big) == Verdict::kHold);
  CHECK(posts.Take("a", true, "three", "{}") == Verdict::kHold);
  CHECK((Kinds(posts.Release("a")) == std::vector<std::string>{"one", "three"}));
}

int main() {
  APageThatIsNotPrerenderingPostsStraightAway();
  APrerenderingPageHoldsEveryPostAndOnlyTheFirstAsksForActivation();
  APostFromThePagesOwnPrerenderingChangeHandlerGoesOutLast();
  AFrameThatLoadsAnotherPrerenderingDocumentDropsWhatTheOldOneHeld();
  TheOldDocumentsActivationReleasesNothingOnceAnotherDocumentPosted();
  ATalkativePrerenderingPageKeepsOnlyItsFirstPostsUpToACount();
  ATalkativePrerenderingPageKeepsOnlyThePostsThatFitItsSize();
  if (failures) {
    std::printf("%d failure(s)\n", failures);
    return 1;
  }
  std::printf("prerender posts ok\n");
  return 0;
}
