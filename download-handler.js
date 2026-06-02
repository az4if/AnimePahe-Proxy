import { Readable } from 'stream';
import { CONFIG } from './config.js';

const DOWNLOAD_REFERER = 'https://kwik.cx/';
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

function downloadOriginAllowed(origin) {
    const allowed = CONFIG.ALLOWED_ORIGINS;
    if (!allowed || !allowed.length || allowed.includes('*')) return true;
    if (!origin) return true;
    return allowed.includes(origin);
}

function setDownloadCors(req, res) {
    const origin = req.headers.origin || '';
    const allowAll = !CONFIG.ALLOWED_ORIGINS.length || CONFIG.ALLOWED_ORIGINS.includes('*');
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

export async function handleDownload(req, res) {
    setDownloadCors(req, res);

    const origin = req.headers.origin || '';
    if (!downloadOriginAllowed(origin)) {
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

    const headers = { 'User-Agent': CONFIG.DEFAULT_USER_AGENT, 'Referer': DOWNLOAD_REFERER, 'Accept': '*/*' };
    if (req.headers.range) headers['Range'] = req.headers.range;

    let upstream;
    try {
        upstream = await fetch(target.href, { method: req.method, headers, redirect: 'follow' });
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

    const stream = Readable.fromWeb(upstream.body);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
}

export function registerDownloadRoutes(app) {
    app.options('*', (req, res) => { setDownloadCors(req, res); res.status(204).end(); });
    app.get('*', handleDownload);
    app.head('*', handleDownload);
}
