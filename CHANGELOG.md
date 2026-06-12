# Changelog

## 0.2.0 - 2026-06-13

### Added

- GitHub OAuth integration with automatic article archiving to a GitHub repository.
- Multi-mode resumable scraping with interruptible runs and local file locating.
- One-click backfill of all missing article bodies.
- Resume-scraping progress dialog.

### Fixed

- One-click re-login with automatic status sync when account authentication fails.
- Historical progress events no longer spin indefinitely.

## 0.1.9 - 2026-05-24

### Added

- Added a Lovstudio login-only top bar state for signed-out users.
- Added an authorized-account summary and detailed account list in license administration.

### Changed

- Split authorization and quota controls into separate tabs in the admin dialog.
- Improved authorized-account labels to prefer user email, with explicit notes and account IDs.
- Renamed frequency-management copy to quota-management copy for clearer admin wording.

## 0.1.8 - 2026-05-22

### Fixed

- Enabled Tauri updater artifact generation so CI publishes signed update bundles and `latest.json`.

## 0.1.7 - 2026-05-22

### Fixed

- Fixed macOS Apple Silicon bundled `wcx` startup by signing the PyInstaller sidecar with library-validation entitlements and packaging it through a module entry point.
- Added release smoke tests for both raw and packaged `wcx` sidecars so broken CLI bundles fail CI before publication.

### Added

- Added admin license assignment by registered Lovstudio account email.

## 0.1.6 - 2026-05-09

### Added

- **Bundled wcx sidecar**: wcx Python CLI is now frozen via PyInstaller and shipped inside the app binary. Users no longer need to install wcx or Python separately.
- **Auto-update**: the app checks for updates on startup and prompts users to install and restart when a new version is available.

### Changed

- Replaced inline Python scripts with dedicated wcx CLI subcommands (`search-accounts-json`, `fetch-article-content-json`, `fetch-selected-account-json`).
- `locate_wcx()` now checks the bundled sidecar next to the app binary first, then falls back to system paths.

## 0.1.5 - 2026-05-09

### Fixed

- Fixed website hero layout overlap by tightening hero copy width and moving the product backdrop into the normal responsive flow on narrower screens.

## 0.1.4 - 2026-05-08

### Fixed

- Routed Lovstudio desktop login through `wxmp.lovstudio.ai` so the app no longer depends on the currently misconfigured `lovstudio.ai` DNS target.
- Added `wxmp.lovstudio.ai` device-auth start, poll, authorize, and auth routes for Lovstudio account login.
- Added request timeouts and explicit Lovstudio login service errors so the login button cannot spin forever.
- Excluded generated Tauri build output from ESLint scans.

## 0.1.3 - 2026-05-08

### Fixed

- Fixed blank desktop windows in published builds by injecting Lovstudio Supabase frontend settings into release jobs.
- Split the public website entry from the Tauri workspace bundle so the website does not initialize desktop-only Supabase code.
- Added a desktop startup error boundary so configuration failures show a clear message instead of a blank window.

### Changed

- Updated the app version to `0.1.3` across package and Tauri metadata.

## 0.1.2 - 2026-05-08

### Added

- Added resource quota and gateway status panels for hourly allowance, provider health, execution pool, queue, and alerts.
- Added WeChat capability settings for self-use preference and commercial support authorization.
- Added Supabase gateway request, provider lease, execution report, health, and alert schema support.
- Added an in-app gateway worker that can claim and complete queued WeChat account fetch requests.

### Changed

- Routed article content fetches through provider execution reporting so quota and health metrics stay current.
- Removed compiled fallback Supabase project credentials from the Tauri backend and load publishable frontend settings at build time.
- Improved mobile reader navigation with a dedicated article-list/detail layout and back action.
- Updated the app version to `0.1.2` across package and Tauri metadata.

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
