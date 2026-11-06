import { buildSmartFilename } from '../shared/sanitize.js';

const VAULT_KEY = 'vault_records';
const CACHE_KEY = 'click_contexts';
const MAX_AGE = 120_000;
const MAX_CLICKS = 100;
const MENU_ID = 'breadcrumb-smart-download';
const NOTE_PROMPTS = 'note_prompts';
const text = (value) => typeof value === 'string' ? value : '';

// Web Locks serialize storage read/modify/write operations without an in-memory queue.
const exclusive = (task) => navigator.locks.request('breadcrumb-storage', task);
const report = (error) => console.error('BreadcrumbDL:', error);

function normalizeUrl(value) {
    try {
        const url = new URL(value);
        url.hash = '';
        return url.href;
    } catch {
        return '';
    }
}

function provenanceUrl(value) {
    try {
        const url = new URL(text(value));
        if (url.protocol === 'data:') return 'data:';
        url.username = '';
        url.password = '';
        url.hash = '';
        for (const key of [...url.searchParams.keys()]) {
            if (/^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|auth|authorization|api[_-]?key|password|passwd|secret|session(?:id)?|code|signature|x-amz-signature|x-goog-signature)$/i.test(key)) {
                url.searchParams.set(key, '[redacted]');
            }
        }
        return url.href.slice(0, 8192);
    } catch {
        return '';
    }
}

function senderContext(raw, sender) {
    const context = cleanContext(raw);
    // Browser-supplied document identity takes precedence over message payloads.
    context.pageUrl = text(sender.url) || text(sender.tab?.url) || context.pageUrl;
    return context;
}

function excludedDownload(item) {
    return item.incognito || text(item.url).startsWith(`blob:${browser.runtime.getURL('')}`);
}

function cleanContext(raw = {}) {
    return Object.fromEntries([
        'href', 'pageUrl', 'pageTitle', 'nearestHeading', 'linkText',
        'containerText', 'selectedText',
    ].map((key) => [key, text(raw?.[key]).slice(0, 8000)]));
}

async function cacheClick(raw, tabId, note = '', documentToken = '') {
    const context = cleanContext(raw);
    const targetUrl = normalizeUrl(context.href || context.pageUrl);
    if (!Number.isInteger(tabId) || !targetUrl) return null;
    const stored = await browser.storage.session.get(CACHE_KEY);
    const now = Date.now();
    const clicks = (Array.isArray(stored[CACHE_KEY]) ? stored[CACHE_KEY] : [])
        .filter((click) => now - click.timestamp < MAX_AGE);
    const click = {
        key: `${tabId}:${targetUrl}`, tabId, targetUrl, context,
        timestamp: now, userNote: text(note).slice(0, 8000), documentToken: text(documentToken),
    };
    clicks.push(click);
    await browser.storage.session.set({ [CACHE_KEY]: clicks.slice(-MAX_CLICKS) });
    return click;
}

async function recentClicks() {
    const stored = await browser.storage.session.get(CACHE_KEY);
    const clicks = (Array.isArray(stored[CACHE_KEY]) ? stored[CACHE_KEY] : [])
        .filter((click) => Date.now() - click.timestamp < MAX_AGE);
    await browser.storage.session.set({ [CACHE_KEY]: clicks });
    return clicks.reverse();
}

async function activeTab() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    return tab;
}

async function matchClick(item) {
    const clicks = await recentClicks();
    const tabId = Number.isInteger(item.tabId) && item.tabId >= 0
        ? item.tabId : (await activeTab())?.id;
    const scoped = clicks.filter((click) => click.tabId === tabId);
    const urls = [item.url, item.finalUrl].map(normalizeUrl).filter(Boolean);
    const exact = scoped.find((click) => urls.includes(click.targetUrl));
    if (exact) return exact;
    const referrer = normalizeUrl(item.referrer);
    if (referrer) {
        const match = scoped.find((click) =>
            normalizeUrl(click.context.pageUrl) === referrer || click.targetUrl === referrer);
        return match ?? null;
    }
    return null;
}

async function readVault() {
    const stored = await browser.storage.local.get(VAULT_KEY);
    return Array.isArray(stored[VAULT_KEY]) ? stored[VAULT_KEY]
        .filter((record) => record && typeof record === 'object' && !Array.isArray(record)) : [];
}

function tagsFrom(note) {
    return [...new Set(Array.from(note.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu),
        (match) => match[1].toLowerCase()))];
}

function basename(path) {
    return text(path).split(/[\\/]/).pop() || '';
}

