# Ad Skipper

A Manifest V3 browser extension for a major streaming platform. Its ads are stitched into the video stream server-side, so there is nothing to block in the usual way. Instead, before a video starts, the extension rewrites what the platform sends its player: ad events come out of the playback schedule (every other position remapped to content time), and the ad periods are cut from the DASH manifest and the rest re-chained. The player never knows the ads were there, so there is nothing to skip, no black screen and no gaps in the progress bar. Pause ads are switched off too.

## Install locally

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome, or `edge://extensions` in Edge.
3. Enable Developer mode and select **Load unpacked**.
4. Select the folder containing `manifest.json`.
5. Open or reload the streaming site (the sites it runs on are listed in `manifest.json`), then use the extension popup to adjust settings.

No build step is required. It uses browser storage and declarative network rules. The popup shows recorded skipped breaks and estimated minutes saved.

## Files

- `main.js`: page-context playback interception: the schedule and manifest rewrites.
- `content.js`: player and UI handling, a fallback skipper, and skip tracking.
- `rules.json`: declarative network rules for ad trackers.
- `popup.html` and `popup.js`: extension controls.
- `icons/`: packaged extension icons.

Chrome-generated `_metadata` is excluded. This is an independent extension, not affiliated with any streaming service. Changes to the site's player may require updates.
