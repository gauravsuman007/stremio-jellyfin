/**
 * The script served at the path that marks a Jellyfin WebView shell
 * connected, and that bridges its native players into Stremio's UI.
 *
 * Reading jellyfin-android (GPL) rather than guessing:
 *
 * 1. JellyfinWebViewClient.shouldInterceptRequest() calls onConnectedToWebapp()
 *    the instant it sees a request path shaped like "main.<anything>.bundle.js"
 *    -- the response body is never inspected. This script IS served at that
 *    path, so one request both trips the flag and delivers the code, inside
 *    the client's 10s connection timeout. RENAMING THIS PATH BREAKS THE
 *    CLIENT SILENTLY: a spinner, then a timeout, and no error anywhere.
 * 2. The four registered JavascriptInterfaces are NativeInterface,
 *    NativePlayer, ExternalPlayer and MediaSegments. `NativeShell` is NOT
 *    among them -- it is a plain JS object that jellyfin-web itself defines
 *    over NativeInterface, so it exists only when the real jellyfin-web is
 *    being served, which here it never is. Guarding on window.NativeShell
 *    silently disables everything.
 * 3. ExternalPlayer.initPlayer() and NativePlayer.loadPlayer() both take
 *    PlayOptions carrying ITEM IDS, not URLs.
 */

"use strict";

const BUNDLE_PATH = "/web/main.stremio.bundle.js";

