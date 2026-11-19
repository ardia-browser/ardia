#ifndef ARDIA_WIN_MAIN_H_
#define ARDIA_WIN_MAIN_H_

#include <string>
#include <string_view>

namespace ardia_win {

void NoteForTest(const std::string& line);

void BeforeChromeMain();

void AfterChromeMain(int exit_code);

void QuitApp();

void AppQuitting(std::string_view phase,
                 std::string_view reason,
                 int wait_ms,
                 std::string_view answer);

const char* TestGateDecision();

}

#endif
