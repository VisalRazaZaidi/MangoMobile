# Contributor guidance

MangoMobile is a Windows Electron/Vue/TypeScript app for Android storage over ADB. Run commands from this directory.

- `npm ci` installs development dependencies.
- `npm run typecheck` and `npm test` validate code changes.
- `npm run build` builds the app; `npm run smoke` runs cleanup/restore/preview checks using an isolated demo profile.
- `npm run build:win` creates installer and portable x64 builds in `release/`, then removes older versioned installers once both new builds succeed.

Keep device operations behind `src/main/adb/transport.ts`, product logic in `src/main/core/`, and UI access through the typed preload API. Preserve path validation, cleanup preview, explicit confirmation and verification. Use demo data for automated mutation tests; do not delete files on a real connected phone without an explicit request.

Keep the Mango identity and both themes accessible. Treemap geometry uses actual container dimensions and must include grouped/omitted bytes. Screenshots containing simulated data must be labelled as demo. The public website lives in the separate `VisalRazaZaidi/visalrazazaidi.github.io` repository.
