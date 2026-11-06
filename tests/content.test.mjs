import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/content/index.js', import.meta.url), 'utf8');

function harness() {
    const messages = [];
    const receivers = [];
    const roots = [];
    let clock = 1000;
    let scans = 0;
    const listeners = () => ({ handlers: {}, addEventListener(type, handler) {
        (this.handlers[type] ??= []).push(handler);
    } });
    function element(tag, attributes = {}) {
        const node = Object.assign(listeners(), {
            nodeType: 1, localName: tag, attributes, children: [], parentElement: null,
            textContent: '', disabled: false,
            append(...children) {
                for (const child of children) {
                    if (child.parentElement) {
                        child.parentElement.children = child.parentElement.children.filter((entry) => entry !== child);
                    }
                    child.parentElement = this;
                    this.children.push(child);
                }
            },
            remove() {
                if (this.parentElement) {
                    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
                    this.parentElement = null;
                }
            },
            getAttribute(name) { return this.attributes[name] ?? null; },
            getRootNode() { return this.parentElement?.getRootNode() ?? document; },
            matches(selector) {
                return selector.split(',').some((part) => {
                    part = part.trim();
                    if (part === '[contenteditable]:not([contenteditable="false"])') {
                        return 'contenteditable' in this.attributes && this.attributes.contenteditable !== 'false';
                    }
                    const match = /^(\w+)?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/.exec(part);
                    if (!match) return false;
                    return (!match[1] || this.localName === match[1])
                        && (!match[2] || (match[2] in this.attributes
                            && (match[3] === undefined || this.attributes[match[2]] === match[3])));
                });
            },
            closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; },
            contains(other) { return other === this || this.children.some((child) => child.nodeType === 1 && child.contains(other)); },
            attachShadow(options) {
                const root = element('shadow-root');
                root.host = this;
                root.mode = options.mode;
                this.shadowRoot = options.mode === 'open' ? root : null;
                roots.push(root);
                return root;
            },
        });
        if (tag === 'a') node.href = attributes.href;
        return node;
    }
    const document = Object.assign(listeners(), {
        title: 'Page title', createElement: element,
        createTreeWalker(root, mask, filter) {
            scans++;
            const stack = [...root.children ?? []].reverse();
            return { nextNode() {
                while (stack.length) {
                    const node = stack.pop();
                    if (filter.acceptNode(node) === 2) continue;
                    stack.push(...[...node.children ?? []].reverse());
                    return node;
                }
                return null;
            } };
        },
    });
    document.documentElement = element('html');
    document.body = element('body');
    document.documentElement.append(document.body);
    const window = Object.assign(listeners(), { getSelection: () => null });
    const browser = { runtime: {
        id: 'extension-id', onMessage: { addListener(handler) { receivers.push(handler); } },
        async sendMessage(message) {
            messages.push(message);
            if (message.type === 'preview') return { filename: 'safe.pdf' };
            if (message.type === 'TRIGGER_SMART_DOWNLOAD') {
                return { record: { id: 'record-1', filename: 'safe.pdf' }, filename: 'safe.pdf', noteToken: 'grant-1' };
            }
            return { ok: true };
        },
    } };
    vm.runInNewContext(source, {
        document, window, browser, location: { href: 'https://example.com/page' },
        crypto: { randomUUID: () => 'document-1' },
        Date: { now: () => clock }, NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 },
        getComputedStyle: (node) => ({ display: node.attributes.display ?? 'block', visibility: 'visible' }),
        setTimeout: () => 1, clearTimeout() {},
    });
    function emit(target, type, values = {}) {
        const event = {
            isTrusted: true, button: 0, preventDefault() {}, stopPropagation() {},
            composedPath: () => [], ...values,
        };
        for (const handler of target.handlers[type] ?? []) handler(event);
    }
    function text(parent, value) {
        const node = { nodeType: 3, data: value, length: value.length };
        parent.append(node);
        return node;
    }
    const link = element('a', { href: 'https://example.com/file.pdf' });
    text(link, 'Download');
    document.body.append(link);
    const click = (values = {}) => emit(document, 'click', { composedPath: () => [link, document.body], ...values });
    const descendants = (root) => [root, ...root.children.flatMap(descendants)];
    return {
        document, window, messages, roots, receivers, element, text, link, emit, click, descendants,
        tick: () => { clock += 500; }, scans: () => scans,
        buttons: () => descendants(roots.at(-1)).filter((node) => node.localName === 'button'),
        flush: async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); },
    };
}

