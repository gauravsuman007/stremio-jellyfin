/**
 * The bridge between "a URL Stremio is about to play" and "an item id a
 * Jellyfin player can open".
 *
 * WHY AN ID AND NOT JUST THE URL. jellyfin-android's ExternalPlayer bridge
 * fires its intent with `setDataAndType(uri, "video/*")`, which is what makes
 * Android offer the media-player chooser -- and it takes ITEM IDS, resolved
 * through PlaybackInfo. There is no entry point on it that accepts a raw URL.
 * The one bridge that does take a URL, NativeInterface.openUrl(), builds a
 * bare Intent(ACTION_VIEW, uri) with NO MIME type, so Android matches on the
 * http scheme alone and a browser wins every time -- the video opens in a
 * browser and no chooser ever appears.
 *
 * So a Stremio stream URL is registered here, gets a Jellyfin id back, and
 * the Jellyfin surface answers for that id. Same mechanism as
 * riven-frontend-jellyfin uses for its direct-scrape videos.
 */

"use strict";

const { newStreamGuid, normalise } = require("./ids.js");

/** Long enough to watch something; short enough that a stale id dies. */
const TTL_MS = 12 * 60 * 60 * 1000;

/** Bounded, so a long-running server cannot accumulate ids without limit. */
const MAX_ENTRIES = 2000;

const streams = new Map();

function prune(now) {
    for (const [id, entry] of streams) {
        if (entry.expiresAt <= now) streams.delete(id);
    }

    // Map keeps insertion order, so the head is the least recently registered.
    while (streams.size > MAX_ENTRIES) {
        const oldest = streams.keys().next();
        if (oldest.done) break;
        streams.delete(oldest.value);
    }
}

function register(url, title) {
    if (!url) return null;

    const now = Date.now();
    prune(now);

    // Re-registering the same URL reuses its id rather than minting a second
    // one: the page can re-announce the same stream on a re-render, and a new
    // id each time would both leak entries and change the item under a player
    // that is already using it.
    for (const [id, entry] of streams) {
        if (entry.url === url) {
            entry.expiresAt = now + TTL_MS;
            if (title) entry.title = title;
            return id;
        }
    }

    const id = newStreamGuid();
    streams.set(id, { url, title: title || "Video", expiresAt: now + TTL_MS });

    return id;
}

function resolve(guid) {
    const id = normalise(guid);
    const entry = streams.get(id);

    if (!entry) return null;

    const now = Date.now();

    if (entry.expiresAt <= now) {
        streams.delete(id);
        return null;
    }

    // Sliding, so a long file does not expire mid-playback.
    entry.expiresAt = now + TTL_MS;

    return entry;
}

module.exports = { register, resolve };
