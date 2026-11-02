# LocalHub

A **local, all-in-one messenger** — combine many web services (WhatsApp, Telegram,
Gmail, Slack, Discord, …) in one window, each with its own isolated login, plus
unread counters and desktop notifications.

Inspired by the *idea* of apps like Rambox, but built from scratch and **fully
local**: no account, no cloud sync, no telemetry. Your service list lives in a
plain JSON file on your machine, and each service's session (cookies/logins) is
stored locally and separately.

## Features

- **Many services in one window** — added as isolated `<webview>` tabs.
- **Multiple accounts** — add the same service twice; each gets its own session
  (`persist:<id>` partition), so two WhatsApp/Gmail logins never mix.
- **Unread badges** — per-service counter in the rail + a total on the tray/taskbar.
- **Notifications** — native OS notifications pass through, and the taskbar icon
  flashes when a message arrives in a background service.
- **Runs in the tray** — closing the window keeps it running so notifications work.
- **Add / edit / reorder / remove** services via right-click.
- **External links** open in your default browser.

## Security posture

- `contextIsolation: true`, `nodeIntegration: false` everywhere.
- Each embedded service runs in its own partitioned session.
- Permission requests are limited to what a messenger needs (notifications,
  media, clipboard-read, fullscreen).

## Run it

```bash
npm install
npm run icon
npm start
```

## Where is my data?

- Service list: `<userData>/services.json`
- Per-service logins: `<userData>/Partitions/<id>/`

On Windows `<userData>` is `%APPDATA%\LocalHub`.

## Auto-update via GitHub Releases

The app updates itself from this repo's GitHub Releases (using `electron-updater`),
the same mechanism Rambox uses. It checks on launch and every 6 hours; when a newer
release exists it downloads in the background and offers to restart.

### One-time setup

1. Create a GitHub repo (e.g. `localhub`).
2. In `package.json` → `build.publish`, set `owner` to your GitHub username
   (replace `YOUR_GITHUB_USERNAME`) and `repo` to the repo name.
3. Connect and push:

   ```bash
   git remote add origin https://github.com/<you>/localhub.git
   git branch -M main
   git push -u origin main
   ```

### Cutting a new version

```bash
npm version patch      # bumps package.json (1.0.0 -> 1.0.1) and creates a git tag
git push --follow-tags
```

Pushing the `v*` tag triggers `.github/workflows/release.yml`, which builds the
Windows installer on a GitHub runner and publishes it (plus `latest.yml`) to a
GitHub Release. Installed apps pick it up automatically — no code signing needed
for updates to work (users still see a SmartScreen prompt on first manual install
of an unsigned build).

> The workflow uses the built-in `GITHUB_TOKEN`, so no extra secrets are required
> to publish to the same repository.

## Notes / limitations

- Unread counts are read from each service's tab title (the common heuristic);
  a service that doesn't put a number in its title won't show a count, but its
  notifications still flash the window.
- This is an MVP. Easy next steps: per-service "mute", global/Do-Not-Disturb,
  notification sounds, drag-to-reorder, service presets, and packaging with
  `electron-builder` for a double-click installer.
