# stremio-jellyfin

Stremio Web, served so that a **Jellyfin client can connect to it and run it as
an app** — plus playback handed off to that client's native video player.

Multi-arch images (`amd64` + `arm64`) are built from each upstream
[Stremio/stremio-web](https://github.com/Stremio/stremio-web) release, tagged to
mirror upstream's own tags.

```
ghcr.io/<owner>/stremio-jellyfin:v5.0.0-beta.39
ghcr.io/<owner>/stremio-jellyfin:5.0.0-beta.39
ghcr.io/<owner>/stremio-jellyfin:latest
```

## Why this works at all

Jellyfin for Android (mobile) and the LG webOS app are **WebView shells with no
interface of their own**. They validate a server over the Jellyfin protocol,
then load a UI *from that server* and render it. Answer the handshake and they
will happily load Stremio's real UI and run it as an app.

The split that matters is **WebView-shell vs native**, not official vs
third-party. Jellyfin for Android **TV**, Swiftfin and Findroid build their own
UI from the API — they will connect, and show an empty library, because there
genuinely is nothing to enumerate: Stremio's catalogue lives in addons, not in
a database this server can see.

## Running it

```bash
docker run -p 8080:8080 \
  -e JELLYFIN_PASSWORD=change-me \
  ghcr.io/<owner>/stremio-jellyfin:latest
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `JELLYFIN_PASSWORD` | *(none)* | Password the client logs in with. **Required** — unset means authentication is refused outright, rather than left open. |
| `JELLYFIN_USERNAME` | `stremio` | Username shown on the client's login screen. |
| `JELLYFIN_SERVER_NAME` | `Stremio` | Name shown in the client's server list. |
| `JELLYFIN_ENABLED` | `true` | Set `false` to serve plain Stremio Web with no Jellyfin surface. |

Point the Jellyfin client at `http://<host>:8080` and sign in.

## Playback

Stremio's own player runs in the WebView as normal when the client's player
type is **Web UI**.

With **ExoPlayer** or **External player** selected, playback is handed to the
native side. That needs an id, not a URL, and the reason is worth stating
because it is unintuitive:

- `ExternalPlayer.initPlayer()` builds its intent with
  `setDataAndType(uri, "video/*")` — that MIME type is precisely what makes
  Android offer the **media-player chooser**. It accepts **item ids** only.
- `NativeInterface.openUrl()`, the only bridge that takes a URL, fires a bare
  `Intent(ACTION_VIEW, uri)` with **no MIME type**. Android then matches an
  `http` URL on scheme alone and a browser always wins — the video opens in a
  browser and no chooser ever appears.

So a stream URL is registered (`POST /jellyfin/register-stream`), gets a
Jellyfin id back, and this server answers `/Items/{id}`,
`/Items/{id}/PlaybackInfo` and `/Videos/{id}/stream` for it. That last route is
not optional: both native players **build the stream URL themselves** via
`videosApi.getVideoStreamUrl()` rather than using anything the MediaSource
carried. It redirects to the addon's real URL rather than proxying, so this
container never sits in the middle of a video stream.

### The known-fragile part

Stremio Web is a compiled React app with **no stable hook for "a stream was
selected"** and no plugin surface. Rather than reach into its internals — which
would break on any upstream rebuild — the bridge watches for the one thing
guaranteed to be observable: a `<video>` element acquiring a source.

This means:

- **`blob:` / MediaSource playback cannot be handed off.** There is no URL
  another app could fetch, so those keep playing in-page. This is a real
  limitation, not a bug to be fixed here.
- If upstream ever exposes a genuine event for stream selection, **prefer it
  and delete the observer** in `patch/files/jellyfin/bundle.js`.

## How the patch is maintained

Upstream is never forked. Each build checks out an upstream tag and applies
`patch/apply.mjs` to it:

1. copies `jellyfin/` into the checkout;
2. rewires `http_server.js` to mount the Jellyfin router ahead of the static
   handler, and to serve `index.html` itself;
3. adds `COPY jellyfin` to the `Dockerfile`.

**Every edit is anchored to text that must already exist, and a missing anchor
fails the build.** Publishing an image whose Jellyfin surface is silently not
wired up is worse than publishing nothing: it presents to a user as "the client
won't connect", with nothing pointing back here.

`apply.mjs` is idempotent, and CI asserts that — a second run that reports any
file as freshly patched fails, because an edit that cannot detect its own
previous application will duplicate itself.

### Why `index.html` is served explicitly

`JellyfinWebViewClient.shouldInterceptRequest()` calls `onConnectedToWebapp()`
the moment it sees a request path shaped like `main.<anything>.bundle.js` — **the
response body is never read.** So every HTML page must reference that path, or
the client shows a spinner and times out after 10 seconds with no error.

The obvious implementation — middleware wrapping `res.send` — **does not work**:
`express.static` delivers `index.html` via `res.sendFile`, which streams the
file and never goes through `res.send`, so the injection silently never fires.
Found by running the patched server and finding zero references to the bundle
in the served HTML. Hence the explicit handler ahead of the static middleware.

## Upstream needs a real git checkout, not a tarball

`webpack.config.js` shells out to `git rev-parse HEAD` at build time, so a
source tarball fails the build outright:

```
[webpack-cli] Failed to load '/var/www/stremio-web/webpack.config.js' config
  Command failed: git rev-parse HEAD
```

Upstream's own Dockerfile installs `git` for this reason. CI is unaffected
because `actions/checkout` produces a real repository, but building by hand
means `git clone`, not `curl | tar`. Found exactly that way.

```bash
git clone --depth 1 --branch <tag> https://github.com/Stremio/stremio-web.git upstream
node patch/apply.mjs upstream
docker build -t stremio-jellyfin upstream
```

## Tests

```bash
npm install && npm test
```

Exercises the Jellyfin surface end to end against real express — handshake,
case-insensitive routing, auth, stream registration, `PlaybackInfo`, and the
stream redirect. It runs against the patch's own copy of the module, so it
needs nothing from upstream.

What it **cannot** cover is the half living in the client: the bundle-path
interception and the native bridges only exist inside a real WebView shell.

## Related

- [`riven-frontend-jellyfin`](https://github.com/gauravsuman007/riven-frontend-jellyfin) — the same integration for Riven's frontend.
- [`jellyfin-client-multiplexer`](https://github.com/gauravsuman007/jellyfin-client-multiplexer) — a launcher that lets one Jellyfin client switch between several of these apps.