async function notify(tabId, message) {
    if (!Number.isInteger(tabId)) return;
    try {
        await browser.tabs.sendMessage(tabId, message);
    } catch {
        // Restricted pages and closed tabs have no content-script receiver.
    }
}

const toastRecord = (record) => ({ id: record.id, filename: record.filename });

async function promptNote(origin, record) {
    const { tabId, documentToken } = origin ?? {};
    if (!Number.isInteger(tabId) || !documentToken || origin.notification === false) return '';
    const stored = await browser.storage.session.get(NOTE_PROMPTS);
    const prompts = (Array.isArray(stored[NOTE_PROMPTS]) ? stored[NOTE_PROMPTS] : [])
        .filter((entry) => entry.tabId !== tabId && Date.now() - entry.timestamp < 1_800_000);
    const token = crypto.randomUUID();
    prompts.push({ tabId, documentToken, recordId: record.id, token, timestamp: Date.now() });
    await browser.storage.session.set({ [NOTE_PROMPTS]: prompts.slice(-100) });
    await notify(tabId, { type: 'DOWNLOAD_SAVED', documentToken, noteToken: token, record: toastRecord(record) });
    return token;
}

async function recordDownload(item, click, showToast = true) {
    const records = await readVault();
    const existing = records.find((record) => record.downloadId === item.id);
    if (existing) return existing;
    const context = click?.context ?? {};
    const note = click?.userNote ?? '';
    const record = {
        id: crypto.randomUUID(), downloadId: item.id,
        filename: basename(item.filename), url: provenanceUrl(item.url), referrer: provenanceUrl(item.referrer),
        pageUrl: provenanceUrl(context.pageUrl || item.referrer), pageTitle: context.pageTitle || '',
        nearestHeading: context.nearestHeading || '', linkText: context.linkText || '',
        containerText: context.containerText || '', selectedText: context.selectedText || '',
        userNote: note, tags: tagsFrom(note), timestamp: Date.now(),
    };
    records.push(record);
    await browser.storage.local.set({ [VAULT_KEY]: records.slice(-500) });
    for (const expired of records.slice(0, -500)) {
        await browser.storage.session.remove(`download_origin:${expired.downloadId}`);
    }
    await browser.storage.session.set({ [`download_origin:${item.id}`]: {
        tabId: click?.tabId ?? null, documentToken: click?.documentToken || '',
        notification: click?.notification !== false,
    } });
    if (showToast) await promptNote(click, record);
    return record;
}

function smartFilename(context) {
    return buildSmartFilename({
        pageUrl: context.pageUrl, headingText: context.nearestHeading,
        linkText: context.linkText, originalPath: context.href,
    });
}

async function smartDownload(raw, tab, note, documentToken) {
    if (tab?.incognito) throw new Error('BreadcrumbDL does not retain private browsing downloads');
    const context = cleanContext(raw);
    const url = new URL(context.href);
    if (!['http:', 'https:', 'ftp:'].includes(url.protocol)) throw new Error('Unsupported download URL');
    const click = await cacheClick(context, tab?.id, note, documentToken);
    const filename = smartFilename(context);
    const downloadId = await browser.downloads.download({ url: url.href, filename, saveAs: false });
    const [item] = await browser.downloads.search({ id: downloadId });
    const record = await recordDownload(item ?? { id: downloadId, url: url.href, filename }, click, false);
    const noteToken = await promptNote(click, record);
    return { ok: true, downloadId, filename: record.filename || filename, record: toastRecord(record), noteToken };
}

async function authorizedNote(message, sender) {
    const stored = await browser.storage.session.get(NOTE_PROMPTS);
    const prompts = Array.isArray(stored[NOTE_PROMPTS]) ? stored[NOTE_PROMPTS] : [];
    const prompt = prompts.find((entry) => entry.tabId === sender.tab?.id
        && entry.recordId === message.recordId && entry.token === message.noteToken
        && entry.documentToken === message.documentToken
        && Date.now() - entry.timestamp < 1_800_000);
    if (!prompt) throw new Error('Note request expired. Open the note editor again.');
    return prompt;
}

async function saveNote(message, sender) {
    const prompt = await authorizedNote(message, sender);
    const records = await readVault();
    const record = records.find((entry) => entry.id === prompt.recordId);
    if (!record) throw new Error('No download to annotate yet');
    record.userNote = text(message.note ?? message.userNote).trim().slice(0, 8000);
    record.tags = tagsFrom(record.userNote);
    await browser.storage.local.set({ [VAULT_KEY]: records });
    return { ok: true, record: toastRecord(record) };
}

