# Rotate-to-fullscreen video, with popups still visible

## Context

Right now `.video-stage` (client/src/styles/app.css:129) is a fixed 16:9 box that
just scales its width with the page — rotating the phone to landscape doesn't do
anything special, the video simply stays a normal in-flow element, capped at
`.app`'s `max-width: 900px`. There's no orientation handling, no fullscreen
handling, and no resize/orientation JS anywhere in `client/src` (confirmed via
grep — zero matches).

The user wants: rotating to landscape should make the video fill the screen,
like YouTube's own fullscreen player — but naively doing that (e.g. relying on
the YouTube IFrame player's own fullscreen button, which uses the browser
Fullscreen API on the iframe) would break the popups. Here's why: the DOM
structure is

```
.video-stage                 (position: relative, sibling parent)
  YouTubePlayer → iframe
  PopupLayer                 (position: absolute; inset: 0 — sibling of the iframe)
```

The Fullscreen API only shows the fullscreened element (and its descendants).
If the *iframe* goes fullscreen, `PopupLayer` — a sibling, not a descendant —
would simply disappear from view. That's the trap the user is flagging.

The fix is to never let the iframe itself go fullscreen. Instead, make
`.video-stage` — the shared parent that already contains both the player *and*
the popup layer — expand to fill the viewport when the phone is in landscape.
Because `PopupLayer`'s balloons are already positioned with percentage-based
corner offsets relative to `.video-stage` (client/src/styles/balloon.css:96-135,
via the `SLOTS` cycling logic in `useFactSync.js`), simply resizing the shared
container is enough — the popups reflow with it automatically, no JS changes
needed for their positioning.

## Approach

**1. CSS-only "cinema mode" via a media query, not the Fullscreen API.**

In `client/src/styles/app.css`, add a media query gated on
`(orientation: landscape) and (pointer: coarse)` — `pointer: coarse` scopes
this to touchscreens (phones/tablets) so a desktop browser window that happens
to be wide doesn't trigger it. Use the CSS `:has()` selector to scope the
"hide everything else" rule to only apply when a video is actually loaded
(`.video-stage` present as a sibling), so the URL form doesn't disappear when
someone just rotates their phone before loading a video:

```css
@media (orientation: landscape) and (pointer: coarse) {
  .app:has(.video-stage) {
    padding: 0;
    max-width: none;
  }

  .app:has(.video-stage) > *:not(.video-stage) {
    display: none;
  }

  .app:has(.video-stage) .video-stage {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    aspect-ratio: auto;
    border-radius: 0;
    z-index: 1000;
  }
}
```

`position: fixed` pulls `.video-stage` out of `.app`'s constrained, padded,
`max-width: 900px` flow entirely (fixed positioning is relative to the
viewport, not the ancestor chain), so it fills the real screen regardless of
`.app`'s layout — no portal needed, consistent with the rest of the codebase
(no portals are used anywhere).

Rotating back to portrait reverts everything automatically since it's a pure
CSS media query — no JS state to keep in sync, no listener teardown to get
wrong. If a balloon is mid-display when the phone rotates, it just reflows
with the new container size (no special-casing needed in `useFactSync.js`).

Android's Chromium system WebView is auto-updated and has supported `:has()`
since 2022 (Chromium 105+), so this is safe to rely on in the packaged app.

**2. Disable the YouTube player's own fullscreen button.**

In `client/src/hooks/useYouTubePlayer.js:61`, the `playerVars` passed to
`new YT.Player(...)` currently are `{ rel: 0, modestbranding: 1 }`. Add
`fs: 0` to remove YouTube's native fullscreen control:

```js
playerVars: { rel: 0, modestbranding: 1, fs: 0 },
```

Without this, a user could tap YouTube's own fullscreen icon and trigger the
Fullscreen-API-on-the-iframe problem described above, bypassing our CSS-driven
cinema mode and hiding the popups. Our own landscape-triggered "fullscreen" via
`.video-stage` already gives the same fill-the-screen effect, so the native
button is redundant as well as unsafe.

**3. (Optional, minor) Give balloons a bit more room in cinema mode.**

Not required, but worth a quick look after testing on a device: the
`.balloon` cap of `max-width: min(240px, 55%)` (balloon.css:13) was tuned for
the narrow portrait box. In landscape-fullscreen the container is much wider,
so balloons will look small relative to the space — if that reads poorly,
add a targeted rule inside the same media query bumping `.balloon`'s
`max-width` (e.g. to `320px`) and/or font-size. Skip this if it looks fine as-is.

## Explicitly out of scope (per user's choice)

No native Android changes. `AndroidManifest.xml` already has no
`android:screenOrientation` lock and already declares
`android:configChanges="orientation|...|screenSize|..."`, so the Activity
already survives rotation without being recreated — rotation "just works" at
the native layer today. Immersive mode (hiding the status/nav bar in
landscape, like the real YouTube app) was considered and explicitly declined
for now — it would require adding the `@capacitor/status-bar` plugin, a
`npx cap sync`, and a JS-driven show/hide call, for a cosmetic improvement
only. Can be revisited later as a separate follow-up.

## Files to change

- `client/src/styles/app.css` — add the landscape+coarse-pointer media query
  (near `.video-stage`, line ~129).
- `client/src/hooks/useYouTubePlayer.js:61` — add `fs: 0` to `playerVars`.
- `client/src/styles/balloon.css` — optional balloon sizing tweak inside the
  same media query, only if it looks cramped on a real device.

## Verification

1. `cd client && npm run dev`, open in Chrome, toggle device toolbar
   (ensures touch emulation → `pointer: coarse`), pick a phone preset, load a
   video, and rotate the emulated device to landscape — `.video-stage` should
   fill the viewport, header/URL form should disappear, and popups should
   still appear over the video at the expected corners.
   Rotate back to portrait and confirm the normal layout returns.
2. Confirm YouTube's own fullscreen button is gone from the player's control
   bar (it disappears once `fs: 0` takes effect).
3. Build and sync the Android app (`npm run build`, `npx cap sync android`),
   run on a physical device or emulator, load a video, and physically rotate
   the device — confirm the same fullscreen-with-popups behavior, and that
   rotating back to portrait restores the normal page.
4. Spot-check that a balloon actively displayed at the moment of rotation
   reflows correctly into its new corner position without visual glitches.
