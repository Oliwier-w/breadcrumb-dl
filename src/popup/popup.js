import { buildSmartFilename, cleanSnippet } from '../shared/sanitize.js';

const VAULT_KEY = 'vault_records';
const SEARCH_FIELDS = ['filename', 'userNote', 'containerText', 'nearestHeading', 'selectedText', 'pageUrl'];
const search = document.getElementById('search');
const list = document.getElementById('vault');
const empty = document.getElementById('empty');
const count = document.getElementById('count');
const status = document.getElementById('status');
const exportButton = document.getElementById('export');
const exportFormat = document.getElementById('export-format');
let records = [];
let indexed = [];
const drafts = new Map();

const text = (value) => typeof value === 'string' ? value : '';
const tags = (record) => Array.isArray(record.tags) ? record.tags.filter((tag) => typeof tag === 'string') : [];
const isRecord = (record) => record !== null && typeof record === 'object' && !Array.isArray(record);
const vaultRecords = (value) => Array.isArray(value) ? value.filter(isRecord) : [];
const recordDate = (value) => new Date(typeof value === 'number' || typeof value === 'string' ? value : NaN);
const displayFilename = (value) => text(value).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);

function node(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = value;
    return element;
}

function button(label, action) {
    const element = node('button', '', label);
    element.type = 'button';
    element.addEventListener('click', async () => {
        element.disabled = true;
        try { await action(); }
        catch (error) { status.textContent = error.message || 'Action failed. Please try again.'; }
        finally { element.disabled = false; }
    });
    return element;
}

function sourceUrl(value) {
    try {
        const url = new URL(text(value));
        return ['http:', 'https:', 'ftp:', 'file:'].includes(url.protocol) ? url : null;
    } catch { return null; }
}

function relativeTime(timestamp) {
    const date = recordDate(timestamp);
    const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
    if (!Number.isFinite(seconds)) return 'Unknown time';
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 2_592_000) return `${Math.floor(seconds / 86400)}d ago`;
    return date.toLocaleDateString();
}

function queryTokens() {
    return [...new Set(search.value.toLowerCase().trim().split(/\s+/).filter(Boolean))];
}

function highlightedSnippet(value, tokens) {
    const paragraph = node('p', 'snippet');
    if (!tokens.length) {
        paragraph.textContent = value;
        return paragraph;
    }
    const pattern = new RegExp(tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .sort((a, b) => b.length - a.length).join('|'), 'giu');
    let offset = 0;
    for (const match of value.matchAll(pattern)) {
        paragraph.append(document.createTextNode(value.slice(offset, match.index)));
        const mark = document.createElement('mark');
        mark.append(document.createTextNode(match[0]));
        paragraph.append(mark);
        offset = match.index + match[0].length;
    }
    paragraph.append(document.createTextNode(value.slice(offset)));
    return paragraph;
}

async function saveNote(id, value) {
    await navigator.locks.request('breadcrumb-storage', async () => {
        const stored = await browser.storage.local.get(VAULT_KEY);
        const vault = Array.isArray(stored[VAULT_KEY]) ? stored[VAULT_KEY] : [];
        const record = vault.find((entry) => isRecord(entry) && typeof id === 'string' && id && entry.id === id);
        if (!record) throw new Error('This record is no longer in the vault.');
        record.userNote = value.trim();
        record.tags = [...new Set(Array.from(record.userNote.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu),
            (match) => match[1].toLowerCase()))];
        await browser.storage.local.set({ [VAULT_KEY]: vault });
    });
}

function editor(record, item, editButton) {
    const form = node('form', 'editor');
    const label = node('label', '', 'Note and #tags');
    const input = node('textarea');
    input.id = `note-${record.id}`;
    input.maxLength = 8000;
    input.value = drafts.get(record.id) ?? text(record.userNote);
    drafts.set(record.id, input.value);
    label.htmlFor = input.id;
    input.addEventListener('input', () => drafts.set(record.id, input.value));
    const actions = node('div', 'editor-actions');
    const cancel = button('Cancel', () => {
        drafts.delete(record.id);
        form.remove();
        editButton.focus();
    });
    const save = node('button', 'save', 'Save note');
    save.type = 'submit';
    actions.append(save, cancel, node('span', '', 'Ctrl/⌘+Enter save'));
    form.append(label, input, actions);
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (save.disabled) return;
        save.disabled = true;
        const value = input.value;
        try {
            await saveNote(record.id, value);
            if (drafts.get(record.id) === value) drafts.delete(record.id);
            await load();
            status.textContent = drafts.has(record.id) ? 'Note saved. Newer edits are still unsaved.' : 'Note saved.';
            const card = Array.from(list.children).find((element) => element.dataset.id === record.id);
            (card?.querySelector('textarea') ?? card ?? search).focus();
        } catch (error) {
            status.textContent = error.message;
            save.disabled = false;
        }
    });
    input.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            form.requestSubmit();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            cancel.click();
        }
    });
    item.append(form);
    return input;
}

