# Deploy Pipeline: GitHub → Vercel + Android Release via Capacitor

## Context

The app currently only runs locally (`npm run dev`), isn't a git repository, and has no CI/CD. The user wants to move to a real deployment (GitHub → Vercel, auto-deploying both the client and the API) and additionally distribute the app as a native Android package: a GitHub Action that builds a signed APK (via Capacitor, wrapping the live deployed site) and attaches it to GitHub Releases.

Decisions already confirmed with the user:
- **GitHub**: no repo exists yet — create one (default: private, trivially flippable to public later).
- **Vercel**: deploy the *whole* app (static client + API), not just the frontend.
- **Capacitor content strategy**: wrap the live Vercel URL in a WebView rather than bundling the static build — simplest, always shows the latest deploy, and the app already requires internet for YouTube + the LLM calls, so no real offline capability is lost.
- **Android release**: a properly signed release APK attached to GitHub Releases (not Play Store), triggered on version tags.
- **App identity**: keep "Pop-up Video" as the display name. Package ID (`applicationId`) proposed as `com.guyhovav.popupvideo` — confirm/personalize this before the first real tagged release, since it's effectively permanent once anyone has installed a build under it.

## Key architectural fact this plan relies on

`server/src/lib/{facts.js,validate.js,promptBuilder.js,providers/*.js}` import nothing from Express — only `server/src/routes/facts.js` and `server/src/index.js` are Express-specific glue. This is exactly the seam that lets a Vercel serverless function reuse the same business logic directly via a relative import, with zero duplication and zero Express dependency in production.

Verified as already true (no restructuring needed): npm workspace dependency hoisting is flat — `@google/genai`, `openai`, `dotenv`, `cors`, `express` all live in the **root** `node_modules/`, not nested under `server/`. A root-level `npm install` (what Vercel runs) reproduces this, so `api/facts.js → server/src/lib/facts.js → providers/gemini.js → '@google/genai'` resolves exactly like it does locally.

---

## Phase A — Git/GitHub bootstrap

1. `git init`, review `.gitignore` (already covers `node_modules/`, `.env`, `client/dist/` — add `.vercel` for later CLI use).
2. Sanity-check `git status` before the first commit specifically to confirm `server/.env` (real live API keys) is not staged.
3. `git add -A && git commit -m "Initial commit"`.
4. `gh repo create <name> --private --source=. --remote=origin` — **needs explicit confirmation at execution time**.
5. `git push -u origin main` — **needs explicit confirmation at execution time**.

---

## Phase B — Vercel deploy (client + API as serverless functions)

### New files

