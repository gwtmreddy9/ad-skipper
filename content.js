// The site stitches ads into the video stream server-side, so they can't be
// blocked at the network layer. main.js removes them from the player's
// playbackInfo and DASH manifest before the player sees them; this script is
// the fallback for when that rewrite can't apply:
//
// 1. Schedule: main.js still posts the original ad-break windows, and
//    skipBySchedule() checks every video frame. If main.js stripped the ads
//    from the site's schedule (ssaiStripped), every break is a plain jump. Else:
//    - normal playback about to enter a mid-roll: jump cleanly past it
//    - already at/inside a break (pre-roll, resume, or the player snapping back to an
//      unwatched break after a forward scrub): cover it, then land on its
//      last TAIL_SECS so the player plays across the end, leaves ad mode, marks it
//      watched and continues to the scrub target
// 2. Countdown (fallback, for videos without a schedule or ads it missed):
//    read the player's ad timer, then black out, mute and play at 16x.

const AD_RATE = 16;
const POLL_MS = 250;
const END_DEBOUNCE_MS = 800; // countdown can blink out between ads in a pod
// If the video advances this many seconds while the countdown text doesn't
// change, the badge is stale (the player leaves "Ad 1 of 1 :00" up after fast breaks).
const STALE_VIDEO_SECS = 3;

// The player's ad UI (Sept 2026):
//   [data-testid="ad"] > .AdOverlayContainer
//     [data-testid="player-ux-ad-label"]  "Ad"
//     [data-testid="player-ux-ad-timer"]  "1 of 2" ":45"
const AD_UI_SELECTORS = [
  '[data-testid="player-ux-ad-timer"]',
  '[class*="AdTimeRemaining"]',
  '[data-testid="ad"] [class*="AdOverlayContainer"]'
];

let settings = { enabled: true, debug: false };
let inAd = false;
let lastAdSeen = 0;
let adStart = 0;
let lastText = null;
let videoTimeAtTextChange = 0;
let overlay = null;
const saved = new Map(); // video -> { muted, rate }
let schedule = null; // { breaks: [{ start, end, ads }], streamEnd }

// The player's "Ad 1 of 3 :00" badge never clears after a break is skipped. With a
// schedule we know exactly where ads are, so the badge is hidden entirely.
const HIDE_AD_UI_CLASS = 'ad-skipper-scheduled';
function hideAdUi(on) {
  const root = document.documentElement;
  if (!root || root.classList.contains(HIDE_AD_UI_CLASS) === on) return;
  if (on && !document.getElementById(HIDE_AD_UI_CLASS)) {
    const style = document.createElement('style');
    style.id = HIDE_AD_UI_CLASS;
    style.textContent = `.${HIDE_AD_UI_CLASS} [data-testid="ad"] { display: none !important; }`;
    (document.head || root).appendChild(style);
  }
  root.classList.toggle(HIDE_AD_UI_CLASS, on);
}

// Pause ads: main.js turns the feature off in playbackInfo; this hides the
// container too in case the player shows one anyway.
function hidePauseAds(on) {
  const id = 'ad-skipper-pause-ads';
  const existing = document.getElementById(id);
  if (!on) { existing?.remove(); return; }
  if (existing || !document.documentElement) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = '[data-testid="pause_ad"] { display: none !important; }';
  (document.head || document.documentElement).appendChild(style);
}

let lastSkipAt = 0;

window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.source !== 'ad-skipper') return;
  if (e.data.manifestStripped) {
    log(`ads removed from the stream before playback (${Math.round(e.data.removed)}s)`);
    recordRemoved(e.data.breaks, e.data.removed);
    return;
  }
  if (!Array.isArray(e.data.breaks)) return;
  // Drop empty placeholder breaks (0s) the schedule sometimes lists.
  schedule = { ...e.data, breaks: e.data.breaks.filter((b) => b.end - b.start >= 1) };
  lastSkipOf.clear();
  repaired.clear();
  log(`ad schedule: ${schedule.breaks.length} breaks`,
    schedule.breaks.map((b) => `${fmt(b.start)} (${Math.round(b.end - b.start)}s)`).join(', '));
});

