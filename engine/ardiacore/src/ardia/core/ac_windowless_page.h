// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_CORE_AC_WINDOWLESS_PAGE_H_
#define ARDIA_CORE_AC_WINDOWLESS_PAGE_H_

namespace ardiacore {

void InstallWindowlessPageGeometry();

struct WindowlessPageTotals {
  int given = 0;
  int missed = 0;
};

WindowlessPageTotals WindowlessPagesSoFar();

}

#endif
