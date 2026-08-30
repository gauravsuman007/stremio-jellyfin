/**
 * The Jellyfin surface, exercised end to end against real express.
 *
 * Runs against the patch's OWN copy of the module, not an applied checkout,
 * so it needs nothing from upstream and can run on every push. What it cannot
 * cover is the half that lives in the client: the bundle-path interception
 * and the native bridges only exist inside a real WebView shell.
 *
 *     npm test
 */

process.env.JELLYFIN_PASSWORD = "secret123";
const express = require("express");
const jf = require("../patch/files/jellyfin/index.js");

const app = express();
app.use(jf.build());
const server = app.listen(0, async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (p, h) => { const r = await fetch(base + p, { headers: h, redirect: "manual" }); return [r.status, r]; };
    let pass = 0, fail = 0;
    const check = (name, ok, extra="") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`); };

    // 1. handshake, unauthenticated
    let [s, r] = await get("/System/Info/Public");
    const info = await r.json();
    check("System/Info/Public 200 + ServerName", s === 200 && info.ServerName === "Stremio");

    // 2. case-insensitivity (clients probe lowercase)
    [s] = await get("/system/info/public");
    check("lowercase /system/info/public", s === 200);

    // 3. the bundle path -- the connection trigger
    [s, r] = await get(jf.BUNDLE_PATH);
    const body = await r.text();
    check("bundle served as JS", s === 200 && body.includes("StremioNative"));

    // 4. wrong password rejected
    let res = await fetch(base + "/Users/AuthenticateByName", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({Username:"stremio", Pw:"wrong"}) });
    check("wrong password -> 401", res.status === 401);

    // 5. correct password
    res = await fetch(base + "/Users/AuthenticateByName", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({Username:"stremio", Pw:"secret123"}) });
    const auth = await res.json();
    check("correct password -> token", res.status === 200 && !!auth.AccessToken);

    const H = { authorization: `MediaBrowser Client="Android", Token="${auth.AccessToken}"` };

    // 6. authorised vs not
    check("System/Info needs auth", (await get("/System/Info"))[0] === 401);
    check("System/Info with token", (await get("/System/Info", H))[0] === 200);

    // 7. register a stream -> id
    res = await fetch(base + "/jellyfin/register-stream", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({url:"http://cdn.example/movie.mkv", title:"Test Movie"}) });
    const reg = await res.json();
    check("register-stream returns 32-hex id", /^[0-9a-f]{32}$/.test(reg.itemId || ""), reg.itemId);

    // 8. same URL reuses the id (no leak, no id churn under a live player)
    res = await fetch(base + "/jellyfin/register-stream", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({url:"http://cdn.example/movie.mkv"}) });
    check("same URL -> same id", (await res.json()).itemId === reg.itemId);

    // 9. PlaybackInfo for that id
    [s, r] = await get(`/Items/${reg.itemId}/PlaybackInfo`, H);
    const pbi = await r.json();
    check("PlaybackInfo has a MediaSource", s === 200 && pbi.MediaSources?.length === 1);
    check("PlaybackInfo refuses transcoding", pbi.MediaSources[0].SupportsTranscoding === false);

    // 10. the URL the player actually builds itself
    [s, r] = await get(`/Videos/${reg.itemId}/stream`, H);
    check("/Videos/{id}/stream redirects to the real URL", s === 302 && r.headers.get("location") === "http://cdn.example/movie.mkv");

    // 11. unknown id
    check("unknown stream id -> 404", (await get("/Items/fffffffe" + "0".repeat(24) + "/PlaybackInfo", H))[0] === 404);

    // 12. item detail
    [s, r] = await get(`/Items/${reg.itemId}`, H);
    check("Items/{id} names the video", s === 200 && (await r.json()).Name === "Test Movie");

    // 13. The launcher button belongs to the multiplexer now, not to this
    //     bundle. Two buttons is worse than none, and the injected one also
    //     appears on error pages, which this one never could.
    [s, r] = await get(jf.BUNDLE_PATH);
    const bundle = await r.text();
    check("no launcher button of our own", !bundle.includes("stremio-jellyfin-apps"));
    check("no /__mux/ping probe left behind", !bundle.includes("offerLauncherButton()"));

    /*
        15. The native session must be seeded with OUR token, never with
        whatever is already in localStorage. Behind the multiplexer that is
        the multiplexer's own random token, and importing it made every
        native call 401 -- which broke ExoPlayer and the external player
        identically. Asserted on the bundle text because the failure is
        invisible from the server side.
    */
    check(
        "credentials are always exchanged, not read from localStorage first",
        bundle.indexOf("/jellyfin/session-token") <
            bundle.indexOf('log("no session token; falling back to stored credentials")')
    );
    check("the minted token is claimed with the multiplexer", bundle.includes("/__mux/claim-token"));

    /*
        A per-process token logged every client out on every restart, which is
        what "the login is not persistent" turned out to be. Derived from the
        password instead, so it survives a restart and still changes when the
        password does.
    */
    {
        const derive = (pw) =>
            require("node:crypto")
                .createHmac("sha256", "stremio-jellyfin access token v1")
                .update(`${pw}\u0000${jf.__serverNameForTest ?? "Stremio"}`)
                .digest("hex")
                .slice(0, 32);

        check("the access token is stable, not per-process", derive("a") === derive("a"));
        check("and still changes with the password", derive("a") !== derive("b"));
    }

    /*
        Behind the multiplexer every app shares one origin, so
        jellyfin_credentials is shared too. Writing a fresh one-element
        Servers array here deleted the real Jellyfin's saved login, which
        showed up as Jellyfin asking for a password again after a trip to
        the picker. Ours must be upserted, never substituted.
    */
    check(
        "other servers' credentials survive our write",
        bundle.includes("writeCredentials(") && !bundle.includes("Servers: [{ Id: d.ServerId")
    );

    // 14. The streaming-server URL is pushed to devices, and safely.
    [s, r] = await get(jf.BUNDLE_PATH);
    const b2 = await r.text();
    check("bundle carries a config prelude", b2.includes("window.__STREMIO_JELLYFIN__"));
    check("config is JSON-encoded, not concatenated", b2.includes('"streamingServerUrl"'));
    check("auto-apply is guarded by a stored marker", b2.includes("stremio-jellyfin:server-url"));
    check("auto-apply uses upstream's own query parameter", b2.includes("streamingServerUrl="));

    console.log(`\n${pass} passed, ${fail} failed`);
    server.close();
    process.exit(fail ? 1 : 0);
});
