/**
 * A Jellyfin-compatible surface in front of Stremio Web.
 *
 * WHAT THIS BUYS. Jellyfin for Android (mobile) and the LG webOS app are
 * WebView SHELLS with no interface of their own: they validate a server over
 * this protocol, then load a UI from it. Answer the handshake and they will
 * load Stremio's actual UI and run it as an app. The client split that
 * matters is WebView-shell vs native, NOT official vs third-party --
 * Jellyfin for Android TV, Swiftfin and Findroid build their own UI from the
 * API and will show an empty library here, because there genuinely is no
 * library to enumerate: Stremio's catalogue lives in addons, not in a
 * database this server can see.
 *
 * Case-insensitive routing throughout. Jellyfin's own server is ASP.NET,
 * whose routing is case-insensitive, and real clients depend on it -- they
 * probe /system/info/public, not /System/Info/Public.
 */

"use strict";

const express = require("express");

const config = require("./config.js");
const ids = require("./ids.js");
const streams = require("./streams.js");
const { BUNDLE_PATH, BUNDLE_JS } = require("./bundle.js");

/**
 * One long-lived token rather than a session store.
 *
 * The access token is only ever compared against itself; there is no second
 * user and no revocation story, so anything more would be ceremony. Rotates
 * on restart, which is also the only way to change the password.
 */
const ACCESS_TOKEN = require("node:crypto").randomBytes(16).toString("hex");

function publicInfo() {
    return {
        Id: ids.SERVER_ID.replace(/-/g, ""),
        ServerName: config.serverName(),
        // Claimed as a real, recent Jellyfin. Clients gate features on this
        // and some refuse to connect to a version they do not recognise.
        Version: "10.10.3",
        ProductName: "Jellyfin Server",
        OperatingSystem: "Linux",
        LocalAddress: null,
        StartupWizardCompleted: true
    };
}

function userDto() {
    return {
        Name: config.username(),
        ServerId: ids.SERVER_ID.replace(/-/g, ""),
        Id: ids.USER_ID.replace(/-/g, ""),
        HasPassword: true,
        HasConfiguredPassword: true,
        EnableAutoLogin: false,
        Policy: {
            IsAdministrator: false,
            IsDisabled: false,
            EnableAllFolders: true,
            EnabledFolders: [],
            EnableMediaPlayback: true,
            EnableAudioPlaybackTranscoding: false,
            EnableVideoPlaybackTranscoding: false,
            EnablePlaybackRemuxing: false
        },
        Configuration: { PlayDefaultAudioTrack: true, EnableNextEpisodeAutoPlay: false }
    };
}

function libraryView() {
    return {
        Id: ids.LIBRARY_ID.replace(/-/g, ""),
        ServerId: ids.SERVER_ID.replace(/-/g, ""),
        Name: "Stremio",
        CollectionType: "movies",
        Type: "CollectionFolder",
        IsFolder: true
    };
}

/** The MediaSource for a registered stream URL. */
function sourceDto(guid, title) {
    return {
        Id: guid,
        Protocol: "Http",
        Type: "Default",
        Name: title || "Video",
        Container: "mp4",
        IsRemote: true,
        SupportsDirectPlay: true,
        SupportsDirectStream: true,
        // Never transcoded: this server does not have the file. It is fetched
        // from an addon's host on demand, so there is nothing local to feed a
        // transcoder, and claiming otherwise makes clients request an HLS
        // variant that cannot be produced.
        SupportsTranscoding: false,
        TranscodingUrl: null,
        MediaStreams: [],
        RunTimeTicks: null
    };
}

function itemDto(guid, title) {
    return {
        Id: guid,
        ServerId: ids.SERVER_ID.replace(/-/g, ""),
        Name: title || "Video",
        Type: "Movie",
        MediaType: "Video",
        IsFolder: false,
        LocationType: "FileSystem",
        ParentId: ids.LIBRARY_ID.replace(/-/g, ""),
        RunTimeTicks: null,
        UserData: { PlaybackPositionTicks: 0, Played: false, PlayCount: 0 },
        MediaSources: [sourceDto(guid, title)]
    };
}

function authorised(req) {
    const header = req.get("authorization") || req.get("x-emby-authorization") || "";
    const match = header.match(/token\s*=\s*"?([^",\s]+)"?/i);
    const token = match ? match[1] : req.query.api_key || req.get("x-emby-token") || req.get("x-mediabrowser-token");

    return token === ACCESS_TOKEN;
}

