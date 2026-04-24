# STU-LS Deployment (Backend Server + Desktop)

## Overview
1. Local desktop database remains SQLite.
2. Online database remains Supabase Postgres.
3. Update propagation runs through the hosted `backend-server` bridge route:
- `POST /sync/bridge`
4. Student update availability and pull logic stay server-driven as implemented in the sync architecture.

## 1) Backend Server Hosting On Render

### Service Setup
1. Create a new Render Web Service from this repository.
2. Service root directory: `backend-server`
3. Build command:
- `npm install`
4. Start command:
- `npm start`

### Required Render Environment Variables
1. `SUPABASE_DB_URL`
- Postgres connection string for your existing Supabase database.
- Keep using the same existing Supabase project and schema.

2. `BACKEND_SERVER_BEARER_TOKEN`
- Strong random token.
- Desktop app sends this token as Bearer auth for `/sync/bridge`.

### Optional Render Environment Variables
1. `BACKEND_SERVER_CORS_ORIGINS`
- Comma-separated browser origins allowed by CORS.
- Leave empty to allow all origins.

2. `SYNC_SERVER_HOST`
- Default `0.0.0.0`.

3. `SYNC_SERVER_PORT`
- Local fallback only.
- On Render, `PORT` is injected automatically and used first.

Notes:
1. Health endpoint is `GET /health`.
2. The server now supports both Render (`PORT`) and local execution (`SYNC_SERVER_PORT`).

## 2) Supabase Schema And Migrations
1. Apply backend migrations before first production sync:
- `npm run db:migrate:backend`
2. Ensure all sync tables and student update tracking tables exist.
3. No schema reset is required if your current Supabase schema is already in use.

## 3) Desktop App Configuration For Hosted + Local Modes

Create [apps/desktop/.env](apps/desktop/.env) from [apps/desktop/.env.example](apps/desktop/.env.example).

### Required For Hosted Mode
1. `VITE_SYNC_SERVER_URL=https://<your-render-service>.onrender.com`
2. `VITE_SYNC_BEARER_TOKEN=<same value as BACKEND_SERVER_BEARER_TOKEN>`

### Recommended For Dual Mode (Hosted First, Local Fallback)
1. `VITE_SYNC_FALLBACK_URLS=http://localhost:8090`

Runtime behavior now:
1. Desktop tries `VITE_SYNC_SERVER_URL` first.
2. If unreachable, desktop tries each URL in `VITE_SYNC_FALLBACK_URLS`.
3. If none are reachable, app stays offline and continues with local SQLite data.
4. Once a sync server is reachable, push/pull continues through `/sync/bridge`.

## 4) Local Development Commands
1. Install dependencies:
- `npm install`

2. Run desktop + backend-server locally:
- `npm run run:app`

3. Run desktop only:
- `npm run dev:desktop`

4. Run backend-server only:
- `npm run dev:backend-server`

## 5) App Launching Guide (What End Users Need)
1. Installer behavior:
- Desktop app always launches with local SQLite available.
- User can login and work offline immediately if local account exists.

2. Sync behavior after launch:
- App checks configured sync URL(s).
- If online, it runs sync and refreshes data.
- If offline, it keeps local data and tries again on subsequent refresh/sync cycles.

3. Session behavior:
- Session is retained across in-app refresh.
- Session ends on explicit logout or app close.

4. Hosted + local fallback behavior:
- Primary endpoint: `VITE_SYNC_SERVER_URL`.
- Fallback endpoints: `VITE_SYNC_FALLBACK_URLS`.

## 6) Operations Checklist (Production)
1. Deploy backend-server and confirm `GET /health` returns `ok: true`.
2. Apply migrations with `npm run db:migrate:backend`.
3. Set desktop build-time env to hosted URL/token.
4. Distribute desktop installer build.
5. Verify one lecturer update and one student pull-update cycle.

## 7) Verification Checklist
1. Hosted backend health:
- `GET https://<render-url>/health` returns `ok: true`.

2. Desktop startup:
- Status should show online when hosted/local server is reachable.

3. Sync behavior:
- Lecturer updates to student-linked records should set update flags server-side.
- Student sync run should fetch pull changes when `update_available` is true.
- If no update is available, student continues from local DB state.

## 8) Build And Release
1. Build desktop app:
- `npm run build:desktop`
2. Platform installers:
- `npm run release:windows` (run on Windows)
- `npm run release:mac` (run on macOS)
- `npm run release:linux` (run on Linux)
3. Cross-OS packaging note:
- You cannot create a DMG from Windows/Linux.
- Use GitHub Actions on `macos-latest` for DMG builds when developing on Windows.

## 9) Publishing On Your Website + In-App Updates

### A) Should You Directly Link Installer Files?
1. For first install: yes, your website can host download links for installer files.
2. For future updates: do not rely only on manual website downloads.
3. Use an update feed so the app itself can detect and install new versions.

### B) Recommended Distribution Channel
1. Publish release artifacts to GitHub Releases (recommended), OR host equivalent artifacts/manifest on your own server.
2. Keep website download buttons pointing to latest stable release for first-time users.
3. Existing installed users update directly from inside the app using updater checks.
4. Repository workflow for macOS DMG:
- `.github/workflows/build-macos-dmg.yml` builds DMG on macOS.
- Manual run (`workflow_dispatch`) uploads DMG as a workflow artifact.
- Tag push (`v*`) uploads DMG and attaches it to the matching GitHub Release.
5. Important storage note:
- There is no `releases` folder in repo root.
- GitHub Release files are in the GitHub Releases UI under each tag's Assets section.

### C) In-App Updater Flow Implemented
1. Desktop now includes:
- Update check button.
- Download + install update action.
- Restart-to-apply action.
2. Updater uses Tauri updater plugin configuration in:
- `apps/desktop/src-tauri/tauri.conf.json`

### D) Required Updater Setup Before Production
1. Generate updater signing key pair (one-time):
- Keep private key secret.
- Put public key in `tauri.conf.json` field `plugins.updater.pubkey`.

2. Configure update endpoint:
- Use GitHub Releases latest manifest URL:
  - `https://github.com/OWNER/REPO/releases/latest/download/latest.json`
- Replace `OWNER/REPO` with your repository.

3. Ensure updater artifact generation is enabled in `tauri.conf.json`:
- Set `bundle.createUpdaterArtifacts`.
- For `latest.json` endpoint style, use `"createUpdaterArtifacts": "v1Compatible"`.

4. Publish signed updater artifacts for each release.

5. Verify release Assets include:
- installer files (`.dmg`, `.msi`, `.exe` as applicable)
- `latest.json`
- signature files (`.sig`)

6. Bump app version in:
- `apps/desktop/src-tauri/tauri.conf.json` (`version`)
- `apps/desktop/package.json` (`version`)

### E) Website + GitHub Practical Model
1. Website:
- "Download STU-LS" button -> latest installer.
2. GitHub Releases:
- Source of release artifacts and updater metadata.
3. App:
- Users click "Check for Updates" in app.
- If new version exists, app downloads and applies without requiring manual website revisit.

### F) Notes
1. For strict enterprise environments, you can host updater files on your own domain instead of GitHub.
2. Keep endpoint HTTPS and stable.
3. Test one full update cycle in staging before public rollout.

## 10) Quick Reference
Use [docs/release-website-and-updates-quick-guide.md](docs/release-website-and-updates-quick-guide.md) for a short website-first + in-app update checklist.
