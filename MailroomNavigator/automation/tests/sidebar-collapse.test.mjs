import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Exercise the injected helper without requiring Chrome or a live service.
const source = readFileSync(new URL('../../background.js', import.meta.url), 'utf8');
const start = source.indexOf('            const SIDEBAR_HIDDEN_KEY =');
const end = source.indexOf('            const collapseAllPanels =', start);
assert.ok(start >= 0 && end > start);

function harness(enabled, storageFails = false) {
    const classes = new Set();
    const stored = new Map();
    const attrs = {};
    const button = { setAttribute: (key, value) => { attrs[key] = value; } };
    const dock = {
        classList: { toggle: (name, on) => on ? classes.add(name) : classes.delete(name) },
        querySelector: () => button,
    };
    const setHidden = new Function('document', 'DOCK_ID', 'fullSidebarCollapse', 'railIcon', 'window',
        source.slice(start, end) + '\nreturn setSidebarHidden;')(
        { getElementById: () => dock }, 'dock', enabled, name => name,
        { sessionStorage: { setItem: (key, value) => {
            if (storageFails) throw new Error('Storage unavailable');
            stored.set(key, value);
        } } },
    );
    return { setHidden, classes, stored, button, attrs };
}

test('enabled flag collapses and expands with accessible labels and saved state', () => {
    const h = harness(true);
    h.setHidden(true);
    assert.ok(h.classes.has('bl-sidebar-hidden'));
    assert.equal(h.attrs['aria-expanded'], 'false');
    assert.equal(h.attrs['aria-label'], 'Expand sidebar');
    assert.equal(h.button.innerHTML, 'expand');
    assert.equal(h.stored.get('__BL_SIDEBAR_HIDDEN_V1__'), 'true');
    h.setHidden(false);
    assert.equal(h.classes.size, 0);
    assert.equal(h.attrs['aria-expanded'], 'true');
    assert.equal(h.button.innerHTML, 'close');
    assert.equal(h.stored.get('__BL_SIDEBAR_HIDDEN_V1__'), 'false');
});

test('disabled flag cannot hide the sidebar or overwrite saved preferences', () => {
    const h = harness(false);
    h.setHidden(true);
    assert.equal(h.classes.size, 0);
    assert.equal(h.stored.size, 0);
    assert.equal(h.attrs['aria-expanded'], undefined);
});

test('restoring saved hidden state does not write storage again', () => {
    const h = harness(true);
    h.setHidden(true, { persist: false });
    assert.ok(h.classes.has('bl-sidebar-hidden'));
    assert.equal(h.stored.size, 0);
});

test('blocked session storage does not prevent collapse or expansion', () => {
    const h = harness(true, true);
    assert.doesNotThrow(() => h.setHidden(true));
    assert.ok(h.classes.has('bl-sidebar-hidden'));
    assert.doesNotThrow(() => h.setHidden(false));
    assert.equal(h.classes.size, 0);
});
