#include "ardia/win/webui/webui_session_end_policy.h"

#include <cassert>
#include <iostream>
#include <string>

namespace {

using namespace ardia_win::webui_window;

void TestTokens() {
  assert(ValidSessionToken("3f2a9c1e-77aa-4c1b-9d0e-0123456789ab"));
  assert(ValidSessionToken("a"));
  assert(!ValidSessionToken(""));
  assert(!ValidSessionToken(std::string(kSessionTokenLimit + 1, 'a')));
  assert(!ValidSessionToken("has space"));
  assert(!ValidSessionToken("quote\""));
  assert(!ValidSessionToken(std::string("nul\0", 4)));
}

void TestOnlyTheLastBrowserWindowEndsTheSession() {
  assert(ClosingEndsSession(0));
  assert(!ClosingEndsSession(1));
  assert(!ClosingEndsSession(3));
}

void TestOneAskEndsTheSessionAndLaterClosesJoinOrProceed() {
  SessionEnd end;
  assert(end.Begin("t1") == SessionEndStep::kAsk);
  assert(end.ending());
  assert(end.Begin("t2") == SessionEndStep::kJoin);
  assert(!end.Settle("t2"));
  assert(!end.Settle("stale"));
  assert(end.Settle("t1"));
  assert(end.ended());
  assert(!end.Settle("t1"));
  assert(end.Begin("t3") == SessionEndStep::kProceed);
  assert(end.token() == "t1");
}

void TestACancelledQuitResumesOnlyWhileWindowsStayOpen() {
  SessionEnd end;
  assert(end.Resume(false, 1).empty());
  end.Begin("t1");
  assert(end.Resume(false, 1).empty());
  end.Settle("t1");
  assert(end.Resume(true, 1).empty());
  assert(end.Resume(false, 0).empty());
  assert(end.ended());
  assert(end.Resume(false, 2) == "t1");
  assert(!end.ended());
  assert(end.Resume(false, 2).empty());
  assert(end.Begin("t4") == SessionEndStep::kAsk);
  assert(end.Settle("t4"));
}

}

int main() {
  TestTokens();
  TestOnlyTheLastBrowserWindowEndsTheSession();
  TestOneAskEndsTheSessionAndLaterClosesJoinOrProceed();
  TestACancelledQuitResumesOnlyWhileWindowsStayOpen();
  std::cout << "webui_session_end_policy_test: all assertions passed\n";
  return 0;
}
