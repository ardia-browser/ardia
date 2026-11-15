// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_CONTENT_BLOCKER_H_
#define ARDIA_LINUX_CONTENT_BLOCKER_H_

#include <string>
#include <string_view>
#include <vector>

namespace content {
class WebContents;
}

namespace ardia_linux {

class DomainVerbs;

inline constexpr char kContentBlockerExtensionId[] =
    "fajbdaomknpkicfjcpipdmcpoamdmilh";

void AddContentBlockerVerbs(DomainVerbs& verbs);

void WatchBlockedRequests(content::WebContents* contents);

std::string ContentBlockerScript(std::string_view format,
                                 const std::vector<std::string>& pieces);

std::string ContentBlockerCategory(std::string_view list_id,
                                   std::string_view group);

}

#endif