test('synthetic page events are rejected before DOM inspection or messaging', () => {
    const h = harness();
    const composedPath = () => { throw new Error('must not inspect synthetic events'); };
    h.click({ isTrusted: false, altKey: true, shiftKey: true, composedPath });
    h.emit(h.document, 'contextmenu', { isTrusted: false, composedPath });
    h.emit(h.window, 'keydown', { isTrusted: false, altKey: true, key: 'n' });
    assert.equal(h.messages.length, 0);
    assert.equal(h.scans(), 0);
    assert.equal(h.roots.length, 0);
});

test('closed confirmation toast rejects synthetic buttons and keyboard, and opens popup after download', async () => {
    const h = harness();
    h.click({ altKey: true, shiftKey: true });
    await h.flush();
    assert.equal(h.roots[0].mode, 'closed');
    assert.equal(h.roots[0].host.localName, 'div');
    assert.equal(h.document.body.children.at(-1).shadowRoot, null);
    assert.equal(h.descendants(h.roots[0]).some((node) => ['input', 'textarea'].includes(node.localName)), false);
    const [download, cancel] = h.buttons();
    h.emit(download, 'click', { isTrusted: false });
    h.emit(cancel, 'click', { isTrusted: false });
    h.emit(h.window, 'keydown', { isTrusted: false, altKey: true, key: 'n' });
    h.emit(h.window, 'keydown', { isTrusted: false, key: 'Escape' });
    assert.deepEqual(h.messages.map((message) => message.type), ['preview']);
    h.emit(h.window, 'keydown', { altKey: true, key: 'n' });
    await h.flush();
    assert.deepEqual(h.messages.map((message) => message.type), ['preview', 'TRIGGER_SMART_DOWNLOAD', 'OPEN_NOTE_EDITOR']);
    assert.ok(h.messages.every((message) => message.documentToken === 'document-1'));
    assert.equal(h.messages[2].recordId, 'record-1');
    assert.equal(h.messages[2].noteToken, 'grant-1');
    assert.ok(h.messages.every((message) => !('note' in message)));
});

test('download notifications require sender and document identity and never render private fields', async () => {
    const h = harness();
    const message = {
        type: 'DOWNLOAD_SAVED', documentToken: 'document-1', noteToken: 'grant-1',
        record: { id: 'record-1', filename: 'safe.pdf', userNote: 'SECRET NOTE', pageTitle: 'SECRET TITLE' },
    };
    h.receivers[0](message, { id: 'other-extension' });
    h.receivers[0]({ ...message, documentToken: 'old-document' }, { id: 'extension-id' });
    h.receivers[0]({ ...message, type: 'OPEN_QUICK_NOTE' }, { id: 'extension-id' });
    assert.equal(h.roots.length, 0);
    h.receivers[0](message, { id: 'extension-id' });
    const rendered = h.descendants(h.roots[0]).map((node) => node.textContent).join(' ');
    assert.ok(!rendered.includes('SECRET'));
    assert.equal(h.buttons()[0].textContent, 'Edit Note');
    h.emit(h.buttons()[0], 'click', { isTrusted: false });
    assert.equal(h.messages.length, 0);
    h.emit(h.buttons()[0], 'click');
    await h.flush();
    assert.equal(h.messages[0].type, 'OPEN_NOTE_EDITOR');
});

test('browser quick-note command routes pending downloads to the popup without page note fields', async () => {
    const h = harness();
    assert.equal((await h.receivers[0]({ type: 'QUICK_NOTE_REQUEST' }, { id: 'extension-id' })).handled, false);
    h.click({ altKey: true, shiftKey: true });
    assert.equal(h.receivers[0]({ type: 'QUICK_NOTE_REQUEST' }, { id: 'other-extension' }), undefined);
    const response = await h.receivers[0]({ type: 'QUICK_NOTE_REQUEST' }, { id: 'extension-id' });
    assert.equal(response.handled, true);
    await h.flush();
    assert.deepEqual(h.messages.map((message) => message.type), ['preview', 'TRIGGER_SMART_DOWNLOAD', 'OPEN_NOTE_EDITOR']);
});

test('trusted Download and Edit Note buttons retain the grant and Escape dismisses confirmation', async () => {
    const h = harness();
    h.click({ altKey: true, shiftKey: true });
    h.emit(h.buttons()[0], 'click');
    h.emit(h.buttons()[0], 'click');
    await h.flush();
    assert.equal(h.messages.filter((message) => message.type === 'TRIGGER_SMART_DOWNLOAD').length, 1);
    assert.equal(h.buttons()[0].textContent, 'Edit Note');
    h.emit(h.buttons()[0], 'click');
    await h.flush();
    assert.equal(h.messages.at(-1).noteToken, 'grant-1');
    h.tick();
    h.click({ altKey: true, shiftKey: true });
    h.emit(h.window, 'keydown', { key: 'Escape' });
    assert.equal(h.document.body.children.some((node) => node.id === 'breadcrumbdl-toast'), false);
});

