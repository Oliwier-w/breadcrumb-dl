import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { buildSmartFilename, cleanSnippet } from '../src/shared/sanitize.js';

function event() {
    return { listeners: [], addListener(fn) { this.listeners.push(fn); },
        emit(...args) { return this.listeners.map((fn) => fn(...args)); } };
}

function storage() {
    const data = {};
    return { data,
        async get(key) { return structuredClone({ [key]: data[key] }); },
        async set(values) { Object.assign(data, structuredClone(values)); },
        async remove(key) { delete data[key]; },
    };
}

test('background event-page workflows survive reloads and overlapping events', async () => {
    const session = storage();
    const local = storage();
    const sent = [];
    const items = new Map();
    const requests = [];
    let queue = Promise.resolve();
    let nextId = 100;
    let popupCount = 0;
    const documentToken = '11111111-1111-4111-8111-111111111111';
    const events = {
        messages: event(), installed: event(), menu: event(), created: event(),
        changed: event(), command: event(),
    };
    const locks = { request(name, task) {
        const result = queue.then(task);
        queue = result.catch(() => {});
        return result;
    } };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } });
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
    globalThis.browser = {
        runtime: { id: 'test', getURL: (path) => `moz-extension://test/${path}`,
            onMessage: events.messages, onInstalled: events.installed },
        storage: { session, local },
        action: { async openPopup() { popupCount++; } },
        tabs: {
            async query() { return [{ id: 7, url: 'https://example.com/page', title: 'Example' }]; },
            async sendMessage(tabId, message) { sent.push({ tabId, message }); },
        },
        menus: { onClicked: events.menu, async removeAll() {}, create() {} },
        commands: { onCommand: events.command },
        downloads: {
            onCreated: events.created, onChanged: events.changed,
            async search({ id }) { return items.has(id) ? [items.get(id)] : []; },
            async download(options) {
                requests.push(options);
                const item = { id: nextId++, ...options };
                items.set(item.id, item);
                events.created.emit(item);
                return item.id;
            },
        },
    };
    const source = (await readFile(new URL('../src/background/index.js', import.meta.url), 'utf8'))
        .replace(/^import[^\n]+\n/, '');
    async function load() {
        for (const value of Object.values(events)) value.listeners.length = 0;
        vm.runInNewContext(source, {
            browser: globalThis.browser, navigator: globalThis.navigator,
            crypto: webcrypto, buildSmartFilename, URL, console,
        }, { filename: 'src/background/index.js' });
    }
    async function flush() {
        let previous;
        do { previous = queue; await previous; } while (queue !== previous);
    }
    async function message(type, payload = {}, tabId = 7) {
        return events.messages.listeners[0]({ type, documentToken, ...payload }, { id: 'test', tab: { id: tabId } });
    }
    const context = {
        href: 'https://cdn.example.com/report.pdf#download', pageUrl: 'https://example.com/page',
        pageTitle: 'Example', nearestHeading: 'Annual report', linkText: 'Download',
        containerText: 'Financial results', selectedText: '2026',
    };
    await load();
    await message('CAPTURED_CLICK_CONTEXT', { context });
    assert.equal(session.data.click_contexts[0].key, '7:https://cdn.example.com/report.pdf');
    await load();

    events.created.emit({ id: 1, url: 'https://cdn.example.com/report.pdf', filename: '' });
    events.created.emit({ id: 2, url: 'https://redirect.example.net/file', referrer: context.pageUrl });
    await flush();
    assert.equal(local.data.vault_records.length, 2);
    assert.equal(local.data.vault_records[0].containerText, 'Financial results');
    assert.equal(local.data.vault_records[1].nearestHeading, 'Annual report');
    assert.match(local.data.vault_records[0].id, /^[\da-f-]{36}$/);
    events.changed.emit({ id: 1, filename: { current: 'C:\\Downloads\\final.pdf' } });
    await flush();
    assert.equal(local.data.vault_records[0].filename, 'final.pdf');
    assert.equal(sent.at(-1).tabId, 7);

    const result = await message('TRIGGER_SMART_DOWNLOAD', { context, note: 'Read #Finance' });
    await flush();
    assert.equal(result.ok, true);
    assert.equal(requests[0].filename, 'example_Annual_report_report.pdf');
    assert.equal(requests[0].saveAs, false);
    assert.equal(local.data.vault_records.filter((record) => record.downloadId === result.downloadId).length, 1);
    assert.equal(local.data.vault_records.at(-1).userNote, 'Read #Finance');

    await load();
    const prompt = sent.at(-1).message;
    await message('SAVE_QUICK_NOTE', { note: 'Review #Finance #finance #年次',
        recordId: prompt.record.id, noteToken: prompt.noteToken });
    assert.deepEqual(local.data.vault_records.at(-1).tags, ['finance', '年次']);
    await Promise.all(events.command.emit('quick-note'));
    await flush();
    assert.equal(popupCount, 1);
    assert.equal(session.data.popup_note_record.recordId, result.record.id);
    assert.equal(sent.at(-1).message.type, 'QUICK_NOTE_REQUEST');
    const savedMessage = sent.filter((entry) => entry.message.type === 'DOWNLOAD_SAVED').at(-1).message;
    assert.deepEqual(Object.keys(savedMessage.record).sort(), ['filename', 'id']);

    const forgedNote = await message('SAVE_QUICK_NOTE', {
        recordId: result.record.id, noteToken: 'forged', note: 'overwrite',
    });
    assert.equal(forgedNote.ok, false);
    const foreignTab = await message('SAVE_QUICK_NOTE', {
        recordId: result.record.id, noteToken: savedMessage.noteToken, note: 'overwrite',
    }, 8);
    assert.equal(foreignTab.ok, false);
    assert.equal(local.data.vault_records.at(-1).userNote, 'Review #Finance #finance #年次');
    const staleDocument = await message('SAVE_QUICK_NOTE', {
        recordId: result.record.id, noteToken: savedMessage.noteToken, note: 'overwrite',
        documentToken: '22222222-2222-4222-8222-222222222222',
    });
    assert.equal(staleDocument.ok, false);
    const editor = await message('OPEN_NOTE_EDITOR', {
        recordId: result.record.id, noteToken: savedMessage.noteToken,
    });
    assert.equal(editor.ok, true);
    assert.equal(popupCount, 2);

    events.menu.emit({ menuItemId: 'breadcrumb-smart-download', linkUrl: context.href,
        pageUrl: context.pageUrl }, { id: 7, title: 'Example' });
    await flush();
    assert.equal(requests.length, 2);
    assert.equal(local.data.vault_records.length, 4);

    session.data.click_contexts.forEach((entry) => { entry.timestamp -= 121_000; });
    events.created.emit({ id: 3, url: 'https://unrelated.example/file' });
    await flush();
    assert.equal(local.data.vault_records.at(-1).pageTitle, '');
    assert.equal(session.data.click_contexts.length, 0);

    await message('CAPTURED_CLICK_CONTEXT', { context });
    events.created.emit({ id: 4, url: 'https://redirect.example/other' });
    await flush();
    assert.equal(local.data.vault_records.at(-1).pageTitle, '');

    items.set(5, { id: 5, url: context.href });
    events.changed.emit({ id: 5, filename: { current: '/home/user/early.pdf' } });
    events.created.emit(items.get(5));
    await flush();
    assert.equal(local.data.vault_records.filter((record) => record.downloadId === 5).length, 1);
    assert.equal(local.data.vault_records.at(-1).filename, 'early.pdf');

    const beforeCrossTab = sent.length;
    events.created.emit({ id: 6, tabId: 8, url: context.href });
    await flush();
    assert.equal(local.data.vault_records.at(-1).pageTitle, '');
    assert.equal(sent.length, beforeCrossTab);

    const secretUrl = 'https://user:password@example.com/file?token=private-token&item=42#secret-fragment';
    events.created.emit({ id: 7, url: secretUrl, referrer: secretUrl });
    await flush();
    const privateMetadata = local.data.vault_records.at(-1);
    assert.equal(new URL(privateMetadata.url).searchParams.get('token'), '[redacted]');
    assert.equal(new URL(privateMetadata.url).searchParams.get('item'), '42');
    assert.ok(!JSON.stringify(privateMetadata).includes('password'));
    assert.ok(!JSON.stringify(privateMetadata).includes('private-token'));
    assert.ok(!JSON.stringify(privateMetadata).includes('secret-fragment'));

    const firstTabPrompt = sent.at(-1).message;
    const secondTab = await message('TRIGGER_SMART_DOWNLOAD', { context }, 8);
    const secondTabId = secondTab.record.id;
    const firstTabNote = await message('SAVE_QUICK_NOTE', {
        recordId: firstTabPrompt.record.id, noteToken: firstTabPrompt.noteToken, note: 'Only first tab',
    });
    assert.equal(firstTabNote.ok, true);
    assert.equal(local.data.vault_records.find((record) => record.id === secondTabId).userNote, '');

    for (let id = 1000; id < 1501; id++) events.created.emit({ id, url: 'https://example.com/file' });
    await flush();
    assert.equal(local.data.vault_records.length, 500);
    assert.equal(local.data.vault_records[0].downloadId, 1001);
    assert.equal(local.data.vault_records.at(-1).downloadId, 1500);

    events.created.emit({ id: 2000, url: 'https://example.com/private', incognito: true });
    events.created.emit({ id: 2001, url: 'blob:moz-extension://test/export' });
    items.set(2000, { id: 2000, incognito: true, url: 'https://example.com/private' });
    items.set(2001, { id: 2001, url: 'blob:moz-extension://test/export' });
    events.changed.emit({ id: 2000, filename: { current: '/private.pdf' } });
    events.changed.emit({ id: 2001, filename: { current: '/export.json' } });
    await flush();
    assert.equal(local.data.vault_records.at(-1).downloadId, 1500);
    assert.equal(local.data.vault_records.length, 500);

    const requestCount = requests.length;
    const unsafe = await message('TRIGGER_SMART_DOWNLOAD', { context: { ...context, href: 'javascript:alert(1)' } });
    assert.equal(unsafe.ok, false);
    assert.equal(requests.length, requestCount);
    const untrusted = events.messages.listeners[0]({ type: 'TRIGGER_SMART_DOWNLOAD', context },
        { id: 'other-extension', tab: { id: 7 } });
    assert.equal(untrusted, undefined);
    const privateMessage = events.messages.listeners[0]({ type: 'CAPTURED_CLICK_CONTEXT', context },
        { id: 'test', tab: { id: 7, incognito: true } });
    assert.equal(privateMessage, undefined);

    await events.messages.listeners[0]({ type: 'CAPTURED_CLICK_CONTEXT', documentToken, context: {
        ...context, pageUrl: 'https://spoofed.example/' },
    }, { id: 'test', url: 'https://real.example/', tab: { id: 7 } });
    assert.equal(session.data.click_contexts.at(-1).context.pageUrl, 'https://real.example/');
});