function build() {
    // `caseSensitive` defaults to false, which is what Jellyfin clients
    // expect; stated here so it is not "fixed" into true later.
    const router = express.Router({ caseSensitive: false });

    router.use(express.json({ limit: "64kb" }));

    // --- the bundle, which is also the connection trigger -------------------
    router.get(BUNDLE_PATH, (_req, res) => {
        /*
            A tiny config prelude ahead of the bundle.

            The bundle is a static string, and the streaming server URL is
            deployment-specific, so it is handed over here rather than baked
            in. JSON.stringify, not string concatenation, so a value with a
            quote in it cannot break out of the literal.
        */
        const settings = { streamingServerUrl: config.streamingServerUrl() };

        res
            .type("application/javascript")
            .send(`window.__STREMIO_JELLYFIN__ = ${JSON.stringify(settings)};\n${BUNDLE_JS}`);
    });

    // --- handshake ----------------------------------------------------------
    router.get("/System/Info/Public", (_req, res) => res.json(publicInfo()));

    router.get("/System/Info", (req, res) => {
        if (!authorised(req)) return res.sendStatus(401);
        res.json({ ...publicInfo(), HasUpdateAvailable: false, CanSelfRestart: false });
    });

    router.get("/System/Endpoint", (_req, res) => res.json({ IsLocal: true, IsInNetwork: true }));

    router.get("/Users/Public", (_req, res) => res.json([userDto()]));

    router.post("/Users/AuthenticateByName", (req, res) => {
        const supplied = req.body?.Pw ?? req.body?.Password ?? "";
        const expected = config.password();

        // Refuses everything when unconfigured rather than letting anyone in.
        if (!expected || supplied !== expected) return res.status(401).send("Invalid username or password");

        res.json({
            User: userDto(),
            SessionInfo: { Id: ids.USER_ID.replace(/-/g, ""), UserId: ids.USER_ID.replace(/-/g, "") },
            AccessToken: ACCESS_TOKEN,
            ServerId: ids.SERVER_ID.replace(/-/g, "")
        });
    });

    router.get("/Users/Me", (req, res) => {
        if (!authorised(req)) return res.sendStatus(401);
        res.json(userDto());
    });

    // Answered rather than proxied: the response is irrelevant, only that the
    // request was MADE, because the client's interception of this exact path
    // is what imports credentials into its native session.
    router.post("/Sessions/Capabilities/Full", (_req, res) => res.sendStatus(204));
    router.post("/Sessions/Capabilities", (_req, res) => res.sendStatus(204));
    router.post("/Sessions/Playing", (_req, res) => res.sendStatus(204));
    router.post("/Sessions/Playing/Progress", (_req, res) => res.sendStatus(204));
    router.post("/Sessions/Playing/Stopped", (_req, res) => res.sendStatus(204));

    // --- views --------------------------------------------------------------
    //
    // Deliberately EMPTY. Stremio's catalogue lives in addons the server
    // cannot enumerate, so there is no library to list. A shell client never
    // looks at these -- it loads the UI instead -- and a native client that
    // does gets a truthful empty library rather than a hang.
    const emptyList = (_req, res) => res.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });

    router.get("/Users/:userId/Views", (_req, res) =>
        res.json({ Items: [libraryView()], TotalRecordCount: 1, StartIndex: 0 })
    );
    router.get("/UserViews", (_req, res) =>
        res.json({ Items: [libraryView()], TotalRecordCount: 1, StartIndex: 0 })
    );
    router.get("/Items", emptyList);
    router.get("/Users/:userId/Items", emptyList);
    router.get("/Users/:userId/Items/Latest", (_req, res) => res.json([]));

    // --- the token exchange the bundle uses ---------------------------------
    router.get("/jellyfin/session-token", (_req, res) => {
        res.json({
            ServerId: ids.SERVER_ID.replace(/-/g, ""),
            UserId: ids.USER_ID.replace(/-/g, ""),
            AccessToken: ACCESS_TOKEN
        });
    });

    // --- registering a stream so a player can be given an id ----------------
    router.post("/jellyfin/register-stream", (req, res) => {
        const itemId = streams.register(req.body?.url, req.body?.title);

        if (!itemId) return res.status(400).json({ error: "url is required" });

        res.json({ itemId });
    });

    // --- playback -----------------------------------------------------------
    function lookup(req, res) {
        const guid = ids.normalise(req.params.itemId);

        if (!ids.isStreamGuid(guid)) return null;

        const entry = streams.resolve(guid);

        if (!entry) {
            res.sendStatus(404);
            return null;
        }

        return { guid, entry };
    }

    router.get("/Items/:itemId", (req, res, next) => {
        const found = lookup(req, res);
        if (!found) return res.headersSent ? undefined : next();
        res.json(itemDto(found.guid, found.entry.title));
    });

    router.get("/Users/:userId/Items/:itemId", (req, res, next) => {
        const found = lookup(req, res);
        if (!found) return res.headersSent ? undefined : next();
        res.json(itemDto(found.guid, found.entry.title));
    });

    const playbackInfo = (req, res, next) => {
        const found = lookup(req, res);
        if (!found) return res.headersSent ? undefined : next();

        res.json({
            MediaSources: [sourceDto(found.guid, found.entry.title)],
            PlaySessionId: require("node:crypto").randomBytes(16).toString("hex")
        });
    };

    router.get("/Items/:itemId/PlaybackInfo", playbackInfo);
    router.post("/Items/:itemId/PlaybackInfo", playbackInfo);

    /*
        Both native players BUILD this URL themselves, via
        videosApi.getVideoStreamUrl(), rather than using anything the
        MediaSource carried -- so answering PlaybackInfo alone is not enough
        and this route is not optional.

        A redirect rather than a proxy: the addon host is the one serving the
        bytes, and putting this server in the middle of a video stream would
        add a hop, break range handling subtly, and make the container a
        bandwidth bottleneck for no benefit.
    */
    const streamRoute = (req, res, next) => {
        const found = lookup(req, res);
        if (!found) return res.headersSent ? undefined : next();
        res.redirect(302, found.entry.url);
    };

    router.get("/Videos/:itemId/stream", streamRoute);
    router.get("/Videos/:itemId/stream.:container", streamRoute);

    return router;
}

module.exports = { build, BUNDLE_PATH, enabled: config.enabled };
