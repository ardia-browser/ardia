// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/probe.h"

#include <memory>
#include <string>
#include <utility>

#include "ardia/core/ac_launch_switches.h"
#include "ardia/linux/host/host.h"
#include "ardia/linux/log.h"
#include "ardia/linux/ui_host/modules.h"
#include "ardia/linux/windows/app_window.h"
#include "ardia/linux/windows/app_windows.h"
#include "base/base64.h"
#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/task/single_thread_task_runner.h"
#include "base/time/time.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/web_contents.h"
#include "url/gurl.h"

namespace ardia_linux {

namespace {

constexpr char kWindow[] = "probe";
constexpr char kPage[] = "probe-page";

constexpr char kUi[] =
    "<!doctype html><title>ui 0</title>"
    "<style>html,body{margin:0;background:transparent;height:100%}"
    "#bar{position:absolute;left:100px;top:100px;width:300px;height:80px;"
    "background:rgba(220,20,20,.85);border-radius:20px;overflow:auto}"
    "#tall{height:400px}</style>"
    "<div id=bar><div id=tall></div></div>"
    "<script>let n=0;bar.onmousedown=()=>{document.title='ui '+(++n)};"
    "bar.onscroll=()=>{document.title='ui scrolled '+bar.scrollTop}</script>";

constexpr char kPageHtml[] =
    "<!doctype html><title>page 0</title>"
    "<style>html,body{margin:0;background:#1060d0;height:300%}</style>"
    "<input id=field style='margin:250px 0 0 40px'>"
    "<script>let n=0;onmousedown=()=>{document.title='page '+(++n)};"
    "onscroll=()=>{document.title='page scrolled '+scrollY};"
    "field.oninput=()=>{document.title='typed '+field.value}</script>";

std::string DataUrl(const char* html) {
  return std::string("data:text/html;base64,") + base::Base64Encode(html);
}

void ShowPage() {
  base::DictValue args;
  args.Set("key", kPage);
  args.Set("visible", true);
  args.Set("x", 0);
  args.Set("y", 0);
  args.Set("width", 800);
  args.Set("height", 600);
  args.Set("radius", 12);
  base::ListValue holes;
  base::ListValue hole;
  hole.Append(100);
  hole.Append(100);
  hole.Append(300);
  hole.Append(80);
  hole.Append(20);
  holes.Append(std::move(hole));
  args.Set("holes", std::move(holes));
  Host::Get()->Call("tab.show", std::move(args), kWindow,
                    base::BindOnce([](base::DictValue result) {
                      Note("probe", "tab.show: " +
                                        base::WriteJson(result).value_or(""));
                    }));
}

void CreatePage() {
  base::DictValue args;
  args.Set("key", kPage);
  args.Set("url", DataUrl(kPageHtml));
  args.Set("profile", "Default");
  Host::Get()->Call("tab.create", std::move(args), kWindow,
                    base::BindOnce([](base::DictValue result) {
                      Note("probe", "tab.create: " +
                                        base::WriteJson(result).value_or(""));
                      ShowPage();
                    }));
}

}

bool WantsHostProbe() {
  return ardiacore::TestFlag("hostProbe");
}

void StartHostProbe() {
  Profile* profile = ProfileManager::GetLastUsedProfile();
  if (!profile || !ModuleRegistry::Exists()) {
    Note("probe", "no profile");
    return;
  }
  base::DictValue options;
  base::ListValue frame;
  frame.Append(40);
  frame.Append(40);
  frame.Append(800);
  frame.Append(600);
  options.Set("frame", std::move(frame));
  base::ListValue args;
  args.Append(kWindow);
  args.Append(std::move(options));
  ModuleRegistry::Get().CallSync("ArdiaAppWindows", "shapeWindow", args);
  std::unique_ptr<content::WebContents> ui = content::WebContents::Create(
      content::WebContents::CreateParams(profile->GetOriginalProfile()));
  content::WebContents* raw = ui.get();
  if (!AppWindows::Get().Adopt(kWindow, std::move(ui))) {
    Note("probe", "adopt failed");
    return;
  }
  raw->GetController().LoadURL(GURL(DataUrl(kUi)), content::Referrer(),
                               ui::PAGE_TRANSITION_TYPED, std::string());
  if (AppWindow* window = AppWindows::Get().Find(kWindow)) {
    window->Show();
  }
  Note("probe", "window shown; creating the page");
  CreatePage();
}

}
