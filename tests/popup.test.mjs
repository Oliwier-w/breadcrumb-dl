import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../src/popup/popup.js', import.meta.url), 'utf8');

function helpers(downloads) {
    const elements = new Map();
    const make = (tag) => ({ tag, children: [], value: '', dataset: {},
        addEventListener() {}, focus() {},
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; },
    });
    const document = {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, make('div'));
            return elements.get(id);
        },
        createElement: make,
        createTextNode: (text) => ({ tag: '#text', text }),
        addEventListener() {},
    };
    const context = vm.createContext({ document, URL, Date, console,
        browser: { storage: { onChanged: { addListener() {} } }, downloads },
    });
    const code = source.replace(/^import[^\n]+\n/, '').replace(/search\.focus\(\);\s*initialize\(\)\.catch[^\n]+;\s*$/, '');
    vm.runInContext(`${code}\nglobalThis.api = { markdown, displayFilename, highlightedSnippet, sourceUrl, waitForExport };`, context);
    return context.api;
}

test('Markdown treats hostile multiline fields as literal text', () => {
    const api = helpers();
    const value = 'Normal text\n\nFORGED SECTION\n==============\n<script>alert(1)</script>\n```\n# injected';
    const markdown = api.markdown([null, 42, { filename: 'bad\n# heading\u202e.exe',
        userNote: value, selectedText: value, containerText: value, timestamp: 0 }]);
    assert.equal((markdown.match(/^## /gm) || []).length, 1);
    assert.ok(!/^FORGED SECTION|^==============|^<script>|^```|^# injected/m.test(markdown));
    assert.ok(markdown.includes('    FORGED SECTION\n    =============='));
    assert.ok(markdown.includes('    <script>alert(1)</script>'));
    assert.ok(!markdown.includes('\u202e'));
    assert.ok(markdown.includes('\\u202E'));
});

test('export waits for its own terminal state and removes the listener', async () => {
    const listeners = new Set();
    const downloads = {
        onChanged: {
            addListener(listener) { listeners.add(listener); },
            removeListener(listener) { listeners.delete(listener); },
        },
        async search({ id }) { return [{ id, state: id === 3 ? 'complete' : 'in_progress' }]; },
    };
    const { waitForExport } = helpers(downloads);
    const pending = waitForExport(2);
    const [listener] = listeners;
    listener({ id: 1, state: { current: 'complete' } });
    listener({ id: 2, state: { current: 'interrupted' } });
    assert.equal(await pending, 'interrupted');
    assert.equal(listeners.size, 0);
    assert.equal(await waitForExport(3), 'complete');
    assert.equal(listeners.size, 0);
});

test('popup blocks executable source URLs and escapes bidi filename controls', () => {
    const api = helpers();
    for (const url of ['javascript:alert(1)', 'data:text/html,test', 'moz-extension://other/']) {
        assert.equal(api.sourceUrl(url), null);
    }
    assert.equal(api.sourceUrl('https://example.com/path').hostname, 'example.com');
    assert.equal(api.displayFilename('photo\u202egnp.exe'), 'photo\\u202Egnp.exe');
});

test('query tokens are literal and highlights contain only text nodes', () => {
    const api = helpers();
    const paragraph = api.highlightedSnippet('Safe [brackets] <img src=x> text.', ['[brackets]', '<img']);
    const marks = paragraph.children.filter((child) => child.tag === 'mark');
    assert.equal(marks.length, 2);
    assert.deepEqual(marks.map((mark) => mark.children.map((child) => child.text).join('')),
        ['[brackets]', '<img']);
    assert.ok(marks.every((mark) => mark.children.every((child) => child.tag === '#text')));
});
