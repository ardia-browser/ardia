// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MODULES_DESKTOP_ENTRY_H_
#define ARDIA_LINUX_MODULES_DESKTOP_ENTRY_H_

#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "base/environment.h"
#include "base/files/file_path.h"
#include "base/time/time.h"

namespace ardia_linux {

inline constexpr char kDesktopFile[] = "ardia.desktop";
inline constexpr char kWindowClass[] = "ardia";

const std::vector<std::string>& BrowserMimeTypes();

struct DesktopPlaces {
  base::FilePath data_home;
  base::FilePath config_home;
  bool sandboxed = false;
  bool runs_tools = true;
  base::EnvironmentMap tool_environment;

  base::FilePath UserDesktopFile() const;
  base::FilePath AutostartFile() const;
  base::FilePath MimeAppsFile() const;
  base::FilePath IconsFolder() const;
};

DesktopPlaces PlacesFor(const base::FilePath& data_dir,
                        bool isolated,
                        const base::FilePath& xdg_data_home,
                        const base::FilePath& xdg_config_home,
                        bool tools_in_sandbox = false);

std::string QuotedExec(std::string_view path);

std::string DesktopEntryText(
    std::string_view launcher,
    const std::vector<std::pair<std::string, std::string>>& extra = {});

std::string AutostartEntryText(std::string_view launcher);

std::string WithDefaultApplications(std::string_view existing,
                                    std::string_view desktop_file,
                                    const std::vector<std::string>& types);

std::optional<std::string> DefaultApplicationIn(std::string_view mimeapps,
                                                std::string_view type);

struct ToolRun {
  bool ok = false;
  bool timed_out = false;
  std::string out;
  std::string err;
};

ToolRun RunTool(const std::vector<std::string>& argv,
                base::TimeDelta deadline,
                const base::EnvironmentMap& environment = {});

}

#endif