const BUNDLE_JS = String.raw`
(function () {
  "use strict";

  function log() {
    try { console.log.apply(console, ["[stremio-jellyfin]"].concat([].slice.call(arguments))); }
    catch (e) {}
  }

  // The app offers three player types in its OWN native settings
  // (VideoPlayerType: "webui" | "exoplayer" | "external") and exposes each as
  // a bridge whose isEnabled() reflects that choice. Exactly one is ever
  // enabled, so asking both is how we learn what the human picked; there is
  // no API to read the setting directly.
  function exoAvailable() {
    try { return !!(window.NativePlayer && window.NativePlayer.isEnabled()); } catch (e) { return false; }
  }

  function externalAvailable() {
    try { return !!(window.ExternalPlayer && window.ExternalPlayer.isEnabled()); } catch (e) { return false; }
  }

  function nativeAvailable() { return exoAvailable() || externalAvailable(); }

  // NativeShell first only so this keeps working if these pages are ever
  // loaded by a shell that does define it; NativeInterface is the real one.
  function shell() {
    try {
      if (window.NativeShell && window.NativeShell.openUrl) return window.NativeShell;
      if (window.NativeInterface) return window.NativeInterface;
    } catch (e) {}
    return null;
  }

  // Tells jellyfin-android to intercept this exact request and import
  // whatever is in localStorage's jellyfin_credentials into its native
  // session. Without it the native layer calls every API with no Token=,
  // which is a silent 401 with no visible error.
  var imported = false;

  function importSession(done) {
    if (imported) { done(true); return; }

    fetch("/Sessions/Capabilities/Full", { method: "POST", credentials: "same-origin" })
      .then(function () {
        // Interception is fire-and-forget on the client's side, so there is
        // no signal for when setupUser() finished. A short wait is cheaper
        // than racing the very next player call.
        setTimeout(function () { imported = true; done(true); }, 250);
      })
      .catch(function (e) { log("capabilities/full failed", e); done(false); });
  }

  function ensureCredentials(done) {
    try {
      var c = JSON.parse(window.localStorage.getItem("jellyfin_credentials"));
      if (c && c.Servers && c.Servers[0] && c.Servers[0].AccessToken) { importSession(done); return; }
    } catch (e) {}

    fetch("/jellyfin/session-token", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) { log("no session token available"); done(false); return; }
        window.localStorage.setItem("jellyfin_credentials", JSON.stringify({
          Servers: [{ Id: d.ServerId, UserId: d.UserId, AccessToken: d.AccessToken }]
        }));
        importSession(done);
      })
      .catch(function (e) { log("session-token fetch failed", e); done(false); });
  }

  function handOff(itemId) {
    ensureCredentials(function (ok) {
      if (!ok) { log("hand-off aborted: no credentials"); return; }

      var options = JSON.stringify({ ids: [itemId], startIndex: 0, startPositionTicks: 0 });

      if (externalAvailable()) window.ExternalPlayer.initPlayer(options);
      else window.NativePlayer.loadPlayer(options);
    });
  }

  /**
   * Register a URL Stremio is about to play, and hand the id to the player.
   *
   * The URL cannot be given to a player directly -- see streams.js for why an
   * id is required -- so it is exchanged for one here first.
   */
  function playUrl(url, title) {
    fetch("/jellyfin/register-stream", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: url, title: title || document.title || "Video" })
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.itemId) handOff(d.itemId);
        else log("could not register stream", url);
      })
      .catch(function (e) { log("register-stream failed", e); });
  }

  window.StremioNative = {
    available: nativeAvailable,
    externalPlayerSelected: externalAvailable,
    playUrl: playUrl,

    // Fullscreen has to be asked of the ANDROID ACTIVITY. requestFullscreen()
    // only expands an element inside the WebView's viewport, and the status
    // bar is outside that viewport entirely, so it stays on screen no matter
    // what the page does. Only ChangeFullscreen on the native side hides it.
    enableFullscreen: function () {
      var h = shell();
      if (!h || !h.enableFullscreen) return false;
      try { h.enableFullscreen(); return true; } catch (e) { return false; }
    },

    disableFullscreen: function () {
      var h = shell();
      if (!h || !h.disableFullscreen) return false;
      try { h.disableFullscreen(); return true; } catch (e) { return false; }
    },

    // The only way out of this app when the client points straight at it:
    // there is no address bar and no back gesture out of the web content, so
    // without this the WebView is a dead end.
    serverSelectionAvailable: function () {
      var h = shell();
      return !!(h && h.openServerSelection);
    },

    openServerSelection: function () {
      var h = shell();
      if (!h || !h.openServerSelection) return false;
      try { h.openServerSelection(); return true; } catch (e) { return false; }
    },

    openSettings: function () {
      var h = shell();
      if (!h || !h.openClientSettings) return false;
      try { h.openClientSettings(); return true; } catch (e) { return false; }
    }
  };

  /*
    A way back to the multiplexer's app picker.
    -------------------------------------------

    Without this, a Jellyfin client that entered Stremio through the
    multiplexer is STUCK: Stremio has no concept of a launcher to return to,
    the WebView has no address bar, and the OS back gesture does not leave
    the web content. Reported exactly that way.

    Rendered only when the multiplexer confirms itself via /__mux/ping.
    Probing /apps instead does not work -- Stremio's SPA fallback answers any
    unknown path with index.html and a 200, which looks identical to the
    picker. The JSON check is what makes the probe honest, so this button
    never appears on a standalone deployment where it would dead-end.

    Deliberately plain DOM and inline styles: Stremio's stylesheets are a
    build artefact we do not control and whose class names change between
    releases, so anything relying on them would break on an upgrade.
  */
  function mountLauncherButton(picker) {
    if (document.getElementById("stremio-jellyfin-apps")) return;

    var btn = document.createElement("button");
    btn.id = "stremio-jellyfin-apps";
    btn.type = "button";
    btn.textContent = "\u25C0 Apps";
    btn.setAttribute("aria-label", "Back to app launcher");

    btn.style.cssText = [
      "position:fixed",
      "top:env(safe-area-inset-top,0px)",
      "left:0",
      // Above Stremio's own chrome. Its top bar sits in the low hundreds, so
      // this is clear of it without being absurd.
      "z-index:2147483000",
      "margin:8px",
      "padding:8px 14px",
      "font:600 13px/1.2 system-ui,-apple-system,sans-serif",
      "color:#fff",
      "background:rgba(20,18,32,.86)",
      "border:1px solid rgba(255,255,255,.22)",
      "border-radius:999px",
      "cursor:pointer",
      // Comfortably tappable on a TV remote or a phone.
      "min-height:40px",
      "-webkit-tap-highlight-color:transparent",
      "backdrop-filter:blur(6px)"
    ].join(";");

    btn.addEventListener("click", function () {
      window.location.href = picker || "/apps";
    });

    document.body.appendChild(btn);
  }

  function offerLauncherButton() {
    fetch("/__mux/ping", { credentials: "same-origin" })
      .then(function (r) {
        var type = r.headers.get("content-type") || "";
        if (!r.ok || type.indexOf("json") === -1) return null;
        return r.json();
      })
      .then(function (d) {
        if (!d || !d.multiplexer) return;

        if (document.body) mountLauncherButton(d.picker);
        else document.addEventListener("DOMContentLoaded", function () { mountLauncherButton(d.picker); });
      })
      .catch(function () {
        // Not behind the multiplexer, or it is unreachable. Either way there
        // is nowhere to go back to, so no button.
      });
  }

  /*
    Point this device at the configured streaming server, once.

    Stremio keeps the streaming server URL PER DEVICE and defaults it to
    http://127.0.0.1:11470 -- which inside a phone or TV WebView means the
    client device, not the host, so it finds nothing and no stream plays. It
    is also not part of what a Stremio account syncs, so setting it on one
    device does nothing for the next.

    Upstream's SearchParamsHandler already applies a streamingServerUrl query
    parameter to
    the profile and persists it, so this only has to put the parameter there
    once and reload. Guarded by a localStorage marker keyed on the VALUE, so
    it cannot loop, and so changing the configured URL re-applies rather than
    being ignored forever.
  */
  function applyStreamingServer() {
    var configured = (window.__STREMIO_JELLYFIN__ || {}).streamingServerUrl;

    if (!configured) return;

    var marker = "stremio-jellyfin:server-url";

    try {
      if (window.localStorage.getItem(marker) === configured) return;
    } catch (e) {
      // Storage unavailable (private mode, or a locked-down WebView). Without
      // a marker this would reload forever, so do nothing at all rather than
      // risk that -- the manual settings route still works.
      return;
    }

    if (location.search.indexOf("streamingServerUrl=") !== -1) {
      // The parameter is already on the URL: upstream's handler is applying
      // it on this very load. Record it and let that finish.
      try { window.localStorage.setItem(marker, configured); } catch (e) {}
      return;
    }

    try { window.localStorage.setItem(marker, configured); } catch (e) {}

    var separator = location.search ? "&" : "?";
    log("pointing this device at streaming server", configured);
    location.replace(location.pathname + location.search + separator +
                     "streamingServerUrl=" + encodeURIComponent(configured) + location.hash);
  }

  applyStreamingServer();

  // Runs regardless of player type: being stuck applies to a plain browser
  // tab opened through the multiplexer just as much as to a WebView shell.
  offerLauncherButton();

  if (!nativeAvailable()) return;

  document.documentElement.setAttribute("data-stremio-native-player", "1");
  ensureCredentials(function () {});

  /*
    Intercepting Stremio's own player.
    ----------------------------------

    BEST EFFORT, AND THE PART MOST LIKELY TO NEED REVISITING. Stremio Web is
    a compiled React app with no stable hook for "a stream was selected", and
    no plugin surface -- so rather than reaching into its internals, which
    would break on any upstream rebuild, this watches for the one thing that
    is guaranteed observable: a <video> element acquiring a source.

    When a native player is selected, letting the in-page <video> also play
    would give two audio streams at once, so it is paused and emptied before
    the hand-off.

    If upstream ever exposes a real event for this, prefer it and delete all
    of the below.
  */
  function claim(video) {
    var url = video.currentSrc || video.src;

    if (!url || video.dataset.stremioJellyfinClaimed === "1") return;
    if (url.indexOf("blob:") === 0 || url.indexOf("data:") === 0) {
      // MediaSource / blob playback has no URL another app could fetch, so
      // there is nothing to hand over. Left to play in-page.
      return;
    }

    video.dataset.stremioJellyfinClaimed = "1";

    try { video.pause(); video.removeAttribute("src"); video.load(); } catch (e) {}

    log("handing off", url);
    playUrl(url, document.title);
  }

  function watch(video) {
    if (video.dataset.stremioJellyfinWatched === "1") return;
    video.dataset.stremioJellyfinWatched = "1";

    claim(video);
    video.addEventListener("loadstart", function () { claim(video); });
  }

  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var added = records[i].addedNodes;

      for (var j = 0; j < added.length; j++) {
        var node = added[j];
        if (!node || node.nodeType !== 1) continue;
        if (node.tagName === "VIDEO") watch(node);
        else if (node.querySelectorAll) {
          var found = node.querySelectorAll("video");
          for (var k = 0; k < found.length; k++) watch(found[k]);
        }
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  var existing = document.querySelectorAll("video");
  for (var n = 0; n < existing.length; n++) watch(existing[n]);
})();
`;

module.exports = { BUNDLE_PATH, BUNDLE_JS };
