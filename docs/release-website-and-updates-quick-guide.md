# STU-LS Release And Update Guide (Step-by-Step)

This guide is written for Windows-first development and explains exactly where files are stored and where signing keys are used.

## 1) Where Release Files Are Stored

### A) After local Windows build
Run from project root:
1. `npm run release:windows`

Output location on your machine:
1. `apps/desktop/src-tauri/target/release/bundle/msi/`
2. `apps/desktop/src-tauri/target/release/bundle/nsis/`

Current file examples in your project:
1. `apps/desktop/src-tauri/target/release/bundle/msi/STU-LS Desktop_0.1.0_x64_en-US.msi`
2. `apps/desktop/src-tauri/target/release/bundle/nsis/STU-LS Desktop_0.1.0_x64-setup.exe`

### B) After local macOS build
Run from a macOS machine only:
1. `npm run release:mac`

Expected output location:
1. `apps/desktop/src-tauri/target/release/bundle/dmg/`

### C) After local Linux build
Run from a Linux machine only:
1. `npm run release:linux`

Expected output location:
1. `apps/desktop/src-tauri/target/release/bundle/appimage/`
2. `apps/desktop/src-tauri/target/release/bundle/deb/`
3. `apps/desktop/src-tauri/target/release/bundle/rpm/`

### D) After GitHub Actions macOS workflow
Workflow file:
1. [.github/workflows/build-macos-dmg.yml](.github/workflows/build-macos-dmg.yml)

Where files appear in GitHub:
1. If you click Run workflow manually: GitHub Actions run -> Artifacts -> `stu-ls-desktop-macos-dmg`
2. If you push a tag like `v0.1.1`: GitHub Release page for that tag -> Assets section (DMG attached automatically)

Important:
1. Pushing code to `main` does not automatically create a release asset.
2. Tag push (`v*`) is what triggers DMG publish to GitHub Release in current workflow.

## 2) Where And When To Use Signing Keys

### A) Generate keys (one-time)
Run from project root:
1. `npm --workspace @stu-ls/desktop run tauri -- signer generate`

You will get:
1. Private key (secret)
2. Public key (safe to store in repo)

### B) Where to store public key
File:
1. [apps/desktop/src-tauri/tauri.conf.json](apps/desktop/src-tauri/tauri.conf.json)

Field:
1. `plugins.updater.pubkey`

This is already set in your project.

### C) Where to store private key and password
Do not put private key in code files.

Use GitHub repository secrets:
1. `TAURI_SIGNING_PRIVATE_KEY`
2. `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

GitHub path:
1. Repository -> Settings -> Secrets and variables -> Actions -> New repository secret

### D) When private key is used
Private key is used at build time, not at app runtime.

Use it when:
1. Building release bundles for updater distribution
2. Creating signed updater metadata and signatures

Not used when:
1. Running normal app development (`npm run dev:desktop`)
2. Regular backend-server deployment

## 3) Step-by-Step Release Flow (Easy Mode)

### Step 1: Update version
1. Edit [apps/desktop/package.json](apps/desktop/package.json) -> `version`
2. Edit [apps/desktop/src-tauri/tauri.conf.json](apps/desktop/src-tauri/tauri.conf.json) -> `version`
3. Keep both versions exactly the same

### Step 2: Push code
1. `git add .`
2. `git commit -m "release v0.1.1"`
3. `git push`

### Step 3: Create release tag
1. `git tag v0.1.1`
2. `git push origin v0.1.1`

### Step 4: Wait for GitHub workflow
1. Open Actions tab
2. Open Build macOS DMG workflow run
3. Confirm success

### Step 5: Find files in GitHub
1. For tag run: Repo -> Releases -> `v0.1.1` -> Assets (DMG file)
2. For manual run: Actions run -> Artifacts -> `stu-ls-desktop-macos-dmg`

### Step 6: Publish website download link
1. Use Windows installer from local build output (`.msi` or setup `.exe`)
2. Use macOS DMG from GitHub Release assets
3. Point website buttons to those files

## 4) Step-by-Step Troubleshooting

### Problem: `npm error Missing script: "tauri"`
Cause:
1. Command was run at root where no `tauri` script exists

Fix:
1. `npm --workspace @stu-ls/desktop run tauri -- signer generate`

### Problem: `invalid value 'dmg'` or mac release fails on Windows
Cause:
1. DMG can only be built on macOS host

Fix:
1. Use GitHub Actions macOS workflow
2. Or run release on a real macOS machine

### Problem: Release exists but app does not update
Check:
1. Version was increased
2. Public key in `tauri.conf.json` matches private key pair
3. Release has required signed updater files
4. Endpoint URL is correct:
5. `https://github.com/Sudharmas/STU-LS/releases/latest/download/latest.json`

## 5) Final Checklist Before Every Release
1. Version bumped in both files
2. Tag created and pushed (`v*`)
3. GitHub workflow finished successfully
4. DMG visible in Release assets
5. Windows installer exists in local bundle folders
6. Test update from one old installed app
