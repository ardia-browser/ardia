#include "ardia/win/webui/webui_session_end_policy.h"

#include <cassert>
#include <cstddef>
#include <fstream>
#include <iostream>
#include <optional>
#include <string>
#include <string_view>

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

void TestAClosingWindowStaysLeavingUntilItsCloseEndsOrIsCancelled() {
  assert(!CloseStillInFlight(false, false, false, false, false));
  assert(!CloseStillInFlight(false, false, false, true, true));
  assert(CloseStillInFlight(true, false, false, false, false));
  assert(CloseStillInFlight(false, true, false, false, false));
  assert(CloseStillInFlight(false, true, true, true, false));
  assert(CloseStillInFlight(false, true, true, false, true));
  assert(!CloseStillInFlight(false, true, true, false, false));
}

void TestTheSystemCloseWaitsWhileTheSessionEnds() {
  assert(SwallowsSystemClose(true, false));
  assert(!SwallowsSystemClose(true, true));
  assert(!SwallowsSystemClose(false, false));
  assert(!SwallowsSystemClose(false, true));
}

void TestEveryBrowserWindowCloseGoesThroughTheShell() {
  assert(RoutesSystemClose(false, false));
  assert(RoutesSystemClose(false, true));
  assert(RoutesSystemClose(true, true));
  assert(!RoutesSystemClose(true, false));
}

void TestOverlappingClosesHandTheEndToTheLastWindow() {
  const bool first_leaving = CloseStillInFlight(false, true, true, true, false);
  assert(first_leaving);
  const size_t others_open_for_second = first_leaving ? 0 : 1;
  assert(ClosingEndsSession(others_open_for_second));
  const bool first_cancelled =
      CloseStillInFlight(false, true, true, false, false);
  assert(!first_cancelled);
  assert(!ClosingEndsSession(first_cancelled ? 0 : 1));
}

void TestOnlyTheCurrentValidTokenReleasesAClose() {
  SessionEnd end;
  assert(!end.Acknowledge("t1"));
  end.Begin("t1");
  assert(!end.Acknowledge(""));
  assert(!end.Acknowledge("t1 "));
  assert(!end.Acknowledge("T1"));
  assert(end.ending());
  assert(end.Acknowledge("t1"));
  assert(!end.Acknowledge("t1"));
  assert(end.Resume(false, 1) == "t1");
  end.Begin("t2");
  assert(!end.Acknowledge("t1"));
  assert(end.ending());
  assert(end.Acknowledge("t2"));
}

std::optional<std::string> HexText(std::string_view hex) {
  if (hex.size() % 2) {
    return std::nullopt;
  }
  std::string text;
  for (size_t at = 0; at < hex.size(); at += 2) {
    const auto digit = [](char c) -> int {
      if (c >= '0' && c <= '9') return c - '0';
      if (c >= 'a' && c <= 'f') return c - 'a' + 10;
      return -1;
    };
    const int high = digit(hex[at]);
    const int low = digit(hex[at + 1]);
    if (high < 0 || low < 0) {
      return std::nullopt;
    }
    text.push_back(static_cast<char>(high * 16 + low));
  }
  return text;
}

int RunHostileCorpus(const char* path) {
  std::ifstream input(path);
  assert(input);
  const std::string pending = "3f2a9c1e-77aa-4c1b-9d0e-0123456789ab";
  size_t values = 0;
  size_t strings = 0;
  size_t released = 0;
  std::string line;
  while (std::getline(input, line)) {
    ++values;
    std::string token;
    if (line.rfind("s:", 0) == 0) {
      const std::optional<std::string> text =
          HexText(std::string_view(line).substr(2));
      assert(text);
      token = *text;
      ++strings;
    } else {
      assert(line == "x:");
    }
    SessionEnd end;
    assert(end.Begin(pending) == SessionEndStep::kAsk);
    SessionEnd stale;
    stale.Begin(token);
    stale.Settle(token);
    const bool releases = end.Acknowledge(token);
    if (releases) {
      ++released;
      assert(token == pending);
    } else {
      assert(end.ending());
    }
    assert(!stale.Acknowledge(token));
  }
  SessionEnd control;
  control.Begin(pending);
  assert(control.Acknowledge(pending));
  std::cout << "hostile: " << values << " values, " << strings << " strings, "
            << released << " released a pending close, the control did\n";
  return 0;
}

}

int main(int argc, char** argv) {
  if (argc == 3 && std::string_view(argv[1]) == "--hostile") {
    return RunHostileCorpus(argv[2]);
  }
  TestTokens();
  TestOnlyTheLastBrowserWindowEndsTheSession();
  TestOneAskEndsTheSessionAndLaterClosesJoinOrProceed();
  TestACancelledQuitResumesOnlyWhileWindowsStayOpen();
  TestAClosingWindowStaysLeavingUntilItsCloseEndsOrIsCancelled();
  TestTheSystemCloseWaitsWhileTheSessionEnds();
  TestOnlyTheCurrentValidTokenReleasesAClose();
  TestEveryBrowserWindowCloseGoesThroughTheShell();
  TestOverlappingClosesHandTheEndToTheLastWindow();
  std::cout << "webui_session_end_policy_test: all assertions passed\n";
  return 0;
}
