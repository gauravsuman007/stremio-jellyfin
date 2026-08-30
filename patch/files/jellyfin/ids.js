/**
 * Jellyfin GUID-shaped ids for things Stremio does not number that way.
 *
 * Jellyfin clients treat item ids as opaque but overwhelmingly assume the
 * 32-hex shape a .NET Guid serialises to, and mangle or reject anything else.
 * Stremio identifies content by addon ids like "tt0111161" or
 * "kitsu:12345:1", which are not that shape and not fixed-width, so they are
 * carried by reference: a random 32-hex id that maps back to the real stream.
 *
 * Kept structurally identical to riven-frontend-jellyfin's ids.js so the two
 * integrations stay readable side by side.
 */

"use strict";

const { randomBytes } = require("node:crypto");

// Constants rather than derived values: none of these correspond to a record
// anywhere, and clients cache them, so they must not move between restarts.
const SERVER_ID = "73747265-6d69-6f6a-6600-000000000001";
const USER_ID = "73747265-6d69-6f6a-6600-000000000002";
const LIBRARY_ID = "73747265-6d69-6f6a-6600-000000000003";

/** High bit set, so a stream id can never be mistaken for one of the above. */
const STREAM_PREFIX = "fffffffe";

const BODY_HEX = 24;

function newStreamGuid() {
    return STREAM_PREFIX + randomBytes(BODY_HEX / 2).toString("hex");
}

function isStreamGuid(guid) {
    const cleaned = String(guid || "").replace(/-/g, "").trim().toLowerCase();

    return cleaned.startsWith(STREAM_PREFIX) && cleaned.length === STREAM_PREFIX.length + BODY_HEX;
}

function normalise(guid) {
    return String(guid || "").replace(/-/g, "").trim().toLowerCase();
}

module.exports = { SERVER_ID, USER_ID, LIBRARY_ID, newStreamGuid, isStreamGuid, normalise };
