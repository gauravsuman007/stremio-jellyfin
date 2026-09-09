# stremio-jellyfin — agent notes

Stremio Web served so a Jellyfin client can connect to it and run it as an app,
with playback handed off to that client's native player. Built as a **patch**
over each upstream `Stremio/stremio-web` release. `README.md` covers why it
works at all; this file covers working on it.

Several Claude Code sessions work across these repos at once. Before changing
anything: `git log --oneline -10`.

## Layout

`patch/apply.mjs` plus `patch/files/jellyfin/{index,bundle,config,streams,ids}.js`.
No fork of upstream lives here. The patch is anchored to text that must already
be present and **fails hard** on a missing anchor — never relax one into a
silent skip, and keep every edit idempotent (CI applies it twice).

`bundle.js` is the half that runs in the client. It is plain JavaScript served
into the page, not part of the express server, and nothing type-checks it —
read it carefully.

## Testing and CI

- `npm test` — `test/surface.test.js` drives the Jellyfin surface end to end
  against real express, using the patch's own copy of the module. It needs no
  upstream checkout, so it runs on every push.
- **It cannot cover the client half.** Bundle-path interception and the native
  bridges only exist inside a real WebView shell. Changes to `bundle.js` are
  verified on a device or not at all.
- `verify-patch.yml` (push + nightly) proves the patch still applies;
  `build-upstream-releases.yml` polls upstream tags and publishes
  `ghcr.io/gauravsuman007/stremio-jellyfin:<tag>` and `:latest`.

## Deployment — two containers, and the setting between them

    ssh 192.168.2.100 'cd /home/hellonfire/Server/stremio && \
      docker compose pull && docker compose up -d'

- `stremio-web` (this image, port 8098) and `stremio-server`
  (`stremio/server`, port 11470) are **both required**.
- `STREMIO_STREAMING_SERVER_URL` must be `http://192.168.2.100:11470`, not the
  default. Each device otherwise resolves `127.0.0.1:11470` against *itself* —
  inside a phone's WebView that is the phone, where nothing is listening.
- **An addon cannot do this job.** That was tried; the client shell is the
  reason it cannot work.

## Traps that have cost time

- **`window.ExternalPlayer.initPlayer` has no `isEnabled()`**, takes item
  **ids** (not URLs), resolves them through `/Items/{id}/PlaybackInfo`, and
  reports every failure as an Android Toast with no callback. So gate the
  button on `initPlayer` merely *existing*, register the URL first via
  `POST /jellyfin/register-stream`, and never trust a return value to mean the
  hand-off happened.
- **Install the external-player button *before* the `nativeAvailable()`
  gate.** Behind the gate it never appears in the shells that need it.
- Hide the button for `blob:` and `data:` sources — another app cannot fetch
  those. Re-poll (~1.5 s) and re-parent into `document.fullscreenElement` on
  mount, or it vanishes when Stremio's player goes fullscreen.
- **Mint our own token; never trust `localStorage`.** And derive it so it
  survives a restart — a token minted per process logs every client out on
  every deploy.
- **Upsert `jellyfin_credentials`, never replace it.** Behind the multiplexer
  every app shares one origin, so a wholesale write deletes the real Jellyfin
  login.
- **webOS needs `/web/manifest.json` answered** or the client never completes
  its handshake.
- **`openUrl` can never reach a media player.** It goes to the browser.

## Related repos

`jellyfin-client-multiplexer` (serves this as the `stremio` app),
`riven-tpdb-frontend`, `riven-frontend-jellyfin`. Each has its own `AGENTS.md`.
