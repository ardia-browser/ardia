#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <objc/runtime.h>

#include <cstdio>
#include <cstring>

int main() {
  @autoreleasepool {
    IMP standard = method_getImplementation(class_getClassMethod(NSUserDefaults.class, @selector(standardUserDefaults)));
    Dl_info info = {};
    dladdr((const void *)standard, &info);
    const bool isolated = info.dli_fname && !std::strstr(info.dli_fname, "Foundation");
    std::printf("%s\n", isolated ? "isolated" : "system");
  }
  return 0;
}