function renderCard(record, tokens) {
    const item = node('li', 'card');
    item.tabIndex = 0;
    item.dataset.id = text(record.id);
    item.append(node('h2', 'filename', displayFilename(record.filename) || 'Untitled download'));

    const actions = node('div', 'actions');
    const show = button('Show in Folder', async () => {
        await browser.downloads.show(record.downloadId);
        status.textContent = 'Opened containing folder.';
    });
    show.disabled = !Number.isInteger(record.downloadId) || record.downloadId < 0;
    const url = sourceUrl(record.pageUrl);
    const open = button('Open Source URL', async () => { await browser.tabs.create({ url: url.href }); });
    open.disabled = !url;
    const edit = button('Edit Note', () => {
        const input = item.querySelector('textarea') ?? editor(record, item, edit);
        input.focus();
    });
    edit.dataset.action = 'edit-note';
    edit.disabled = !text(record.id);
    const copy = button('Copy Smart Name', async () => {
        const filename = buildSmartFilename({
            pageUrl: text(record.pageUrl), headingText: text(record.nearestHeading),
            linkText: text(record.linkText), originalPath: text(record.filename) || text(record.url),
        });
        await navigator.clipboard.writeText(filename);
        status.textContent = 'Smart name copied.';
    });
    actions.append(show, open, edit, copy);
    item.append(actions);

    const metadata = node('div', 'metadata');
    metadata.append(node('span', 'domain', url?.hostname || (url?.protocol === 'file:' ? 'local' : 'unknown source')));
    const time = node('time', '', relativeTime(record.timestamp));
    const date = recordDate(record.timestamp);
    if (Number.isFinite(date.getTime())) {
        time.dateTime = date.toISOString();
        time.title = date.toLocaleString();
    }
    metadata.append(time);
    item.append(metadata);
    const context = text(record.containerText) || text(record.selectedText) || text(record.nearestHeading);
    item.append(highlightedSnippet(cleanSnippet(context, 480) || context.slice(0, 480) || 'No context captured.', tokens));
    if (record.userNote) item.append(node('p', 'note', text(record.userNote)));
    if (tags(record).length) item.append(node('p', 'tags', tags(record).map((tag) => `#${tag}`).join(' ')));
    if (drafts.has(record.id)) editor(record, item, edit);
    return item;
}

function render() {
    const tokens = queryTokens();
    const matches = indexed.filter((entry) => tokens.every((token) => entry.searchText.includes(token)));
    const fragment = document.createDocumentFragment();
    for (const { record } of matches) fragment.append(renderCard(record, tokens));
    list.replaceChildren(fragment);
    empty.hidden = matches.length > 0;
    empty.textContent = records.length ? 'No matching downloads. Try fewer words.'
        : 'No downloads yet. Alt+Shift+Click a link to start your trail.';
    count.textContent = `${matches.length} / ${records.length} records`;
    exportButton.disabled = !records.length;
}

async function load() {
    const stored = await browser.storage.local.get(VAULT_KEY);
    records = vaultRecords(stored[VAULT_KEY]);
    indexed = records.map((record) => ({ record,
        searchText: [...SEARCH_FIELDS.map((field) => text(record[field])),
            ...tags(record).map((tag) => `#${tag}`)].join(' ').toLowerCase(),
    })).sort((a, b) => (recordDate(b.record.timestamp).getTime() || 0)
        - (recordDate(a.record.timestamp).getTime() || 0));
    render();
}

