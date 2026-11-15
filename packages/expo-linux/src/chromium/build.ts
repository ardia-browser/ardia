declare const __ARDIA_VERSION__: string;
declare const __ARDIA_BUILD__: string;
declare const __ARDIA_NATIVE_API_VERSION__: number;
declare const __ARDIA_DEBUG__: boolean;
declare const __ARDIA_UPDATE_REPOSITORY__: string;

export const APP_VERSION = __ARDIA_VERSION__;
export const APP_BUILD = __ARDIA_BUILD__;
export const NATIVE_API_VERSION = __ARDIA_NATIVE_API_VERSION__;
export const DEBUG_BUILD = __ARDIA_DEBUG__;
export const BUNDLE_ID = "dev.ardia.browser";
export const RELEASE_NOTES_PAGE = "https://ardia.dev/release-notes";
export const UPDATE_REPOSITORY = __ARDIA_UPDATE_REPOSITORY__;
export const RELEASES_PAGE = `https://github.com/${UPDATE_REPOSITORY}/releases`;
