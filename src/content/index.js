(() => {
    'use strict';

    if (globalThis.__breadcrumbDL) return;
    globalThis.__breadcrumbDL = true;

    const documentToken = crypto.randomUUID();
    const HOST_ID = 'breadcrumbdl-toast';
    const CONTEXT_TEXT_LIMIT = 2000;
    const LABEL_LIMIT = 200;
    const REMEMBER_THROTTLE_MS = 400;
    const SCAN_LIMIT = 300;
    const SCAN_END = Symbol('scan-end');
    const EXCLUDED = 'script, style, template, noscript, form, input, textarea, select, option, [hidden], [inert], [aria-hidden="true"], [contenteditable]:not([contenteditable="false"])';
    const normalize = (value, max) => String(value ?? '').slice(0, max).replace(/\s+/g, ' ').trim();
    const displayFilename = (value) => normalize(value, 240).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
        (character) => `\\u${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);

    let active = null;
    let lastClickAt = -Infinity;
    let lastContextMenuAt = -Infinity;
    let dismissTimer = 0;

    function excluded(element) {
        if (element.matches(EXCLUDED) || element.id === HOST_ID) return true;
        const style = getComputedStyle(element);
        return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
    }

    function unsafeContext(element) {
        for (let node = element, depth = 0; node && depth < 40; depth++) {
            if (excluded(node)) return true;
            const parent = node.parentElement ?? node.getRootNode()?.host;
            if (!parent) return false;
            node = parent;
        }
        return true;
    }

    function walk(root, visit, reject = () => false) {
        if (!root || (root.nodeType === 1 && excluded(root))) return;
        let scanned = 0;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (++scanned > SCAN_LIMIT) throw SCAN_END;
                return node.nodeType === 1 && (excluded(node) || reject(node))
                    ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
            },
        });
        try {
            if (visit(root) === false) return;
            for (let node; (node = walker.nextNode());) {
                if (visit(node) === false) break;
            }
        } catch (error) {
            if (error !== SCAN_END) throw error;
        }
    }

    function readText(root, max, range = null) {
        let result = '';
        walk(root, (node) => {
            if (node.nodeType !== 3 || (range && !range.intersectsNode(node))) return;
            const start = range?.startContainer === node ? range.startOffset : 0;
            const end = range?.endContainer === node ? range.endOffset : node.length;
            result += node.data.slice(start, Math.min(end, start + max - result.length)) + ' ';
            return result.length < max;
        });
        return normalize(result, max);
    }

    function findContainer(start) {
        for (let node = start, depth = 0; node && depth < 8; node = node.parentElement, depth++) {
            if (node === document.body || node === document.documentElement) break;
            if (node.matches('tr, li, dd, figure, div, section, article')) return node;
        }
        return start;
    }

    function nearestHeading(element) {
        const scope = element.closest('section, article');
        let heading = '';
        if (scope) {
            walk(scope, (node) => {
                if (node === element) return false;
                if (node.nodeType === 1 && node.matches('h1, h2, h3, h4, h5, h6')
                    && !node.contains(element)) heading = readText(node, LABEL_LIMIT) || heading;
            }, (node) => node.matches('section, article'));
        }
        return heading || normalize(document.title, LABEL_LIMIT);
    }

    function containerText(element) {
        const row = element.closest('tr');
        if (!row?.cells) return readText(findContainer(element), CONTEXT_TEXT_LIMIT);
        const table = row.closest('table');
        const header = table?.tHead?.rows?.[0] ?? table?.rows?.[0];
        const labels = [];
        if (header && header !== row) {
            for (let index = 0; index < Math.min(header.cells.length, 20) && labels.length < 20; index++) {
                const cell = header.cells[index];
                const label = cell.matches('th') ? readText(cell, 80) : '';
                const span = Math.min(20 - labels.length, Math.max(1, cell.colSpan || 1));
                for (let count = 0; count < span; count++) labels.push(label);
            }
        }
        let result = '';
        let column = 0;
        for (let index = 0; index < Math.min(row.cells.length, 20) && result.length < CONTEXT_TEXT_LIMIT; index++) {
            const cell = row.cells[index];
            const value = readText(cell, CONTEXT_TEXT_LIMIT - result.length);
            if (value) result += `${result ? ' | ' : ''}${labels[column] ? `${labels[column]}: ` : ''}${value}`;
            column += Math.min(20, Math.max(1, cell.colSpan || 1));
        }
        return normalize(result, CONTEXT_TEXT_LIMIT);
    }

    function selectedText() {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || !selection.rangeCount) return '';
        const range = selection.getRangeAt(0);
        const root = range.commonAncestorContainer;
        const element = root.nodeType === 1 ? root : root.parentElement;
        if (!element || unsafeContext(element)) return '';
        return readText(root, CONTEXT_TEXT_LIMIT, range);
    }

    function extractClickContext(element) {
        return {
            href: element.matches('a[href]') ? element.href : null,
            linkText: readText(element, LABEL_LIMIT)
                || normalize(element.getAttribute('aria-label') || element.getAttribute('title'), LABEL_LIMIT),
            nearestHeading: nearestHeading(element),
            containerText: containerText(element),
            selectedText: selectedText(),
            pageTitle: normalize(document.title, LABEL_LIMIT),
            pageUrl: location.href,
            clickedAt: Date.now(),
        };
    }

    function actionableFor(event, selector) {
        const path = event.composedPath();
        if (path.some((node) => node.nodeType === 1 && node.id === HOST_ID)) return null;
        const target = path.find((node) => node.nodeType === 1);
        if (!target || unsafeContext(target)) return null;
        return path.find((node) => node.nodeType === 1 && node.matches(selector)) ?? null;
    }

    const TOAST_CSS = `
        :host { all: initial; position: fixed; right: 20px; bottom: 20px;
            z-index: 2147483647; font: 13px/1.45 system-ui, sans-serif; color: #f8fafc; }
        .panel { width: 340px; padding: 14px 16px; border-radius: 12px;
            background: #0f172a; border: 1px solid #38bdf8; box-shadow: 0 14px 36px #0f172a80; }
        .brand { color: #38bdf8; font-size: 11px; font-weight: 600; }
        .name { margin-top: 10px; font-weight: 600; overflow-wrap: anywhere; }
        .actions { display: flex; gap: 8px; margin-top: 12px; }
        button { padding: 7px 12px; font: inherit; border: 1px solid #334155;
            border-radius: 8px; cursor: pointer; background: #1e293b; color: #f8fafc; }
        .primary { background: #38bdf8; color: #0f172a; font-weight: 600; }
        button:disabled { opacity: 0.5; cursor: default; }
        .hint { margin-top: 10px; color: #94a3b8; font-size: 11px; }
    `;

    function make(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function createUi() {
        const host = document.createElement('div');
        host.id = HOST_ID;
        const root = host.attachShadow({ mode: 'closed' });
        const style = make('style', '', TOAST_CSS);
        const panel = make('div', 'panel');
        const name = make('div', 'name', 'Preparing download…');
        const actions = make('div', 'actions');
        const primary = make('button', 'primary', 'Download');
        const ghost = make('button', '', 'Cancel');
        primary.type = ghost.type = 'button';
        const hint = make('div', 'hint', 'Alt+N download and edit note in popup · Esc cancel');
        actions.append(primary, ghost);
        panel.append(make('div', 'brand', 'BreadcrumbDL'), name, actions, hint);
        root.append(style, panel);
        return { host, name, primary, ghost, hint };
    }

    function closeToast() {
        clearTimeout(dismissTimer);
        active?.ui.host.remove();
        active = null;
    }

    async function openNoteEditor(state) {
        if (active !== state || state.busy || !state.record || !state.noteToken) return;
        state.busy = true;
        state.ui.primary.disabled = true;
        try {
            const result = await browser.runtime.sendMessage({
                type: 'OPEN_NOTE_EDITOR', recordId: state.record.id, noteToken: state.noteToken, documentToken,
            });
            if (result?.error || result?.ok === false) throw new Error('Note editor unavailable');
            if (active === state) closeToast();
        } catch {
            if (active === state) {
                state.busy = false;
                state.ui.primary.disabled = false;
                state.ui.hint.textContent = 'Open the extension popup to edit your note.';
            }
        }
    }

    function showStatus(record, noteToken) {
        if (typeof record?.id !== 'string' || typeof record.filename !== 'string') return null;
        if (active?.record?.id === record.id) {
            active.ui.name.textContent = displayFilename(record.filename);
            if (typeof noteToken === 'string') active.noteToken = noteToken;
            active.ui.primary.disabled = !active.noteToken;
            return active;
        }
        closeToast();
        const ui = createUi();
        const state = {
            ui, record: { id: record.id }, noteToken: typeof noteToken === 'string' ? noteToken : '', busy: false,
        };
        active = state;
        ui.name.textContent = displayFilename(record.filename) || 'Download started';
        ui.primary.textContent = 'Edit Note';
        ui.primary.disabled = !state.noteToken;
        ui.ghost.textContent = 'Close';
        ui.hint.textContent = 'Alt+N edit note in popup · Esc close';
        ui.primary.addEventListener('click', (event) => {
            if (!event.isTrusted) return;
            void openNoteEditor(state);
        });
        ui.ghost.addEventListener('click', (event) => {
            if (!event.isTrusted) return;
            closeToast();
        });
        (document.body ?? document.documentElement).append(ui.host);
        dismissTimer = setTimeout(() => { if (active === state) closeToast(); }, 8000);
        return state;
    }

    async function confirmDownload(state, editNote = false) {
        if (active !== state || state.busy) return;
        state.busy = true;
        state.ui.primary.disabled = true;
        try {
            const result = await browser.runtime.sendMessage({ type: 'TRIGGER_SMART_DOWNLOAD', context: state.context, documentToken });
            if (result?.error || !result?.record) throw new Error('Download unavailable');
            // DOWNLOAD_SAVED can arrive before the request's response.
            if (active !== state && active?.record?.id !== result.record.id) return;
            const saved = showStatus({ id: result.record.id, filename: result.filename || result.record.filename }, result.noteToken);
            if (editNote && saved) await openNoteEditor(saved);
        } catch {
            if (active === state) {
                state.busy = false;
                state.ui.primary.disabled = false;
                state.ui.hint.textContent = 'Download failed. Try again or use the extension popup.';
            }
        }
    }

    function openToast(context) {
        closeToast();
        const ui = createUi();
        const state = { ui, context, busy: false };
        active = state;
        ui.primary.addEventListener('click', (event) => {
            if (!event.isTrusted) return;
            void confirmDownload(state);
        });
        ui.ghost.addEventListener('click', (event) => {
            if (!event.isTrusted) return;
            closeToast();
        });
        (document.body ?? document.documentElement).append(ui.host);
        browser.runtime.sendMessage({ type: 'preview', context, documentToken }).then((response) => {
            if (active === state && typeof response?.filename === 'string') {
                ui.name.textContent = displayFilename(response.filename);
            }
        }).catch(() => {});
    }

    window.addEventListener('keydown', (event) => {
        if (!event.isTrusted || !active || event.repeat || event.isComposing) return;
        const noteKeys = event.altKey && !event.ctrlKey && !event.metaKey
            && (event.code === 'KeyN' || event.key?.toLowerCase() === 'n');
        if (!noteKeys && event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') closeToast();
        else if (active.record) void openNoteEditor(active);
        else void confirmDownload(active, true);
    }, true);

    browser.runtime.onMessage.addListener((message, sender) => {
        if (sender?.id !== browser.runtime.id) return undefined;
        if (message?.type === 'QUICK_NOTE_REQUEST') {
            if (!active) return Promise.resolve({ handled: false });
            if (active.record) void openNoteEditor(active);
            else void confirmDownload(active, true);
            return Promise.resolve({ handled: true });
        }
        if (message?.type !== 'DOWNLOAD_SAVED' || message.documentToken !== documentToken) return undefined;
        showStatus(message.record, message.noteToken);
        return undefined;
    });

    function remember(context) {
        try {
            browser.runtime.sendMessage({ type: 'CAPTURED_CLICK_CONTEXT', context, documentToken }).catch(() => {});
        } catch {
            // The extension may have been reloaded while this document remained open.
        }
    }

    document.addEventListener('click', (event) => {
        if (!event.isTrusted || event.button !== 0) return;
        const now = Date.now();
        if (now - lastClickAt < REMEMBER_THROTTLE_MS) return;
        const actionable = actionableFor(event, 'a[href], button');
        if (!actionable) return;
        lastClickAt = now;
        if (event.altKey && event.shiftKey) {
            if (!actionable.matches('a[href]') || !/^(https?|ftp):/i.test(actionable.href)) return;
            event.preventDefault();
            event.stopPropagation();
            openToast(extractClickContext(actionable));
        } else {
            remember(extractClickContext(actionable));
        }
    }, true);

    document.addEventListener('contextmenu', (event) => {
        if (!event.isTrusted) return;
        const now = Date.now();
        if (now - lastContextMenuAt < REMEMBER_THROTTLE_MS) return;
        const anchor = actionableFor(event, 'a[href]');
        if (!anchor) return;
        lastContextMenuAt = now;
        remember(extractClickContext(anchor));
    }, true);
})();
