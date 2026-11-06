import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../src/popup/popup.js', import.meta.url), 'utf8');

function helpers() {
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
        browser: { storage: { onChanged: { addListener() {} } } },
    });
    const code = source.replace(/^import[^\n]+\n/, '').replace(/search\.focus\(\);\s*initialize\(\)\.catch[^\n]+;\s*$/, '');
    vm.runInContext(`${code}\nglobalThis.api = { markdown, displayFilename, highlightedSnippet, sourceUrl };`, context);
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
