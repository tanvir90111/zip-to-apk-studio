# ZIP to APK Studio

Upload a ZIP, get a debug APK. Two project types are detected automatically:
- **Android Studio project** (has `settings.gradle`): built with Gradle.
- **Website** (has `index.html`): wrapped with Capacitor, then built with Gradle.

Flow: Browser -> Cloudflare Worker (+R2 storage, KV status) -> triggers GitHub Actions -> builder downloads ZIP, builds, uploads APK -> browser polls status and downloads.

## Setup
1. Create a GitHub repo named `zip-to-apk-studio` and push this folder to `main`. A **public** repo gives unlimited free Actions minutes (no secrets are stored in the code).
2. `npm install`, then `npx wrangler login`.
3. `npx wrangler r2 bucket create zip-to-apk`
4. `npx wrangler kv namespace create KV` and paste the printed `id` into `wrangler.toml`. Also set `GH_OWNER` there.
5. GitHub: Settings > Developer settings > Fine-grained token. Select only this repo, permission **Actions: Read and write**.
6. Pick a long random string as `BUILD_TOKEN`. Set Worker secrets:
   ```
   npx wrangler secret put GH_TOKEN
   npx wrangler secret put BUILD_TOKEN
   npx wrangler secret put ACCESS_CODE
   ```
7. GitHub repo > Settings > Secrets and variables > Actions: add secret `BUILD_TOKEN` (same value as above).
8. `npx wrangler deploy`, then open the printed URL.
9. Cloudflare dashboard > R2 > your bucket > Settings: add an object lifecycle rule to delete objects after 1 day.

## Security
- `ACCESS_CODE` is the main gate. Anyone with it can run code on your GitHub runner (Gradle projects execute arbitrary code), so share it only with people you trust.
- The build step runs without any secrets in its environment, and the checkout does not persist credentials.
- Per-IP hourly limit (`HOURLY_LIMIT`), 25 MB upload limit, 25 min build timeout.

## Limits
- Output is a **debug-signed** APK (installs fine, not for Play Store). Release signing needs a keystore stored as a GitHub secret.
- Capacitor 6 + JDK 17. Android projects needing newer JDK/SDK versions may need changes in `build.yml`.