const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// main.js (page world) can't read extension storage; pass the on/off switch
// through an attribute it checks before rewriting a response.
const shareEnabled = () => {
  if (document.documentElement) document.documentElement.dataset.adSkipperOff = settings.enabled ? '0' : '1';
};
chrome.storage.sync.get(settings, (s) => { settings = s; shareEnabled(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  for (const [k, { newValue }] of Object.entries(changes)) settings[k] = newValue;
  shareEnabled();
  if (!settings.enabled && inAd) endAd();
});

const log = (...a) => settings.debug && console.log('[Ad Skipper]', ...a);

function visible(el) {
  if (!el || !el.getClientRects().length) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0;
}

// Main content video: the longest one on the page.
function mainVideo() {
  return [...document.querySelectorAll('video')]
    .sort((a, b) => (b.duration || 0) - (a.duration || 0))[0];
}

// hiddenOk: read the countdown even while hideAdUi() has it display:none.
function adUiText(hiddenOk) {
  if (hiddenOk) {
    const el = document.querySelector('[data-testid="player-ux-ad-timer"]');
    return el?.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : null;
  }
  for (const sel of AD_UI_SELECTORS) {
    let el;
    try { el = document.querySelector(sel); } catch { continue; }
    if (visible(el)) return el.innerText.replace(/\s+/g, ' ').trim();
  }
  return null;
}

// ":45", "1:05", "Ad 1 of 2 :30" -> seconds left in the current ad.
function remainingSeconds(text) {
  let best = 0;
  for (const m of (text || '').matchAll(/(\d{1,2})?:(\d{2})/g)) {
    best = Math.max(best, (+m[1] || 0) * 60 + +m[2]);
  }
  return best;
}

// "1 of 3" -> true while more ads follow the current one.
function moreAdsInPod(text) {
  const m = (text || '').match(/(\d+)\s*of\s*(\d+)/i);
  return !!m && +m[1] < +m[2];
}

function speedUp() {
  for (const v of document.querySelectorAll('video')) {
    if (!saved.has(v)) saved.set(v, { muted: v.muted, rate: v.playbackRate });
    if (!v.muted) v.muted = true;
    // The player resets playbackRate on segment changes; reapply every tick.
    if (v.playbackRate !== AD_RATE) {
      try { v.playbackRate = AD_RATE; } catch { v.playbackRate = 8; }
    }
  }
}

function showOverlay(v, label) {
  const host = document.fullscreenElement || document.body;
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;z-index:2147483647;background:#000;color:#aaa;display:flex;' +
      'align-items:center;justify-content:center;font:16px system-ui,sans-serif;pointer-events:none';
  }
  if (overlay.parentNode !== host) host.appendChild(overlay);
  const r = v.getBoundingClientRect();
  Object.assign(overlay.style, {
    left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px'
  });
  overlay.textContent = label;
}

// Popup stats: ad breaks and seconds of ads the user didn't have to watch.
function addStats(breaks, adSeconds) {
  chrome.storage.local.get({ breaks: 0, adSeconds: 0 }, (s) => {
    chrome.storage.local.set({ breaks: s.breaks + breaks, adSeconds: s.adSeconds + adSeconds });
  });
}
const recordSkip = (adSeconds) => addStats(1, adSeconds);
const recordRemoved = (breaks, adSeconds) => addStats(breaks, adSeconds);

// The schedule belongs to this video only if its stream length matches.
function scheduleFor(v) {
  if (!schedule || !isFinite(v.duration)) return null;
  return Math.abs(schedule.streamEnd - v.duration) < 2 ? schedule.breaks : null;
}

// Once the player is at/inside a break it is in ad mode, and it only leaves ad mode
// (and continues to a pending scrub target) after playing across the break's
// end itself. So skips from inside a break land this far before the end:
// - jump past the end instead -> stuck in ad mode (badge up, no progress bar)
//   or, after a snap-back, the scrub target is dropped
// - shorter tails (0.4s) fail: the stream reload after the seek rounds the
//   position past the end, so the player never plays across it
const TAIL_SECS = 1.5;

// Black out and mute until a frame at or after `until` is on screen and
// outside every break. One shared cover, so chained skips (the player walking through
// several breaks after a long scrub) don't flash ads between them or leave the
// video muted.
let cover = null; // { v, wasMuted, until, since, timeout }
const inAnyBreak = (v, t) => (scheduleFor(v) || []).some((b) => t >= b.start - 0.3 && t < b.end);

// Fallback for when frames stop arriving (paused, stalled). The player can take
// several seconds to reload the stream after a skip, so keep the cover while
// the position is still inside a break, up to a hard cap.
function checkCoverTimeout(v) {
  if (!cover) return;
  const stillInBreak = inAnyBreak(v, v.currentTime) || v.seeking;
  if (stillInBreak && Date.now() - cover.since < 15000) {
    cover.timeout = setTimeout(() => checkCoverTimeout(v), 500);
  } else {
    uncover(v);
  }
}