function markdown(vault) {
    const heading = (value) => displayFilename(value).replace(/\s+/gu, ' ').trim()
        .replace(/[\\`*_{}\[\]<>()#+=.!|~&-]/g, '\\$&');
    const literal = (value) => text(value).replace(/\r\n?|\u2028|\u2029/g, '\n')
        .split('\n').map((line) => `    ${line}`).join('\n');
    return '# BreadcrumbDL provenance\n\n' + vaultRecords(vault).map((record) => {
        const date = recordDate(record.timestamp);
        const fields = [
            ['ID', record.id], ['Download ID', Number.isInteger(record.downloadId) ? String(record.downloadId) : ''],
            ['Downloaded', Number.isFinite(date.getTime()) ? date.toISOString() : ''],
            ['URL', record.url], ['Referrer', record.referrer], ['Source', record.pageUrl],
            ['Page title', record.pageTitle], ['Heading', record.nearestHeading],
            ['Link text', record.linkText], ['Context', record.containerText],
            ['Selected text', record.selectedText], ['Note', record.userNote],
            ['Tags', tags(record).map((tag) => `#${tag}`).join(' ')],
        ];
        return `## ${heading(record.filename) || 'Untitled download'}\n\n` + fields
            .map(([label, value]) => `**${label}:**\n\n${literal(value)}`).join('\n\n');
    }).join('\n\n---\n\n') + '\n';
}

exportButton.addEventListener('click', async () => {
    exportButton.disabled = true;
    let url;
    try {
        if (!window.confirm('Export all records? All captured context, notes, and URLs will be included and may contain sensitive data. Only share this file with people you trust.')) {
            status.textContent = 'Export cancelled.';
            return;
        }
        const stored = await browser.storage.local.get(VAULT_KEY);
        const vault = vaultRecords(stored[VAULT_KEY]);
        const format = exportFormat.value === 'md' ? 'md' : 'json';
        const content = format === 'md' ? markdown(vault) : `${JSON.stringify(vault, null, 2)}\n`;
        url = URL.createObjectURL(new Blob([content], {
            type: format === 'md' ? 'text/markdown;charset=utf-8' : 'application/json',
        }));
        await browser.downloads.download({
            url, filename: `breadcrumbdl-${new Date().toISOString().slice(0, 10)}.${format}`, saveAs: true,
        });
        status.textContent = `Exported ${vault.length} records as ${format.toUpperCase()}.`;
    } catch (error) { status.textContent = `Export failed: ${error.message}`; }
    finally {
        if (url) URL.revokeObjectURL(url);
        exportButton.disabled = !records.length;
    }
});

search.addEventListener('input', render);
document.addEventListener('keydown', (event) => {
    const typing = event.target.matches('input, textarea, select');
    if ((event.key === '/' && !typing) || ((event.ctrlKey || event.metaKey) && event.key === 'k')) {
        event.preventDefault();
        search.focus();
        search.select();
    } else if (event.key === 'Escape' && search.value && !event.target.matches('textarea')) {
        event.preventDefault();
        search.value = '';
        render();
        search.focus();
    } else if (['ArrowDown', 'ArrowUp'].includes(event.key)
        && (event.target === search || event.target.classList.contains('card'))) {
        const cards = Array.from(list.children);
        const index = cards.indexOf(event.target);
        const next = event.key === 'ArrowDown' ? cards[index + 1]
            : index > 0 ? cards[index - 1] : search;
        if (next) { event.preventDefault(); next.focus(); }
    }
});

browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[VAULT_KEY]) {
        const input = document.activeElement;
        const id = input.closest('.card')?.dataset.id;
        const editing = input.matches('textarea');
        const position = editing ? [input.selectionStart, input.selectionEnd] : null;
        load().then(() => {
            if (!editing) return;
            const card = Array.from(list.children).find((element) => element.dataset.id === id);
            const replacement = card?.querySelector('textarea');
            if (replacement) { replacement.focus(); replacement.setSelectionRange(...position); }
        }).catch((error) => { status.textContent = error.message; });
    }
});

async function initialize() {
    await load();
    const stored = await browser.storage.session.get('popup_note_record');
    const pending = stored.popup_note_record;
    if (pending !== undefined) await browser.storage.session.remove('popup_note_record');
    if (!isRecord(pending) || !text(pending.recordId)) return;
    search.value = '';
    render();
    const card = Array.from(list.children).find((element) => element.dataset.id === pending.recordId);
    card?.querySelector('[data-action="edit-note"]')?.click();
}

search.focus();
initialize().catch((error) => { status.textContent = `Could not open vault: ${error.message}`; });
