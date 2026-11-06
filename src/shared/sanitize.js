const cleanPart = (value) => String(value ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/gu, '')
    .trim().replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^[._]+|[._]+$/g, '');

function truncatePart(value, maxUnits, maxBytes) {
    let result = '';
    let bytes = 0;
    const encoder = new TextEncoder();
    for (const character of value) {
        const size = encoder.encode(character).length;
        if (result.length + character.length > maxUnits || bytes + size > maxBytes) break;
        result += character;
        bytes += size;
    }
    return result;
}

function domainLabel(pageUrl) {
    try {
        const host = new URL(pageUrl).hostname.replace(/\.$/, '');
        if (!host.includes('.') || host.includes(':') || /^[\d.]+$/.test(host)) return 'local';
        const parts = host.split('.');
        const compound = /^(co|com|org|net|gov|edu|ac)\.[a-z]{2}$/i.test(parts.slice(-2).join('.'));
        return cleanPart(parts.at(compound ? -3 : -2)) || 'local';
    } catch {
        return 'local';
    }
}

export function buildSmartFilename({ pageUrl, headingText, linkText, originalPath } = {}) {
    let path = String(originalPath ?? '');
    try { path = new URL(path).pathname; } catch { path = path.split(/[?#]/)[0]; }
    path = path.split(/[\\/]/).pop() || 'download';
    try { path = decodeURIComponent(path); } catch { /* Keep malformed escapes as text. */ }
    const dot = path.lastIndexOf('.');
    const ext = dot > 0 ? truncatePart(cleanPart(path.slice(dot + 1)), 16, 64) : '';
    const base = cleanPart(dot > 0 ? path.slice(0, dot) : path) || 'download';
    const label = [linkText, headingText].map((value) => cleanPart(String(value ?? '')
        .replace(/\b(?:click\s+here|download|pdf|file)\b/gi, ''))).find(Boolean);
    const suffix = ext ? `.${ext}` : '';
    let stem = [domainLabel(pageUrl), label, base].filter(Boolean).join('_').replace(/_+/g, '_');
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
    stem = truncatePart(stem, 119 - suffix.length, 240 - new TextEncoder().encode(suffix).length)
        .replace(/[. _]+$/, '');
    return `${stem || 'download'}${suffix}`;
}

export function cleanSnippet(rawText, maxLength = 320) {
    const text = String(rawText ?? '').replace(/\s+/g, ' ').trim();
    const limit = Number.isFinite(maxLength) ? Math.max(0, Math.floor(maxLength)) : 320;
    if (text.length <= limit) return text;
    if (text[limit] === ' ') return text.slice(0, limit);
    const end = text.lastIndexOf(' ', limit);
    return end < 0 ? '' : text.slice(0, end);
}