**`vercel.json`** (repo root):
```json
{
  "framework": null,
  "buildCommand": "npm run build -w client",
  "outputDirectory": "client/dist",
  "installCommand": "npm install",
  "functions": {
    "api/**/*.js": { "maxDuration": 30 }
  }
}
```
`framework: null` avoids auto-detection guesswork (the root isn't itself a Vite project). No `rewrites` needed — Vercel auto-maps `/api/*.js` to functions, and the app is single-page with no client router (per `client/PRODUCT.md`), so no SPA fallback is needed either. `maxDuration: 30` is a deliberate explicit budget given the Gemini→OpenAI retry chain can take several seconds (see Risks).

**`api/facts.js`** (repo root) — thin adapter reusing the existing lib as-is:
```js
import { validateFactsRequest, ValidationError } from '../server/src/lib/validate.js';
import { computeFactCount, generateFacts } from '../server/src/lib/facts.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  let validated;
  try {
    validated = validateFactsRequest(req.body);
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }

  const { videoId, title, author, durationSeconds } = validated;
  const factCount = computeFactCount(durationSeconds);

  try {
    const { facts, degraded } = await generateFacts({ title, author, durationSeconds, factCount });
    res.status(200).json({ videoId, facts, degraded });
  } catch (err) {
    console.error('Failed to generate facts:', err);
    res.status(err.status || 502).json({ error: 'generation_failed' });
  }
}
```
Mirrors `server/src/routes/facts.js` logic exactly, just on Vercel's plain `(req, res)` handler signature instead of an Express `Router`. Vercel's Node runtime auto-parses JSON bodies into `req.body`, same as `express.json()` locally.

**`api/health.js`** (repo root, recommended): zero-dependency smoke-test endpoint (`res.status(200).json({ ok: true })`) — confirms the function runtime boots independent of the LLM call path.

### Modified files

**Root `package.json`**: add `"type": "module"` (required — `api/facts.js` uses `import`/`export`, and its nearest `package.json` is the root one, which currently has no `type` field and would default to CommonJS), `"engines": { "node": "22.x" }` to pin the runtime, and — as cheap insurance against future hoisting changes — list `@google/genai` and `openai` directly as root dependencies too (matching `server/package.json`'s versions).

**`.gitignore`**: add `.vercel`.

### Manual, one-time setup (not committed to the repo)

1. Vercel dashboard → "Add New Project" → import the GitHub repo. Keep Root Directory as the repo root (not `client/`) since `vercel.json`/`api/` both live there.
2. Project Settings → Environment Variables: add `GEMINI_API_KEY` and `OPENAI_API_KEY` for **both Production and Preview** environments — easy to miss Preview, which would silently run PR deploys on the hardcoded-fallback path (`degraded: true`) while looking like it works.
3. Deploy. Vercel's own GitHub App integration handles auto-deploy-on-push from here — **no GitHub Actions workflow needed for this half**; that's a separate concern from the Android pipeline in Phase D.
4. Note the production URL — required as an input to Phase C.

### Verification (do this before touching Capacitor)

1. Load the deployed URL directly — confirm the static build (`index.html` + hashed assets) serves correctly.
2. `curl https://<deployed-url>/api/health` → `{"ok":true}`.
3. Paste a real YouTube URL on the deployed site; confirm balloons appear, and check the Network tab for a same-origin `200 POST /api/facts` with `"degraded": false` (confirms a real provider key works in the Vercel environment, not just the fallback).
4. Check Vercel's function logs for that invocation — this is where any ESM/module-resolution issue would surface (e.g. `Cannot find module`).
5. Test one validation-error case (malformed request) to confirm `400` responses pass through.

---

## Phase C — Capacitor Android wrapper (live-URL WebView)

Only start this once Phase B's production URL is confirmed stable and working.

### Setup
```bash
npm install @capacitor/core @capacitor/android -w client
npm install -D @capacitor/cli -w client
```

**`client/capacitor.config.json`** (new):
```json
{
  "appId": "com.guyhovav.popupvideo",
  "appName": "Pop-up Video",
  "webDir": "dist",
  "server": {
    "url": "https://<your-vercel-production-domain>",
    "cleartext": false
  }
}
```
`webDir: "dist"` still needs to point somewhere valid (Capacitor requires a local web dir even in `server.url` mode, used as the bundled offline/fallback shell) — resolves to `client/dist`, the existing Vite build output. No client code changes needed anywhere: the WebView loads the real deployed page, which already calls `/api/facts` as a relative same-origin URL.

```bash
cd client
npx cap add android      # generates client/android/ — commit this, standard Capacitor practice
npx cap sync android
```

Harden `client/android/.gitignore` (or root) with `keystore.properties`, `app/*.keystore`, `app/*.jks` — defense-in-depth so a locally-generated keystore/properties file can never accidentally get committed.

---

## Phase D — Android release signing + GitHub Actions

### D.1 — Keystore generation (user runs locally, once — not automated; a real signing key shouldn't be fabricated by an agent)
```bash
keytool -genkeypair -v \
  -keystore popupvideo-release.keystore \
  -alias popupvideo \
  -keyalg RSA -keysize 2048 -validity 10000
```
**Back up the resulting `.keystore` file and all passwords somewhere durable and personal** (password manager, encrypted storage) before relying on GitHub Secrets, which are write-only — losing this key means all future releases need a new `applicationId`, breaking upgrade-in-place for anyone who already installed a build.

### D.2 — Store as GitHub secrets (needs explicit confirmation at execution time)
```bash
base64 -w0 popupvideo-release.keystore > popupvideo-release.keystore.base64
gh secret set ANDROID_KEYSTORE_BASE64 < popupvideo-release.keystore.base64
gh secret set ANDROID_KEYSTORE_PASSWORD
gh secret set ANDROID_KEY_ALIAS
gh secret set ANDROID_KEY_PASSWORD
```
Delete the local `.base64` file afterward.

### D.3 — Gradle signing wiring (`client/android/app/build.gradle`)

A fresh `cap add android` project only has debug signing — `assembleRelease` produces an unsigned APK by default. Add the standard `keystore.properties`-based pattern:

```groovy
// top of file, before android { ... }
def keystorePropertiesFile = rootProject.file("keystore.properties")
def keystoreProperties = new Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}
```
```groovy
// inside android { ... }
signingConfigs {
    release {
        if (keystorePropertiesFile.exists()) {
            storeFile file(keystoreProperties['storeFile'])
            storePassword keystoreProperties['storePassword']
            keyAlias keystoreProperties['keyAlias']
            keyPassword keystoreProperties['keyPassword']
        }
    }
}
buildTypes {
    release {
        signingConfig signingConfigs.release
        minifyEnabled false
        proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
    }
}
```
`keystore.properties` (generated fresh at CI time, never committed) expects `storeFile=release.keystore` resolved relative to the `app/` module dir. Also bump `defaultConfig.versionCode`/`versionName` here manually before each release tag.

### D.4 — `.github/workflows/android-release.yml` (new)

```yaml
name: Android Release

on:
  push:
    tags:
      - 'v*.*.*'
  workflow_dispatch:
    inputs:
      note:
        description: 'Manual test run (no tag/release created)'
        required: false

permissions:
  contents: write

jobs:
  build-and-release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'

      - uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '21'

      - name: Install dependencies
        run: npm ci

      - name: Build client (Capacitor webDir fallback shell)
        run: npm run build -w client

      - name: Sync Capacitor Android project
        working-directory: client
        run: npx cap sync android

      - name: Make gradlew executable
        run: chmod +x client/android/gradlew

      - name: Decode signing keystore
        working-directory: client/android
        run: echo "${{ secrets.ANDROID_KEYSTORE_BASE64 }}" | base64 -d > app/release.keystore

      - name: Write keystore.properties
        working-directory: client/android
        run: |
          cat > keystore.properties <<EOF
          storeFile=release.keystore
          storePassword=${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          keyAlias=${{ secrets.ANDROID_KEY_ALIAS }}
          keyPassword=${{ secrets.ANDROID_KEY_PASSWORD }}
          EOF

      - name: Build signed release APK
        working-directory: client/android
        run: ./gradlew assembleRelease

      - name: Upload APK as workflow artifact
        uses: actions/upload-artifact@v4
        with:
          name: popupvideo-release-apk
          path: client/android/app/build/outputs/apk/release/app-release.apk

      - name: Create GitHub Release and attach APK
        if: startsWith(github.ref, 'refs/tags/v')
        uses: softprops/action-gh-release@v2
        with:
          files: client/android/app/build/outputs/apk/release/app-release.apk
```

Trigger is a `v*.*.*` tag push for real releases, plus `workflow_dispatch` for dry-run testing the whole pipeline first. APK (not AAB) is correct here since distribution is GitHub Releases/sideloading, not the Play Store. Java 21 matches Capacitor 7's current requirement.

### D.5 — Test sequence before a real release

1. Commit all of Phase C + D's files; confirm the four secrets are set.
2. `gh workflow run android-release.yml` (manual trigger) — **before ever pushing a real tag**.
3. Download the `popupvideo-release-apk` artifact from the run.
4. Sideload (`adb install app-release.apk`) onto a device/emulator; confirm the app launches showing the live Vercel site (not a blank offline shell), and that pasting a URL + playback works end-to-end through the real deployed API. Specifically check fullscreen/autoplay behavior on the embedded YouTube player (see Risks).
5. Optionally confirm signing took effect: `apksigner verify app-release.apk`.
6. Only then bump `versionCode`/`versionName`, commit, and cut the first real release: `git tag v1.0.0 && git push origin v1.0.0`.

---

## Known risks (verify, don't pre-solve)

1. **Vercel function duration vs. the multi-provider retry chain.** Gemini retries up to 3x (1s/2s backoff), then OpenAI up to 2x — worst case can exceed 10s. Mitigated by explicit `maxDuration: 30` in `vercel.json`; if real testing still shows timeouts, follow-ups are enabling Fluid Compute (if on the plan) or tightening retry budgets in `providers/*.js` (a code change, out of scope here).
2. **Cold starts** add to first-invocation latency on top of the LLM call — watch Vercel's function logs post-deploy.
3. **Preview vs Production env vars** must both be set in Vercel's dashboard, or preview deploys silently run degraded.
4. **Hoisting fragility**: the `/api` → `server/src/lib` relative-import approach works because dependency hoisting is currently flat (verified) — not structurally guaranteed forever. Mitigated by also listing the two LLM SDKs as root-level dependencies. If it ever breaks (symptom: `Cannot find module` in Vercel build logs only), the fix is extracting `server/src/lib/*` into a proper shared workspace package — not needed now.
5. **YouTube iframe inside an Android WebView** has known autoplay/fullscreen quirks (Capacitor's default bridge doesn't implement `WebChromeClient.onShowCustomView`, which real fullscreen video expansion needs) — not solved by this plan, flagged as a required on-device check in D.5. A fix, if needed, is a native WebView customization or Capacitor plugin — separate follow-up work.
6. **Signing key loss is effectively permanent** — back it up outside GitHub Secrets (write-only once set).
7. **Play Store note (informational only, since it's out of scope)**: a live-URL WebView wrapper is sometimes flagged by Play Store review as a "thin wrapper" app. Irrelevant for GitHub-Release-only distribution as decided here; would need revisiting (bundling the static build instead) if Play Store distribution is ever considered later.

## File manifest

**New**: `vercel.json`, `api/facts.js`, `api/health.js`, `client/capacitor.config.json`, `client/android/` (generated), `.github/workflows/android-release.yml`.

**Modified**: root `package.json` (`type: module`, `engines`, optional direct deps), root `.gitignore` (`.vercel`), `client/package.json` (Capacitor deps), `client/android/.gitignore` (keystore hardening), `client/android/app/build.gradle` (signing config + version bump per release).

**Manual/non-repo steps**: `git init`/`gh repo create`/push (Phase A); Vercel project import + env vars (Phase B); `keytool` + `gh secret set` ×4 (Phase D.1–D.2); `workflow_dispatch` dry run before the first real tag (Phase D.5).