function coverUntil(v, until) {
  if (cover) {
    cover.until = Math.max(cover.until, until);
    clearTimeout(cover.timeout);
  } else {
    cover = { v, wasMuted: v.muted, until, since: Date.now() };
    v.muted = true;
    showOverlay(v, '');
    const onFrame = (_now, frame) => {
      if (!cover) return;
      const t = frame.mediaTime;
      if (t >= cover.until && !inAnyBreak(v, t) && !v.seeking) uncover(v);
      else v.requestVideoFrameCallback(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);
  }
  cover.timeout = setTimeout(() => checkCoverTimeout(v), 4000);
}

function uncover(v) {
  if (!cover) return;
  clearTimeout(cover.timeout);
  v.muted = cover.wasMuted;
  cover = null;
  if (!inAd) overlay?.remove();
}

function seekTo(v, target) {
  const wasPlaying = !v.paused;
  v.currentTime = target;
  // The player pauses itself after a jump; resume if it was playing.
  if (wasPlaying) {
    for (const ms of [300, 1000, 2500]) {
      setTimeout(() => { if (v.paused) v.play().catch(() => {}); }, ms);
    }
  }
}

// t is the media time of a frame that was actually presented. Don't use
// v.currentTime alone: it reads 0 while the player reloads the stream after a
// seek, which looks like the pre-roll and triggers a bogus skip.
const lastSkipOf = new Map(); // break start -> Date.now() of last skip

function skipBySchedule(v, t) {
  const breaks = scheduleFor(v);
  if (!breaks || v.seeking) return;
  // A frame whose time disagrees with the element's position is stale.
  if (Math.abs(t - v.currentTime) > 1) return;
  // Start slightly early so the cover is up before the first ad frame.
  const b = breaks.find((b) => t >= b.start - 0.3 && t < b.end - TAIL_SECS - 0.2);
  if (!b) { pendingBreak = null; return; }
  // Per-break guard: the player chains snap-backs through several breaks in a row
  // when the user scrubs far ahead, and each must be skipped immediately.
  if (Date.now() - (lastSkipOf.get(b.start) || 0) < 3000) return;

  // main.js removed the ads from the site's schedule but the ads are still in the
  // stream (manifest rewrite didn't apply). The player has no ad mode to satisfy, so
  // every break is a plain jump; cover only if an ad frame is already showing.
  if (schedule.ssaiStripped) {
    markSkipped(b);
    log(`skipping ad break at ${fmt(b.start)}: ${b.ads} ads, ${Math.round(b.end - b.start)}s ` +
      `(frame ${t.toFixed(2)}, jump)`);
    if (t >= b.start) coverUntil(v, b.end + 0.05);
    seekTo(v, b.end + 0.05);
    return;
  }

  // Normal playback reaching a mid-roll: caught before its first frame, and
  // the player won't need it marked watched to continue playing. Clean jump, no cover.
  if (t < b.start && b.start >= 0.5) {
    markSkipped(b);
    log(`skipping ad break at ${fmt(b.start)}: ${b.ads} ads, ${Math.round(b.end - b.start)}s ` +
      `(frame ${t.toFixed(2)}, clean jump)`);
    seekTo(v, b.end + 0.05);
    return;
  }

  // Already at/inside the break: a pre-roll, a resume, or the player snapping back
  // to an unwatched break after a forward scrub. Cover it now. Then wait for
  // the player to enter ad mode (its countdown appears): only a break it saw start
  // AND saw end gets marked watched. Otherwise the player snaps back to it on every
  // later forward scrub.
  if (pendingBreak?.b !== b) {
    pendingBreak = { b, since: Date.now() };
    coverUntil(v, b.end + 0.05);
  }
  if (!adUiText(true) && Date.now() - pendingBreak.since < 1000) return;
  const waited = Date.now() - pendingBreak.since;
  pendingBreak = null;
  markSkipped(b);
  // Land on the tail: the player only leaves ad mode (and continues to a pending
  // scrub target) after playing across the end itself.
  log(`skipping ad break at ${fmt(b.start)}: ${b.ads} ads, ${Math.round(b.end - b.start)}s ` +
    `(frame ${t.toFixed(2)}, via last ${TAIL_SECS}s after ${waited}ms)`);
  coverUntil(v, b.end + 0.05);
  seekTo(v, b.end - TAIL_SECS);
}

let pendingBreak = null; // { b, since } while waiting for the player's ad mode

function markSkipped(b) {
  lastSkipOf.set(b.start, Date.now());
  lastSkipAt = Date.now();
  recordSkip(b.end - b.start);
}

// Safety net: the player's ad mode is on (its hidden badge has content) but we're past
// a break's end. Step back onto that break's tail so the player sees it finish.
let adModeSince = 0;
const repaired = new Set(); // break starts already repaired once
function repairStuckAdMode(v, breaks) {
  const badge = document.querySelector('[data-testid="ad"]');
  const t = v.currentTime;
  const inBreak = breaks.some((b) => t >= b.start && t < b.end);
  if (!badge?.children.length || inBreak || v.seeking) { adModeSince = 0; return; }
  if (!adModeSince) { adModeSince = Date.now(); return; }
  if (Date.now() - adModeSince < 1000 || Date.now() - lastSkipAt < 3000) return;
  const b = breaks.filter((b) => b.end <= t && t - b.end < 60).pop();
  // Once per break: if replaying the tail didn't clear it, don't loop.
  if (!b || repaired.has(b.start)) return;
  repaired.add(b.start);
  lastSkipAt = Date.now();
  adModeSince = 0;
  log(`player stuck in ad mode after break at ${fmt(b.start)}; replaying its last ${TAIL_SECS}s`);
  coverUntil(v, b.end + 0.05);
  seekTo(v, b.end - TAIL_SECS);
}

function endAd() {
  overlay?.remove();
  for (const [v, s] of saved) {
    v.playbackRate = s.rate === AD_RATE ? 1 : s.rate;
    v.muted = s.muted;
  }
  saved.clear();
  inAd = false;
  const secs = Math.round((Date.now() - adStart) / 1000);
  log(`ad break ended after ${secs}s`);
  recordSkip(secs * AD_RATE);
}

// After the extension is reloaded or updated, this old copy keeps running in
// open tabs but loses chrome.* access. Undo any speed-up and stop.
function orphaned() {
  if (chrome.runtime?.id) return false;
  clearInterval(timer);
  hidePauseAds(false);
  hideAdUi(false);
  if (cover) uncover(cover.v);
  overlay?.remove();
  for (const [v, s] of saved) {
    v.playbackRate = s.rate === AD_RATE ? 1 : s.rate;
    v.muted = s.muted;
  }
  return true;
}

function tick() {
  if (orphaned()) return;
  hidePauseAds(settings.enabled);
  if (!settings.enabled) return hideAdUi(false);
  const now = Date.now();
  const v = mainVideo();
  if (!v) return;
  if (!v.__adSkipHooked) {
    // Check on every decoded frame so a break is caught on its first frame,
    // not up to a poll interval later.
    v.__adSkipHooked = true;
    const onFrame = (_now, frame) => {
      if (orphaned()) return;
      if (settings.enabled) skipBySchedule(v, frame.mediaTime);
      v.requestVideoFrameCallback(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);
  }
  // With a schedule, skipping happens per frame above; the countdown
  // fallback below handles videos without one, and ads the schedule missed.
  const breaks = scheduleFor(v);
  hideAdUi(!!breaks);

  const text = adUiText(!!breaks);
  if (text !== lastText) {
    lastText = text;
    videoTimeAtTextChange = v.currentTime;
  }
  const remaining = remainingSeconds(text);
  const stale = v.currentTime - videoTimeAtTextChange > STALE_VIDEO_SECS;
  // ":00" between ads in a pod still counts; ":00" on the last ad is the end.
  let adActive = text !== null && (remaining > 0 || moreAdsInPod(text)) && !stale;

  if (breaks) {
    // A live countdown outside every scheduled break means the player is playing an
    // ad the schedule didn't list. Anything else is the schedule's job.
    const unscheduledAd = remaining > 0 && !stale && !cover &&
      !inAnyBreak(v, v.currentTime) && now - lastSkipAt > 3000;
    if (unscheduledAd && !inAd) log(`ad not in schedule: "${text}"; using fallback`);
    adActive = unscheduledAd || (inAd && adActive);
    if (!adActive && !inAd) {
      repairStuckAdMode(v, breaks);
      return;
    }
  }

  if (adActive) {
    lastAdSeen = now;
    if (!inAd) {
      inAd = true;
      adStart = now;
      log(`ad detected: "${text}"`);
    }
    speedUp();
    showOverlay(v, '');
  } else if (inAd && now - lastAdSeen > END_DEBOUNCE_MS) {
    endAd();
  }
}

const timer = setInterval(tick, POLL_MS);
