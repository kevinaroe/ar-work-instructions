# AR Work Instructions

Step-by-step work instructions students follow **while wearing AR goggles**, standing
at the machine. First job in the library: engraving a dog tag on the
**Bambu Lab H2D laser module**.

---

## What it is

A single web page that runs three ways from one codebase:

| Device | What happens |
|---|---|
| Meta Quest 3 / 3S (Quest Browser) | Immersive AR. Instructions float over passthrough while hands stay free. |
| ARCore phone or tablet (Chrome) | Handheld AR, same overlay. |
| Any laptop, tablet or phone | Plain 2D checklist. Same content, nothing lost. |

There is **no build step, no framework, and no app-store submission**. It is HTML,
CSS and one JavaScript file. Edit a file, reload the headset browser, done.

### Why WebXR DOM Overlay instead of Unity

The AR mode uses `immersive-ar` with a [DOM Overlay], which paints the *actual page DOM*
in front of passthrough. That means the AR view and the 2D fallback are the same UI —
one thing to maintain, and it works on hardware we haven't bought yet. The WebGL
context in `app.js` exists only because WebXR requires a base layer; it is cleared
fully transparent every frame and draws nothing.

[DOM Overlay]: https://immersive-web.github.io/dom-overlays/

---

## Running it

```bash
./serve.sh          # serves on :8000, prints the LAN URL for the headset
```

Then open the printed `http://<ip>:8000` in the headset browser.

> **WebXR needs a secure context.** `localhost` counts as secure, so desktop testing
> works immediately. A headset hitting your laptop over the LAN by IP does **not**,
> and the "Enter AR" button will not appear. Options, easiest first:
> 1. **GitHub Pages** — the classroom setup. See [Deploying](#deploying-the-headset-url) below.
> 2. `npx serve --ssl-cert ... --ssl-key ...` with a self-signed cert, then accept the warning on the headset.
> 3. Chrome's `chrome://flags/#unsafely-treat-insecure-origin-as-secure` for quick bench testing only.
>
> The 2D fallback works over plain HTTP everywhere — students can always read the
> instructions even if AR is unavailable.

Opening `index.html` as a `file://` URL will **not** work: the content sheet is
fetched over HTTP. The app tells you this on screen if it happens.

---

## Deploying (the headset URL)

The headsets load the instructions from GitHub Pages:

**https://kevinaroe.github.io/ar-work-instructions/**

Pages serves the `main` branch from the repo root, so **pushing to `main` is the
deploy**. There is no build step and no workflow to maintain; the empty `.nojekyll`
file just tells Pages to publish the tree as-is rather than running it through Jekyll.

Watch a deploy land under the repo's **Actions** tab (`pages build and deployment`).
It takes about a minute.

Publish a content edit:

```bash
# 1. bump "revision" in content/dogtag-h2d.json
# 2. bump CACHE in sw.js   <- headsets serve the old sheet from cache without this
git add -A && git commit -m "Revise dog tag procedure" && git push
```

Give it about a minute, then reload in the headset. Because `sw.js` caches the app,
a headset that has run the job before may need one extra reload to pick up a new
revision — bumping `CACHE` is what forces it.

> **This repo and its published site are public.** Pages cannot serve a private repo
> on a free plan, and a Pages site is readable by anyone with the URL regardless.
> Do not put student names, or anything you would not hand to a stranger, into the
> content sheet. `approvedBy` (your name) will be visible.

---

## Controls

Designed for someone whose hands are busy, gloved, or holding pliers.

| Input | Action |
|---|---|
| **Voice** — "next", "back", "repeat", "help" | Primary AR input. Tap 🎤 to arm it. |
| 🔊 | Reads each step aloud as you arrive on it. |
| Arrow keys / space / PageUp / PageDown | For stations with a clicker or keyboard. |
| Tap / gaze-click | All targets are ≥56 px. |

Progress is saved to `localStorage`, so a student who takes off the headset can
resume at the same step. Progress is discarded automatically when the instruction
sheet's `revision` changes, so nobody resumes into an outdated procedure.

---

## Safety design

This app is a teaching aid for a machine that can blind someone and start a fire.
Three deliberate constraints:

1. **PPE gate.** The job will not start until every PPE item is individually ticked.
2. **Hard gates on high-hazard steps.** Steps marked `"hazard": "high"` disable the
   Next button until every verification check is confirmed. Low-risk steps stay
   unblocked on purpose — if everything is gated, students learn to click through
   gates, and the gates stop meaning anything.
3. **Persistent stop reminder.** During `Run` phase steps, the stop-the-job banner
   is always on screen.

**None of this replaces supervision.** The content sheet states that an instructor
must be present.

---

## Editing the instructions

All content lives in [`content/dogtag-h2d.json`](content/dogtag-h2d.json). No code
changes needed to revise a procedure. Each step:

```jsonc
{
  "id": 7,
  "phase": "Set up the machine",   // shown in the HUD chip
  "title": "Set laser focus",
  "hazard": "med",                 // none | low | med | high  (high = gated)
  "seconds": 180,
  "why": "One sentence on why this step exists.",
  "do":     ["Imperative action.", "One instruction per line."],
  "checks": ["Verification the student confirms before moving on."],
  "warn":   ["Shown in a red panel. Use sparingly or it stops being read."],
  "voice":  "Shortened text for read-aloud. Written to be heard, not read."
}
```

When you edit content, **bump `revision`** in the JSON *and* bump `CACHE` in
`sw.js` — otherwise headsets keep serving the cached old sheet.

### Before this is used in class

The procedure was written against Bambu's published H2D laser documentation, but
two things must be verified on **your** machine by the instructor:

- [ ] Set `approvedBy` in the JSON and sign off on the procedure.
- [ ] **Confirm the laser parameters.** The sheet deliberately tells students to
      take power/speed/passes from the material preset and your shop's test card
      rather than hardcoding numbers. Make sure that test card exists and is taped
      to the machine.
- [ ] Confirm shop-specific details: material bin (`B-4`), tool locations,
      extinguisher location, machine log location, and whether your station uses a
      ducted exhaust or the smoke purifier.
- [ ] Walk the whole procedure yourself in 2D before putting it on a student's head.

---

## Adding a second machine

The player is content-agnostic. Copy the JSON, change `CONTENT_URL` in `app.js`
(or add a `?job=` parameter), and you have a second work instruction with no other
changes.

---

## Layout

```
index.html       screens and overlay root
styles.css       high-contrast dark theme tuned for passthrough legibility
app.js           state, navigation, voice, TTS, WebXR session
sw.js            offline cache
content/         the instruction sheets — this is the file instructors edit
serve.sh         LAN dev server
```
