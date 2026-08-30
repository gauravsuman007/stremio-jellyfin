/**
 * Env-only configuration, deliberately.
 *
 * Stremio Web has no server-side settings store to hang this off -- it is a
 * static SPA with a twenty-line Express server in front of it -- so there is
 * nowhere to persist a Jellyfin credential except the environment. Restart to
 * change one.
 */

"use strict";

function enabled() {
    return (process.env.JELLYFIN_ENABLED ?? "true").toLowerCase() !== "false";
}

function serverName() {
    return process.env.JELLYFIN_SERVER_NAME || "Stremio";
}

function username() {
    return process.env.JELLYFIN_USERNAME || "stremio";
}

/**
 * The password a Jellyfin client must present.
 *
 * No default. An empty password would make the server world-open to anything
 * that can reach the port, and a hardcoded one is worse because it looks like
 * security. When this is unset the Jellyfin surface refuses to authenticate
 * anyone and says so in the log at startup, which is a visible failure rather
 * than a silent hole.
 */
function password() {
    return process.env.JELLYFIN_PASSWORD || "";
}


/**
 * The streaming server a browser should use, pushed to every device.
 *
 * Stremio keeps this per-device and defaults it to http://127.0.0.1:11470,
 * which inside a phone or TV WebView means the CLIENT, not the host -- so it
 * silently finds nothing and no stream ever plays. It is also NOT part of what
 * a Stremio account syncs, so setting it on one device does nothing for the
 * next one.
 *
 * When this is set, the bundle applies it once per device via the
 * `?streamingServerUrl=` parameter that upstream's SearchParamsHandler already
 * understands, which removes the manual settings step entirely.
 */
function streamingServerUrl() {
    return process.env.STREMIO_STREAMING_SERVER_URL || "";
}

module.exports = { enabled, serverName, username, password, streamingServerUrl };
