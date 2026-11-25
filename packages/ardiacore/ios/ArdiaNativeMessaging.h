#pragma once

#import <Foundation/Foundation.h>

namespace ardia_native_messaging {

void SyncHosts(NSString *userDataDir);
NSDictionary<NSString *, NSNumber *> *ProbeHosts(NSString *userDataDir);

}
