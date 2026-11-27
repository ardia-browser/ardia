#pragma once

#import <Foundation/Foundation.h>

namespace ardia_extensions {

bool IsExtensionId(NSString *s);

NSDictionary *ReadManifest(NSString *folder);

NSDictionary<NSString *, NSNumber *> *NewTabOverrideRanks(NSString *preferencesPath);

NSString *IdForKey(NSString *base64Key);

NSString *DataURL(NSString *folder, NSString *relativePath);

}
