#!/usr/bin/env node
/**
 * Inject the Jellyfin integration into a checkout of Stremio/stremio-web.
 *
 *     node patch/apply.mjs <path-to-upstream-checkout>
 *
 * DESIGN RULE: every edit is anchored to text that must already be present,
 * and a missing anchor is a hard failure. Upstream can change any of these
 * files at any time, and the alternative to failing loudly is publishing an
 * image whose Jellyfin surface silently is not wired up -- which presents to
 * a user as "the client will not connect", with nothing pointing back here.
 *
 * Idempotent: applying twice is a no-op, so it is safe to re-run.
 */

import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Defaults to the CURRENT directory, not a nested "upstream/".
//
// CI runs this with `working-directory: upstream` and no argument, so a
// default of "upstream" resolved to upstream/upstream and failed with
// "no such checkout" -- which reads like a missing checkout rather than a
// path bug. riven-frontend-jellyfin's applier uses process.cwd() for the
// same reason; keeping the two consistent avoids re-learning this.
const upstream = resolve(process.argv[2] ?? process.cwd());

if (!existsSync(upstream)) {
    console.error(`no such checkout: ${upstream}`);
    process.exit(1);
}

function fail(message) {
    console.error(`\npatch/apply.mjs: ${message}\n`);
    console.error("Upstream's layout changed. Re-read the file and move the anchor;");
    console.error("do NOT relax this into a silent skip.\n");
    process.exit(1);
}

function edit(relative, describe, transform) {
    const path = join(upstream, relative);

    if (!existsSync(path)) fail(`expected ${relative} to exist in the checkout`);

    const before = readFileSync(path, "utf8");
    const after = transform(before, (m) => fail(`${relative}: ${m}`));

    if (after === null) {
        console.log(`  skipped ${relative} (already patched)`);
        return;
    }

    writeFileSync(path, after);
    console.log(`  patched ${relative} -- ${describe}`);
}

// --- 1. the integration itself -------------------------------------------

cpSync(join(here, "files", "jellyfin"), join(upstream, "jellyfin"), { recursive: true });
console.log("  copied jellyfin/");

// --- 2. mount it in front of the static server ----------------------------

edit("http_server.js", "mounted the Jellyfin router ahead of the static handler", (source, bad) => {
    if (source.includes("./jellyfin/index.js")) return null;

    const anchor = "express().use(express.static(build_path, {";

    if (!source.includes(anchor)) {
        bad("could not find the express().use(express.static(...)) call");
    }

    /*
        Mounted BEFORE express.static, deliberately.

        The Jellyfin paths (/System/Info/Public, /Users/AuthenticateByName)
        do not collide with any file in the build, but the router also serves
        the bundle at a /web/... path and must win there. Mounting after the
        static handler would let a 404 (or, worse, a real file) answer first.
    */
    const head = `const fs = require('fs');

const jellyfin = require('./jellyfin/index.js');

const app = express();

/*
    index.html is READ AND REWRITTEN HERE rather than left to
    express.static, and that is not a stylistic choice.

    The client treats a request for "main.<anything>.bundle.js" as the signal
    that it connected -- the response body is never read -- so every HTML page
    MUST reference that path, or the client shows a spinner and times out
    after 10s with no error anywhere.

    The obvious implementation, wrapping res.send in middleware, does NOT
    work: express.static delivers index.html with res.sendFile, which streams
    the file and never goes through res.send, so the injection silently never
    fires. Verified by running the patched server and finding zero references
    to the bundle in the served HTML.

    Serving it explicitly, ahead of express.static, is what makes the
    rewrite actually happen.

    Declared unconditionally so the SPA fallback below can reuse it; the
    injection itself is what is gated on jellyfin.enabled().
*/
const sendIndex = (_req, res) => {
    fs.readFile(index_path, 'utf8', (err, html) => {
        if (err) return res.status(404).send('<h1>404! Page not found</h1>');

        if (jellyfin.enabled() && !html.includes(jellyfin.BUNDLE_PATH)) {
            const tag = \`<script src="\${jellyfin.BUNDLE_PATH}" defer></script>\`;

            html = html.includes('</head>')
                ? html.replace('</head>', tag + '</head>')
                : tag + html;
        }

        res.set('cache-control', \`public, max-age: \${INDEX_CACHE}\`);
        res.type('html').send(html);
    });
};

if (jellyfin.enabled()) {
    app.use(jellyfin.build());
}

app.get('/', sendIndex);
app.get('/index.html', sendIndex);

app.use(express.static(build_path, {`;

    return source.replace(anchor, head);
});

// --- 3. keep the SPA fallback, and stop 404ing the injected page ----------

edit("http_server.js", "served index.html for unknown paths so the shell can deep-link", (source, bad) => {
    if (source.includes("// jellyfin: SPA fallback")) return null;

    const anchor = `})).all('*', (_req, res) => {`;

    if (!source.includes(anchor)) bad("could not find the catch-all 404 handler");

    /*
        The shell loads "/" and Stremio routes client-side from there, but a
        client that deep-links (or reloads on a hash-less path) would hit the
        404 page instead of the app. Returning index.html is the ordinary SPA
        fallback; it is added here rather than upstream because only this
        build is expected to be driven by a WebView client.
    */
    return source.replace(
        anchor,
        `}));

// jellyfin: SPA fallback -- a shell client can deep-link, and the 404 page
// below would otherwise end the session with no way back.
app.get('*', sendIndex);

app.all('*', (_req, res) => {`
    );
});

edit("http_server.js", "started the app we built instead of the discarded chain", (source, bad) => {
    if (source.includes("app.listen(HTTP_PORT")) return null;

    const anchor = `}).listen(HTTP_PORT, () => console.info(\`Server listening on port: \${HTTP_PORT}\`));`;

    if (!source.includes(anchor)) bad("could not find the listen() call");

    return source.replace(
        anchor,
        `});

app.listen(HTTP_PORT, () => console.info(\`Server listening on port: \${HTTP_PORT}\`));`
    );
});

// --- 4. ship the directory in the image -----------------------------------

edit("Dockerfile", "copied jellyfin/ into the final stage", (source, bad) => {
    if (source.includes("COPY jellyfin")) return null;

    const anchor = "COPY http_server.js /var/www/stremio-web";

    if (!source.includes(anchor)) bad("could not find the http_server.js COPY line");

    return source.replace(anchor, `${anchor}\nCOPY jellyfin /var/www/stremio-web/jellyfin`);
});

console.log("\npatch applied.\n");
