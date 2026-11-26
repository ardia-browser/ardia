// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_EXTENSION_SITES_INTERNAL_H_
#define CHROME_BROWSER_ARDIA_AC_EXTENSION_SITES_INTERNAL_H_

#include <string>

#include "chrome/browser/ardia/ac_engine.h"

class Profile;

namespace extensions {
class Extension;
}

namespace ardia::extension_sites_internal {

std::string SiteProblem(Profile* profile,
                        const extensions::Extension& extension,
                        const std::string& site,
                        bool grant);

void ChangeSite(Profile* profile,
                const extensions::Extension& extension,
                const std::string& site,
                bool grant,
                Reply reply);

}

#endif