test('filename and snippet helpers are defensive', () => {
    assert.equal(buildSmartFilename({ pageUrl: 'https://gist.github.com/x', linkText: 'Download',
        headingText: 'Release notes', originalPath: 'https://cdn.example/archive.final.zip?x=1' }),
    'github_Release_notes_archive.final.zip');
    assert.equal(buildSmartFilename({ originalPath: 'CON' }), 'local_CON');
    const long = buildSmartFilename({ linkText: 'x'.repeat(500), originalPath: 'report.pdf' });
    assert.ok(long.length < 120);
    assert.ok(long.endsWith('.pdf'));
    const bidi = buildSmartFilename({ originalPath: 'photo\u202egnp.exe' });
    assert.ok(!/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(bidi));
    assert.ok(bidi.endsWith('.exe'));
    for (const label of ['界'.repeat(200), '😀'.repeat(200), 'a'.repeat(200)]) {
        const filename = buildSmartFilename({ linkText: label, originalPath: 'report.pdf' });
        assert.ok(filename.length < 120);
        assert.ok(new TextEncoder().encode(filename).length <= 240);
        assert.ok(filename.endsWith('.pdf'));
        assert.ok(!/[\ud800-\udfff]/u.test(filename));
    }
    const emojiExtension = buildSmartFilename({ originalPath: `report.${'a'.repeat(15)}😀` });
    assert.ok(!/[\ud800-\udfff]/u.test(emojiExtension));
    const traversal = buildSmartFilename({ originalPath: '..%2f..%5cCON.exe' });
    assert.ok(!/[\\/<>:"|?*]/.test(traversal));
    assert.equal(cleanSnippet('  One\n two   three ', 8), 'One two');
    assert.equal(cleanSnippet(null), '');
});
