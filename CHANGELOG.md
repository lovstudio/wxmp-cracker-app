# Changelog

## 0.1.1 - 2026-05-08

### Added

- Added Apple Developer ID signing and notarization support to the release workflow.
- Added Lovstudio account login, cloud license synchronization, in-app license administration, and quota helpers.
- Added Supabase schema for `wxmp_licenses`, quota settings, and user capabilities.

### Changed

- Updated macOS release notes to remove the unsigned-app workaround.
- Updated the app version to `0.1.1` across package and Tauri metadata.

## 0.1.0 - 2026-05-07

### Added

- First Tauri desktop release of 微探 for browsing local `wcx` WeChat public account caches.
- Added in-app account search and fetch flow with progress events from the desktop backend.
- Added account workspace tabs for collection management, profile, trend analysis, and writing style analysis.
- Added license activation gate with trial and official activation code support.
- Added Supabase-backed LovStudio account sign-in screens for the frontend shell.

### Changed

- Switched the desktop dev server port to `4382`.
- Updated the app version to `0.1.0` across the Tauri bundle and package metadata.
