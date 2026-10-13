// Runs in the page's own JS world so it can see (and rewrite) the player's
// network responses.
//
// The site stitches ads into the stream server-side (SSAI):
// - playbackInfo carries the ad schedule (ssaiInfo.forecastTimeline): which
//   stream ranges are ad breaks. The player uses it for ad mode, the ad badge,
//   the break markers on the progress bar, and forcing unwatched breaks on
//   forward seeks.
// - The DASH manifest (.mpd) is multi-period: each ad is its own <Period>
//   between the program's periods.
//
// So the ads are removed before the player ever sees them:
// 1. playbackInfo: drop ad events from the schedule and map every remaining
//    event onto content time; turn off pause ads.
// 2. manifest: drop the <Period>s inside ad breaks and close up the timeline.
// The original break windows are still posted to content.js, which skips them
// by seeking if the manifest rewrite ever fails (the player no longer knows
// about the ads, so those jumps are clean).

(() => {
  const SOURCE = 'ad-skipper';
  let breaks = []; // [{ start, end, ads }] in original stream time

  const isPlaybackInfo = (url) => /\/playback\/v\d+\/playbackInfo/.test(url);
  const isManifest = (url) => /\.mpd(\?|$)/.test(url);

  // ---- playbackInfo -------------------------------------------------------

  function rewritePlaybackInfo(text) {
    let info;
    try { info = JSON.parse(text); } catch { return text; }
    const timeline = info?.ssaiInfo?.forecastTimeline;
    if (!Array.isArray(timeline)) return text;

    breaks = timeline
      .filter((e) => e.event?.schema === 'adBreak' && e.event.action === 'start')
      .map((e) => ({
        start: e.time.streamPosition,
        end: e.time.streamPosition + e.event.duration,
        ads: e.event.adsTotalInBreak
      }))
      .filter((b) => b.end - b.start >= 1);
    const streamEnd = timeline.find((e) => e.event?.action === 'streamComplete')?.time?.streamPosition;
    window.postMessage({ source: SOURCE, breaks, streamEnd, ssaiStripped: true }, location.origin);

    // Keep only non-ad events. Their positions and trigger times are on the
    // ad-inclusive stream clock; move them onto content time (what the stream
    // becomes once the ad periods are gone), keeping each event's small
    // trigger offset so their order is preserved.
    let kept = timeline
      .filter((e) => e.event?.adBreakIndex === undefined &&
        e.event?.schema !== 'adBreak' && e.event?.schema !== 'ad')
      .map((e) => {
        if (!e.time) return e;
        const c = e.time.contentPosition;
        const out = { ...e, time: { ...e.time, streamPosition: c } };
        if (typeof e.triggerTime === 'number') out.triggerTime = c + (e.triggerTime - e.time.streamPosition);
        return out;
      });
    // The program is split into one chapter per stretch between ad breaks.
    // The player treats a chapter's end as a break boundary: it snaps forward
    // seeks back to it (waiting for a break that no longer exists) and draws
    // a gap there. Replace them with a single chapter spanning the program.
    const contentEnd = timeline.find((e) => e.event?.action === 'streamComplete')?.time?.contentPosition;
    const chapters = kept.filter((e) => e.event?.schema === 'chapter');
    const firstStart = chapters.find((e) => e.event.action === 'start');
    const lastEnd = chapters.filter((e) => e.event.action === 'complete').pop();
    if (firstStart && lastEnd && typeof contentEnd === 'number') {
      for (const e of [firstStart, lastEnd]) e.event = { ...e.event, position: 0, duration: contentEnd };
      kept = kept.filter((e) => e.event?.schema !== 'chapter' || e === firstStart || e === lastEnd);
    }
    info.ssaiInfo.forecastTimeline = kept;
    // vendorAttributes carries the ad server's own copy of the breaks. The
    // player uses it for the progress-bar markers and, worse, it freezes the
    // saved watch position at the start of a break it thinks is still playing
    // (so resume drifts backward). nonLinear* are the pause ads.
    const va = info.ssaiInfo.vendorAttributes;
    if (va && typeof va === 'object') {
      for (const key of ['breaks', 'nonLinearAds', 'nonLinearBreaks']) {
        if (Array.isArray(va[key])) va[key] = [];
      }
    }
    if (Array.isArray(info.capabilities)) {
      info.capabilities = info.capabilities.map((c) =>
        c?.name === 'pause-ads' ? { ...c, enabled: false } : c);
    }
    return JSON.stringify(info);
  }

  // ---- DASH manifest ------------------------------------------------------

  function parseDuration(iso) {
    const m = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso || '');
    return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : null;
  }
  const toDuration = (s) => `PT${s.toFixed(3)}S`;

  function rewriteManifest(text) {
    if (!breaks.length || typeof text !== 'string') return text;
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return text;
    // Live streams (dynamic manifests) are refreshed and shift constantly;
    // leave them to content.js.
    if (doc.documentElement.getAttribute('type') === 'dynamic') return text;
    const periods = [...doc.getElementsByTagName('Period')];
    if (periods.length < 2) return text;

    // Absolute start/duration of every period.
    const spans = periods.map((p, i) => {
      const start = parseDuration(p.getAttribute('start'));
      let dur = parseDuration(p.getAttribute('duration'));
      if (dur === null && i + 1 < periods.length) {
        dur = parseDuration(periods[i + 1].getAttribute('start')) - start;
      }
      return { p, start, dur };
    });
    if (spans.some((s) => s.start === null || s.dur === null)) return text;

    // A period is an ad if it lies inside a break window.
    const isAd = ({ start, dur }) =>
      breaks.some((b) => start >= b.start - 0.05 && start + dur <= b.end + 0.05);
    const ads = spans.filter(isAd);
    if (!ads.length) return text;
    // Sanity check: the removed time must match the schedule, else leave the
    // manifest alone and let content.js skip by seeking.
    const removed = ads.reduce((a, s) => a + s.dur, 0);
    const scheduled = breaks.reduce((a, b) => a + (b.end - b.start), 0);
    if (Math.abs(removed - scheduled) > 1) return text;

    for (const s of ads) s.p.remove();
    let t = 0;
    for (const s of spans) {
      if (isAd(s)) continue;
      s.p.setAttribute('start', toDuration(t));
      t += s.dur;
    }
    const mpd = doc.documentElement;
    if (mpd.hasAttribute('mediaPresentationDuration')) {
      mpd.setAttribute('mediaPresentationDuration', toDuration(t));
    }
    window.postMessage({ source: SOURCE, manifestStripped: true, breaks: breaks.length, removed }, location.origin);
    return new XMLSerializer().serializeToString(doc);
  }

  // ---- hooks --------------------------------------------------------------

  function rewriteFor(url) {
    if (document.documentElement?.dataset.adSkipperOff === '1') return null;
    if (isPlaybackInfo(url)) return rewritePlaybackInfo;
    if (isManifest(url)) return rewriteManifest;
    return null;
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const rewrite = rewriteFor(url);
    if (!rewrite || !res.ok) return res;
    try {
      const body = rewrite(await res.clone().text());
      const out = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
      Object.defineProperty(out, 'url', { value: res.url });
      return out;
    } catch {
      return res;
    }
  };

  // XHR: override the response getters on matching requests so every way the
  // player reads the body (responseText, response as text/arraybuffer/json)
  // sees the rewritten version.
  const proto = XMLHttpRequest.prototype;
  const textGetter = Object.getOwnPropertyDescriptor(proto, 'responseText').get;
  const responseGetter = Object.getOwnPropertyDescriptor(proto, 'response').get;
  const origOpen = proto.open;
  proto.open = function (method, url) {
    const rewrite = rewriteFor(String(url));
    if (rewrite) {
      let cached = null;
      const rewritten = (xhr) => {
        if (cached === null) {
          const type = xhr.responseType;
          let raw;
          if (type === '' || type === 'text') raw = textGetter.call(xhr);
          else if (type === 'arraybuffer') raw = new TextDecoder().decode(responseGetter.call(xhr));
          else if (type === 'json') raw = JSON.stringify(responseGetter.call(xhr));
          else return null;
          try { cached = rewrite(raw); } catch { cached = raw; }
        }
        return cached;
      };
      Object.defineProperty(this, 'responseText', {
        configurable: true,
        get() {
          return this.readyState === 4 ? rewritten(this) ?? textGetter.call(this) : textGetter.call(this);
        }
      });
      Object.defineProperty(this, 'response', {
        configurable: true,
        get() {
          if (this.readyState !== 4) return responseGetter.call(this);
          const body = rewritten(this);
          if (body === null) return responseGetter.call(this);
          if (this.responseType === 'arraybuffer') return new TextEncoder().encode(body).buffer;
          if (this.responseType === 'json') return JSON.parse(body);
          return body;
        }
      });
    }
    return origOpen.apply(this, arguments);
  };
})();
