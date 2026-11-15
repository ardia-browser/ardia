// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/desktop_entry.h"

#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <unistd.h>

#include <algorithm>

#include "base/files/scoped_file.h"
#include "base/no_destructor.h"
#include "base/posix/eintr_wrapper.h"
#include "base/process/launch.h"
#include "base/process/process.h"
#include "base/strings/strcat.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "third_party/re2/src/re2/re2.h"

namespace ardia_linux {

namespace {

constexpr char kDefaultsHeader[] = "[Default Applications]";

}

const std::vector<std::string>& BrowserMimeTypes() {
  static const base::NoDestructor<std::vector<std::string>> types(
      {"text/html", "text/xml", "application/xhtml+xml",
       "x-scheme-handler/http", "x-scheme-handler/https"});
  return *types;
}

base::FilePath DesktopPlaces::UserDesktopFile() const {
  return data_home.Append("applications").Append(kDesktopFile);
}

base::FilePath DesktopPlaces::AutostartFile() const {
  return config_home.Append("autostart").Append(kDesktopFile);
}

base::FilePath DesktopPlaces::MimeAppsFile() const {
  return config_home.Append("mimeapps.list");
}

base::FilePath DesktopPlaces::IconsFolder() const {
  return data_home.Append("icons").Append("hicolor");
}

DesktopPlaces PlacesFor(const base::FilePath& data_dir,
                        bool isolated,
                        const base::FilePath& xdg_data_home,
                        const base::FilePath& xdg_config_home) {
  DesktopPlaces places;
  places.sandboxed = isolated;
  if (isolated) {
    places.data_home = data_dir.Append("Desktop").Append("share");
    places.config_home = data_dir.Append("Desktop").Append("config");
  } else {
    places.data_home = xdg_data_home;
    places.config_home = xdg_config_home;
  }
  return places;
}

std::string QuotedExec(std::string_view path) {
  static const base::NoDestructor<re2::RE2> needs_quotes(R"([\s"'\\$`])");
  if (!re2::RE2::PartialMatch(path, *needs_quotes)) {
    return std::string(path);
  }
  std::string quoted = "\"";
  for (char c : path) {
    if (c == '"' || c == '\\' || c == '$' || c == '`') {
      quoted.push_back('\\');
    }
    quoted.push_back(c);
  }
  quoted.push_back('"');
  return quoted;
}

std::string DesktopEntryText(
    std::string_view launcher,
    const std::vector<std::pair<std::string, std::string>>& extra) {
  const std::string exec = QuotedExec(launcher);
  std::vector<std::string> lines = {
      "[Desktop Entry]",
      "Type=Application",
      "Name=Ardia",
      "GenericName=Web Browser",
      "Comment=Browse the web",
      base::StrCat({"Exec=", exec, " %U"}),
      "Icon=ardia",
      "Terminal=false",
      "Categories=Network;WebBrowser;",
      base::StrCat({"MimeType=", base::JoinString(BrowserMimeTypes(), ";"),
                    ";"}),
      base::StrCat({"StartupWMClass=", kWindowClass}),
      "StartupNotify=true",
      "Actions=new-window;",
  };
  for (const auto& [key, value] : extra) {
    lines.push_back(base::StrCat({key, "=", value}));
  }
  lines.insert(lines.end(), {"", "[Desktop Action new-window]",
                             "Name=New Window",
                             base::StrCat({"Exec=", exec, " --new-window"}),
                             ""});
  return base::JoinString(lines, "\n");
}

std::string AutostartEntryText(std::string_view launcher) {
  std::string text = DesktopEntryText(
      launcher, {{"X-GNOME-Autostart-enabled", "true"},
                 {"X-Ardia-Autostart", "true"}});
  const size_t at = text.find(" %U");
  if (at != std::string::npos) {
    text.replace(at, 3, " --autostart");
  }
  return text;
}

std::string WithDefaultApplications(std::string_view existing,
                                    std::string_view desktop_file,
                                    const std::vector<std::string>& types) {
  std::vector<std::string> lines;
  if (!existing.empty()) {
    lines = base::SplitString(existing, "\n", base::KEEP_WHITESPACE,
                              base::SPLIT_WANT_ALL);
  }
  auto trimmed = [](const std::string& line) {
    return std::string(base::TrimWhitespaceASCII(line, base::TRIM_ALL));
  };
  size_t start = lines.size();
  for (size_t i = 0; i < lines.size(); ++i) {
    if (trimmed(lines[i]) == kDefaultsHeader) {
      start = i;
      break;
    }
  }
  if (start == lines.size()) {
    if (!lines.empty() && !lines.back().empty()) {
      lines.push_back("");
    }
    lines.push_back(kDefaultsHeader);
    start = lines.size() - 1;
  }
  size_t end = lines.size();
  for (size_t i = start + 1; i < lines.size(); ++i) {
    if (base::StartsWith(trimmed(lines[i]), "[")) {
      end = i;
      break;
    }
  }
  std::vector<std::string> section;
  for (size_t i = start + 1; i < end; ++i) {
    const bool replaced = std::ranges::any_of(types, [&](const auto& type) {
      return base::StartsWith(lines[i], type + "=");
    });
    if (!replaced) {
      section.push_back(lines[i]);
    }
  }
  while (!section.empty() && section.back().empty()) {
    section.pop_back();
  }
  std::vector<std::string> updated(lines.begin(), lines.begin() + start + 1);
  for (const std::string& type : types) {
    updated.push_back(base::StrCat({type, "=", desktop_file}));
  }
  updated.insert(updated.end(), section.begin(), section.end());
  if (end < lines.size()) {
    updated.push_back("");
  }
  updated.insert(updated.end(), lines.begin() + end, lines.end());
  std::string text = base::JoinString(updated, "\n");
  while (!text.empty() && text.back() == '\n') {
    text.pop_back();
  }
  return text + "\n";
}

std::optional<std::string> DefaultApplicationIn(std::string_view mimeapps,
                                                std::string_view type) {
  bool in_defaults = false;
  const std::string prefix = base::StrCat({type, "="});
  for (std::string_view line : base::SplitStringPiece(
           mimeapps, "\n", base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY)) {
    if (base::StartsWith(line, "[")) {
      in_defaults = line == kDefaultsHeader;
    } else if (in_defaults && base::StartsWith(line, prefix)) {
      std::string_view value = line.substr(prefix.size());
      value = value.substr(0, value.find(';'));
      return value.empty() ? std::nullopt
                           : std::optional<std::string>(value);
    }
  }
  return std::nullopt;
}

ToolRun RunTool(const std::vector<std::string>& argv,
                base::TimeDelta deadline) {
  ToolRun run;
  int out_pipe[2];
  int err_pipe[2];
  if (pipe2(out_pipe, O_CLOEXEC) != 0) {
    return run;
  }
  if (pipe2(err_pipe, O_CLOEXEC) != 0) {
    close(out_pipe[0]);
    close(out_pipe[1]);
    return run;
  }
  base::ScopedFD out_read(out_pipe[0]);
  base::ScopedFD out_write(out_pipe[1]);
  base::ScopedFD err_read(err_pipe[0]);
  base::ScopedFD err_write(err_pipe[1]);
  base::LaunchOptions options;
  options.fds_to_remap.emplace_back(out_write.get(), STDOUT_FILENO);
  options.fds_to_remap.emplace_back(err_write.get(), STDERR_FILENO);
  options.new_process_group = true;
  base::Process process = base::LaunchProcess(argv, options);
  out_write.reset();
  err_write.reset();
  if (!process.IsValid()) {
    run.err = "couldn't start " + argv.front();
    return run;
  }
  const base::TimeTicks give_up = base::TimeTicks::Now() + deadline;
  struct pollfd fds[2] = {{out_read.get(), POLLIN, 0},
                          {err_read.get(), POLLIN, 0}};
  int open_pipes = 2;
  char buffer[4096];
  while (open_pipes > 0) {
    const base::TimeDelta left = give_up - base::TimeTicks::Now();
    if (left <= base::TimeDelta()) {
      run.timed_out = true;
      break;
    }
    const int ready = HANDLE_EINTR(
        poll(fds, 2, static_cast<int>(left.InMilliseconds() + 1)));
    if (ready <= 0) {
      continue;
    }
    for (int i = 0; i < 2; ++i) {
      if (fds[i].fd < 0 || !(fds[i].revents & (POLLIN | POLLHUP | POLLERR))) {
        continue;
      }
      const ssize_t got = HANDLE_EINTR(read(fds[i].fd, buffer, sizeof(buffer)));
      if (got <= 0) {
        fds[i].fd = -1;
        --open_pipes;
        continue;
      }
      (i == 0 ? run.out : run.err).append(buffer, static_cast<size_t>(got));
    }
  }
  int exit_code = -1;
  if (run.timed_out) {
    kill(-process.Pid(), SIGKILL);
    process.WaitForExit(&exit_code);
  } else if (!process.WaitForExitWithTimeout(
                 std::max(give_up - base::TimeTicks::Now(), base::Milliseconds(1)),
                 &exit_code)) {
    run.timed_out = true;
    kill(-process.Pid(), SIGKILL);
    process.WaitForExit(&exit_code);
  }
  run.ok = !run.timed_out && exit_code == 0;
  run.out = std::string(base::TrimWhitespaceASCII(run.out, base::TRIM_ALL));
  run.err = std::string(base::TrimWhitespaceASCII(run.err, base::TRIM_ALL));
  return run;
}

}