async function openNoteEditor(recordId) {
    const record = (await readVault()).find((entry) => entry.id === recordId);
    if (!record) throw new Error('No download to annotate yet');
    await browser.storage.session.set({ popup_note_record: { recordId } });
    await browser.action.openPopup();
    return { ok: true };
}

browser.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== browser.runtime.id || sender.tab?.incognito
        || !Number.isInteger(sender.tab?.id) || (sender.frameId ?? 0) !== 0) return undefined;
    const type = message?.type;
    if (!['CAPTURED_CLICK_CONTEXT', 'TRIGGER_SMART_DOWNLOAD', 'SAVE_QUICK_NOTE', 'OPEN_NOTE_EDITOR',
        'remember-click', 'download', 'preview'].includes(type)) return undefined;
    return exclusive(async () => {
        if (!/^[\da-f-]{36}$/i.test(text(message.documentToken))) throw new Error('Invalid document identity');
        if (type === 'CAPTURED_CLICK_CONTEXT' || type === 'remember-click') {
            await cacheClick(senderContext(message.context, sender), sender.tab?.id, '', message.documentToken);
            return { ok: true };
        }
        if (type === 'SAVE_QUICK_NOTE') return saveNote(message, sender);
        if (type === 'OPEN_NOTE_EDITOR') {
            const prompt = await authorizedNote(message, sender);
            return openNoteEditor(prompt.recordId);
        }
        if (type === 'preview') return { filename: smartFilename(senderContext(message.context, sender)) };
        return smartDownload(senderContext(message.context, sender), sender.tab, message.note, message.documentToken);
    }).catch((error) => ({ ok: false, error: error.message }));
});

browser.runtime.onInstalled.addListener(() => {
    (async () => {
        await browser.menus.removeAll();
        browser.menus.create({ id: MENU_ID, contexts: ['link'], title: 'Download with Breadcrumb Name' });
        await exclusive(async () => {
            const records = await readVault();
            for (const record of records) {
                for (const field of ['url', 'referrer', 'pageUrl']) record[field] = provenanceUrl(record[field]);
            }
            await browser.storage.local.set({ [VAULT_KEY]: records.slice(-500) });
        });
    })().catch(report);
});

browser.menus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_ID) return;
    exclusive(async () => {
        const clicks = await recentClicks();
        const click = clicks.find((entry) => entry.tabId === tab?.id
            && entry.targetUrl === normalizeUrl(info.linkUrl));
        await smartDownload({
            ...click?.context, href: info.linkUrl,
            pageUrl: click?.context.pageUrl || info.pageUrl || tab?.url,
            pageTitle: click?.context.pageTitle || tab?.title,
            linkText: click?.context.linkText || info.linkText,
            selectedText: click?.context.selectedText || info.selectionText,
        }, tab, '', click?.documentToken);
    }).catch(report);
});

browser.downloads.onCreated.addListener((item) => {
    if (excludedDownload(item)) return;
    exclusive(async () => recordDownload(item, await matchClick(item))).catch(report);
});

browser.downloads.onChanged.addListener((delta) => {
    if (!delta.filename && !delta.state) return;
    exclusive(async () => {
        const [item] = await browser.downloads.search({ id: delta.id });
        if (item && excludedDownload(item)) return;
        let records = await readVault();
        let record = records.find((entry) => entry.downloadId === delta.id);
        if (!record) {
            if (!item) return;
            await recordDownload(item, await matchClick(item));
            records = await readVault();
            record = records.find((entry) => entry.downloadId === delta.id);
        }
        if (delta.filename) {
            record.filename = basename(delta.filename.current);
            await browser.storage.local.set({ [VAULT_KEY]: records });
            const key = `download_origin:${delta.id}`;
            const stored = await browser.storage.session.get(key);
            await promptNote(stored[key], record);
        }
        if (['complete', 'interrupted'].includes(delta.state?.current)) {
            await browser.storage.session.remove(`download_origin:${delta.id}`);
        }
    }).catch(report);
});

browser.commands.onCommand.addListener((command) => {
    if (command !== 'quick-note') return;
    return (async () => {
        const tab = await activeTab();
        if (tab?.incognito) return;
        try {
            const response = await browser.tabs.sendMessage(tab.id, { type: 'QUICK_NOTE_REQUEST' });
            if (response?.handled) return;
        } catch {
            // Restricted pages have no content script; the popup remains available.
        }
        await exclusive(async () => {
            const record = (await readVault()).at(-1);
            if (record) await openNoteEditor(record.id);
        });
    })().catch(report);
});
