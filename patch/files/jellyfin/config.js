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

module.exports = { enabled, serverName, username, password };
