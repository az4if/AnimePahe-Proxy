import express from 'express';
import { Readable } from 'stream';

// Node-only equivalent of cd_download_worker. Streams the upstream MP4 (no
// buffering, so large files don't blow up memory), forwards Range for resumable
// downloads, and sets Content-Disposition so the browser saves the file.
//
// URL shape produced by AnimeCore's download.controller.js:
//   <DOWNLOAD_PROXY>/<encodeURIComponent(filename)>?u=<base64url(mp4Url)>
//
// Run separately from the m3u8 proxy (index.js); point AnimeCore's
// DOWNLOAD_PROXY env at this server's base URL.

const PORT = process.env.DOWNLOAD_PORT || process.env.PORT || 3001;
const REFERER = 'https://kwik.cx/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);

const app = express();

function isOriginAllowed(origin) {
    if (!ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes('*')) return true;
    if (!origin) return true; // top-level <a download> navigation sends no Origin
    return ALLOWED_ORIGINS.includes(origin);
}

function setCorsHeaders(req, res) {
    const origin = req.headers.origin || '';
    const allowAll = !ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes('*');
    res.setHeader('Access-Control-Allow-Origin', allowAll ? '*' : origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, Content-Type, Content-Disposition');
    res.setHeader('Vary', 'Origin');
}

function buildContentDisposition(filename) {
    const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function handleDownload(req, res) {
    setCorsHeaders(req, res);

    const origin = req.headers.origin || '';
    if (!isOriginAllowed(origin)) {
        return res.status(403).send(`Origin "${origin}" not allowed`);
    }

    const u = Array.isArray(req.query.u) ? req.query.u[0] : req.query.u;
    if (!u) return res.status(400).send("Missing 'u' parameter");

    let target;
    try {
        target = new URL(Buffer.from(u, 'base64url').toString('utf8'));
        if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error('bad protocol');
    } catch {
        return res.status(400).send('Invalid upstream URL');
    }

    let filename = decodeURIComponent(req.path.split('/').pop() || '') || 'video.mp4';
    filename = filename.replace(/[\r\n]/g, '');

    const upstreamHeaders = { 'User-Agent': USER_AGENT, 'Referer': REFERER, 'Accept': '*/*' };
    if (req.headers.range) upstreamHeaders['Range'] = req.headers.range;

    let upstream;
    try {
        upstream = await fetch(target.href, { method: req.method, headers: upstreamHeaders, redirect: 'follow' });
    } catch (e) {
        return res.status(502).send(`Upstream fetch failed: ${e.message}`);
    }

    FORWARDED_RESPONSE_HEADERS.forEach(h => {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
    });
    res.setHeader('Content-Disposition', buildContentDisposition(filename));
    res.setHeader('Cache-Control', 'no-store');
    res.status(upstream.status);

    if (req.method === 'HEAD' || !upstream.body) {
        return res.end();
    }

    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on('error', () => res.destroy());
    res.on('close', () => nodeStream.destroy());
    nodeStream.pipe(res);
}

app.options('*', (req, res) => {
    setCorsHeaders(req, res);
    res.status(204).end();
});

app.get('*', handleDownload);
app.head('*', handleDownload);

app.listen(PORT, () => {
    console.log(`Download proxy listening on PORT: ${PORT}`);
});
