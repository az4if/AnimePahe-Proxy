import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { CONFIG } from './config.js';

const require = createRequire(import.meta.url);
const cloudscraper = require('cloudscraper');

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cookieJar = new Map();


process.on('uncaughtException', (err) => {
    console.error('CRITICAL: Uncaught Exception:', err);
    
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});
// ----------------------------------------------------------------------

function createSafeSender(res) {
    let sent = false;
    return (statusCode, data) => {
        if (!sent) {
            sent = true;
            if (!res.headersSent) {
                res.status(statusCode).send(data);
            }
        }
    };
}

function isOriginAllowed(origin, hasUrlParam) {
    const allowed = CONFIG.ALLOWED_ORIGINS;
    // Empty allowlist (or "*") = open proxy. Set ALLOWED_ORIGINS in env to lock it down.
    if (!allowed || allowed.length === 0 || allowed.includes('*')) return true;
    // Non-browser / direct hits send no Origin; allow them as long as a target url is present.
    if (!origin && hasUrlParam) return true;
    return allowed.includes(origin);
}

function buildUpstreamHeaders(req, url, headersParam) {
    const headers = {
        "User-Agent": CONFIG.DEFAULT_USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Upgrade-Insecure-Requests": "1"
    };

    CONFIG.FORWARD_HEADERS.forEach(h => {
        if (req.headers[h]) headers[h] = req.headers[h];
    });

    let referer = CONFIG.DEFAULT_REFERER;
    if (headersParam) {
        try {
            const additionalHeaders = JSON.parse(headersParam);
            Object.entries(additionalHeaders).forEach(([key, value]) => {
                const lk = key.toLowerCase();
                headers[lk] = value;
                if (lk === 'referer' || lk === 'referrer') referer = value;
            });
        } catch (e) { }
    }

    if (referer) {
        let refStr = decodeURIComponent(referer);

        if (url.hostname.includes('kwik') || url.hostname.includes('kwics')) {
            refStr = CONFIG.ANIMEPAHE_BASE;
            if (!refStr.endsWith('/')) refStr += '/';
        } else if (url.hostname.includes('owocdn') || url.hostname.includes('cdn')) {
            if (!refStr.includes('kwik.cx')) {
                refStr = CONFIG.DEFAULT_REFERER;
            }
        }

        if (refStr.includes('kwik.cx') && !refStr.endsWith('/')) {
            refStr += '/';
        }
        headers['referer'] = refStr;

        try {
            headers['origin'] = new URL(refStr).origin;
        } catch (e) {
            headers['origin'] = refStr;
        }
    }

    if (url.hostname.includes('owocdn')) {
        headers['Sec-Fetch-Dest'] = 'iframe';
        headers['Sec-Fetch-Mode'] = 'navigate';
        headers['Sec-Fetch-Site'] = 'cross-site';
    } else {
        headers['Sec-Fetch-Dest'] = 'empty';
        headers['Sec-Fetch-Mode'] = 'cors';
        headers['Sec-Fetch-Site'] = 'cross-site';
    }

    const storedCookies = cookieJar.get(url.hostname);
    if (storedCookies) {
        headers['cookie'] = headers['cookie']
            ? `${headers['cookie']}; ${storedCookies}`
            : storedCookies;
    }

    return headers;
}

function updateCookieJar(url, targetResponse) {
    const setCookie = targetResponse.headers['set-cookie'];
    if (setCookie) {
        const current = cookieJar.get(url.hostname) || "";
        const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];

        const merged = [...new Set([
            ...current.split('; '),
            ...cookies.map(c => c.split(';')[0])
        ])].filter(Boolean).join('; ');

        cookieJar.set(url.hostname, merged);
    }
}

function setCorsHeaders(req, res) {
    const origin = req.headers.origin;
    const allowed = CONFIG.ALLOWED_ORIGINS;
    const permissive = !allowed || allowed.length === 0 || allowed.includes('*');

    // The player loads sources with withCredentials on quality switches; a "*"
    // ACAO is rejected by the browser for credentialed requests, so echo the
    // caller's origin when we trust it and advertise credentials. Fall back to
    // "*" (no credentials) for origin-less/direct hits.
    if (origin && (permissive || allowed.includes(origin))) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }

    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', CONFIG.CORS.ALLOW_METHODS);
    res.setHeader('Access-Control-Allow-Headers', CONFIG.CORS.ALLOW_HEADERS);
    res.setHeader('Access-Control-Expose-Headers', CONFIG.CORS.EXPOSE_HEADERS);
    res.setHeader('Cache-Control', CONFIG.CACHE_CONTROL);
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Proxy-By', 'm3u8-proxy');
    res.setHeader('X-Content-Type-Options', 'nosniff');
}

