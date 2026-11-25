#ifndef ARDIA_WIN_MAIN_H_
#define ARDIA_WIN_MAIN_H_

#include <string>

namespace ardia_win {

void NoteForTest(const std::string& line);

void BeforeChromeMain();

void AfterChromeMain(int exit_code);

void QuitApp();

void QuitAppWithExitCode(int exit_code);

const char* TestGateDecision();

}

#endif