test('stored filenames display bidi controls visibly, including subsequent updates', () => {
    const h = harness();
    const notify = (filename) => h.receivers[0]({
        type: 'DOWNLOAD_SAVED', documentToken: 'document-1', noteToken: 'grant-1',
        record: { id: 'record-1', filename },
    }, { id: 'extension-id' });
    notify('report\u202Efdp.exe');
    const name = () => h.descendants(h.roots.at(-1)).find((node) => node.className === 'name').textContent;
    assert.equal(name(), 'report\\u202Efdp.exe');
    notify('x\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069.pdf');
    assert.equal(name(), 'x\\u061C\\u200E\\u200F\\u202A\\u202B\\u202C\\u202D\\u202E\\u2066\\u2067\\u2068\\u2069.pdf');
});

test('context capture stays local, skips sensitive subtrees and throttles before extraction', () => {
    const h = harness();
    h.text(h.document.body, 'UNRELATED BODY SECRET');
    h.click();
    assert.equal(h.messages[0].context.containerText, 'Download');
    const scans = h.scans();
    h.click({ composedPath: () => { throw new Error('throttled event must not be inspected'); } });
    assert.equal(h.scans(), scans);
    h.tick();
    const container = h.element('div');
    h.document.body.append(container);
    container.append(h.link);
    for (const [tag, attributes] of [
        ['script', {}], ['style', {}], ['template', {}], ['noscript', {}], ['form', {}],
        ['div', { hidden: '' }], ['div', { 'aria-hidden': 'true' }], ['div', { contenteditable: '' }],
        ['div', { display: 'none' }],
    ]) {
        const hidden = h.element(tag, attributes);
        h.text(hidden, 'SECRET');
        container.append(hidden);
    }
    h.text(container, 'Public context');
    h.click();
    assert.equal(h.messages.at(-1).context.containerText, 'Download Public context');
    const form = h.element('form');
    h.document.body.append(form);
    form.append(h.link);
    h.tick();
    const count = h.messages.length;
    h.click();
    assert.equal(h.messages.length, count);
});

test('right-click and shadow-path provenance work while own toast paths are excluded', () => {
    const h = harness();
    const host = h.element('custom-component');
    h.document.body.append(host);
    h.emit(h.document, 'contextmenu', { composedPath: () => [h.link, host, h.document.body] });
    assert.equal(h.messages[0].type, 'CAPTURED_CLICK_CONTEXT');
    h.emit(h.document, 'contextmenu', { composedPath: () => { throw new Error('contextmenu throttle'); } });
    const toast = h.element('div');
    toast.id = 'breadcrumbdl-toast';
    h.click({ composedPath: () => [h.link, toast, h.document.body] });
    assert.equal(h.messages.length, 1);
});

test('table provenance includes bounded visible header labels and row values', () => {
    const h = harness();
    const table = h.element('table');
    const header = h.element('tr');
    const row = h.element('tr');
    const th = h.element('th');
    const td = h.element('td');
    h.text(th, 'Document');
    td.append(h.link);
    header.append(th);
    row.append(td);
    header.cells = [th];
    row.cells = [td];
    table.rows = [header, row];
    table.append(header, row);
    h.document.body.append(table);
    h.click();
    assert.equal(h.messages[0].context.containerText, 'Document: Download');
});

test('text, selection and heading scans are bounded and headings stay in the same section', () => {
    const h = harness();
    const section = h.element('section');
    h.document.body.append(section);
    const heading = h.element('h2');
    h.text(heading, 'Local heading');
    section.append(heading, h.link);
    const unrelated = h.element('section');
    const unrelatedHeading = h.element('h2');
    h.text(unrelatedHeading, 'Unrelated heading');
    unrelated.append(unrelatedHeading);
    h.document.body.append(unrelated);
    const selected = h.text(section, 'x'.repeat(10000));
    h.window.getSelection = () => ({
        isCollapsed: false, rangeCount: 1,
        getRangeAt: () => ({ commonAncestorContainer: selected, startContainer: selected,
            startOffset: 0, endContainer: selected, endOffset: 10000, intersectsNode: () => true }),
    });
    h.click();
    assert.equal(h.messages[0].context.nearestHeading, 'Local heading');
    assert.equal(h.messages[0].context.selectedText.length, 2000);
    assert.ok(h.messages[0].context.containerText.length <= 2000);
    h.tick();
    const container = h.element('div');
    h.document.body.append(container);
    container.append(h.link);
    for (let i = 0; i < 400; i++) container.append(h.element('span'));
    h.text(container, 'BEYOND SCAN BUDGET');
    h.window.getSelection = () => null;
    h.click();
    assert.equal(h.messages.at(-1).context.containerText, 'Download');
    assert.equal(h.messages.at(-1).context.nearestHeading, 'Page title');
});