function generateProxyUrl(targetUrl, headersParam) {
    let proxyUrl = `/m3u8-proxy?url=${encodeURIComponent(targetUrl)}`;
    if (headersParam) proxyUrl += `&headers=${encodeURIComponent(headersParam)}`;
    return proxyUrl;
}

function proxyPlaylistContent(content, url, headersParam) {
    return content.split("\n").map((line) => {
        const trimmed = line.trim();

        if (trimmed === '' || trimmed.startsWith("#EXTM3U") || trimmed.startsWith("#EXT-X-VERSION")) {
            return line;
        }

        if (trimmed.startsWith("#")) {
            return line.replace(/(URI\s*=\s*")([^"]+)(")/gi, (match, prefix, uri, suffix) => {
                try {
                    const abs = new URL(uri, url.href).href;
                    return `${prefix}${generateProxyUrl(abs, headersParam)}${suffix}`;
                } catch (e) {
                    return match;
                }
            });
        }

        try {
            const abs = new URL(trimmed, url.href).href;
            return generateProxyUrl(abs, headersParam);
        } catch (e) {
            return line;
        }
    }).join("\n");
}

app.get('/', (req, res) => {
    res.status(200).send("Welcome to site");
});

app.options('/m3u8-proxy', (req, res) => {
    setCorsHeaders(req, res);
    res.status(204).end();
});

app.get("/m3u8-proxy", async (req, res) => {
    const safeSend = createSafeSender(res);
    const origin = req.headers.origin || "";

    if (!isOriginAllowed(origin, !!req.query.url)) {
        return safeSend(403, `The origin "${origin}" is not allowed to use this proxy.`);
    }

    try {
        const urlStr = req.query.url;
        if (!urlStr) {
            return safeSend(400, { message: "URL is required" });
        }

        const url = new URL(urlStr);
        const headersParam = req.query.headers ? decodeURIComponent(req.query.headers) : "";
        const headers = buildUpstreamHeaders(req, url, headersParam);

        // --- CRITICAL FIX 2: Replaced process.env race condition with strictSSL option ---
        const ignoreTls = url.pathname.endsWith(".mp4"); 

        const options = {
            method: 'GET',
            url: url.href,
            headers: headers,
            encoding: null,
            resolveWithFullResponse: true,
            timeout: 20000,
            strictSSL: !ignoreTls 
        };
        // ---------------------------------------------------------------------------------

        try {
            const targetResponse = await cloudscraper(options);

            updateCookieJar(url, targetResponse);
            setCorsHeaders(req, res);

            const contentType = targetResponse.headers['content-type'] || '';
            const isPlaylist = url.pathname.toLowerCase().endsWith(".m3u8") ||
                contentType.includes("mpegURL") ||
                contentType.includes("application/x-mpegurl");

            if (isPlaylist) {
                const content = targetResponse.body.toString('utf8');
                const proxiedContent = proxyPlaylistContent(content, url, headersParam);
                res.setHeader('Content-Type', "application/vnd.apple.mpegurl");
                res.status(200).send(proxiedContent);
            } else {
                if (targetResponse.statusCode >= 400) {
                    const bodyStr = targetResponse.body.toString('utf8');
                    return safeSend(targetResponse.statusCode, {
                        message: "Upstream returned error",
                        upstreamStatus: targetResponse.statusCode,
                        body: bodyStr.substring(0, 1000)
                    });
                }

                Object.entries(targetResponse.headers).forEach(([k, v]) => {
                    if (CONFIG.UPSTREAM_HEADERS.includes(k.toLowerCase())) {
                        res.setHeader(k, v);
                    }
                });

                res.writeHead(targetResponse.statusCode);
                res.end(targetResponse.body);
            }

        } catch (err) {
            console.error("Cloudscraper error:", err.message);
            if (err.response) {
                return safeSend(err.response.statusCode || 502, {
                    message: "Upstream error (Cloudscraper)",
                    error: err.message
                });
            }
            return safeSend(500, { message: err.message });
        }

    } catch (e) {
        if (!res.headersSent) {
            safeSend(500, { message: e.message });
        }
    }
});

app.listen(CONFIG.PORT, () => {
    console.log(`Server listening on PORT: ${CONFIG.PORT}`);
});
