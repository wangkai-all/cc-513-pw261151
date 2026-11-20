/**
 * Executes public/app.js against a tiny hand-rolled DOM so that rendering
 * logic is actually exercised (not just string-matched). This is deliberately
 * minimal: it supports the element/attribute APIs app.js uses and nothing
 * else, so an accidental switch to a richer browser API fails here rather
 * than silently passing.
 *
 * It also drives the real server, so the test covers the full
 * fetch -> render -> budget/history refresh loop for the main outcome paths.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startServer } from './helpers.js';

const root = resolve(import.meta.dirname, '..');

// ---------------------------------------------------------------- mini DOM

class ClassList {
  constructor() {
    this.set = new Set();
  }
  add(name) {
    this.set.add(name);
  }
  remove(name) {
    this.set.delete(name);
  }
  contains(name) {
    return this.set.has(name);
  }
  toggle(name, force) {
    if (force === undefined) return this.set.has(name) ? this.remove(name) : this.add(name);
    return force ? this.add(name) : this.remove(name);
  }
  toString() {
    return [...this.set].join(' ');
  }
}

class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this._text = '';
    this.className = '';
    this.classList = new ClassList();
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.id = '';
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler({ target: this, preventDefault() {}, ...event });
    }
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof Node || node instanceof Text) this.children.push(node);
      else this.children.push(new Text(String(node)));
    }
  }
  appendChild(node) {
    this.append(node);
    return node;
  }
  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children
      .map((child) => (child instanceof Text ? child.textContent : child.textContent ?? ''))
      .join('');
  }
  set innerHTML(value) {
    throw new Error('innerHTML is forbidden in app.js');
  }
  *walk() {
    yield this;
    for (const child of this.children) {
      if (child instanceof Node) yield* child.walk();
    }
  }
  find(predicate) {
    for (const node of this.walk()) if (node !== this && predicate(node)) return node;
    return null;
  }
  querySelectorAll(selector) {
    if (!selector.startsWith('.')) throw new Error(`unsupported selector ${selector}`);
    const cls = selector.slice(1);
    return [...this.walk()].filter((node) => node !== this && node.classList.contains(cls));
  }
}

class Text {
  constructor(value) {
    this._text = String(value);
  }
  get textContent() {
    return this._text;
  }
}

/** Build a DOM tree from index.html for the ids/classes app.js touches. */
async function buildDom() {
  const rootNode = new Node('html');

  const document = {
    root: rootNode,
    adminButtons: [],
    createElement(tag) {
      return new Node(tag);
    },
    createTextNode(text) {
      return new Text(text);
    },
    byId(id) {
      for (const node of rootNode.walk()) if (node.id === id) return node;
      return null;
    },
    querySelector(selector) {
      if (selector === '[data-admin]') return this.adminButtons[0] ?? null;
      if (selector.includes(' ')) {
        const [parentSel, childTag] = selector.split(/\s+/);
        const parent = this.querySelector(parentSel);
        return parent ? parent.find((node) => node.tagName === childTag.toUpperCase()) : null;
      }
      if (selector.startsWith('#')) return this.byId(selector.slice(1));
      if (selector.startsWith('.')) {
        for (const node of rootNode.walk()) {
          if (node.classList?.contains(selector.slice(1))) return node;
        }
        return null;
      }
      throw new Error(`unsupported selector ${selector}`);
    },
    querySelectorAll(selector) {
      if (selector === '[data-admin]') return this.adminButtons;
      if (selector.startsWith('#')) {
        const node = this.byId(selector.slice(1));
        return node ? [node] : [];
      }
      if (selector.startsWith('.')) {
        return [...rootNode.walk()].filter((node) => node.classList?.contains(selector.slice(1)));
      }
      throw new Error(`unsupported selector ${selector}`);
    },
  };

  const html = await readFile(resolve(root, 'public/index.html'), 'utf8');
  const seen = new Set();
  for (const match of html.matchAll(/<([a-z0-9]+)\b[^>]*\bid="([^"]+)"/gi)) {
    const id = match[2];
    if (seen.has(id)) continue;
    seen.add(id);
    const node = new Node(match[1]);
    node.id = id;
    rootNode.append(node);
  }
  // Admin action buttons carry data-admin rather than ids.
  for (const match of html.matchAll(/data-admin="([^"]+)"/g)) {
    const button = new Node('button');
    button.dataset.admin = match[1];
    document.adminButtons.push(button);
    rootNode.append(button);
  }
  // Give every <table> a <tbody>, so `#table tbody` selectors resolve the way
  // they would in a browser (which inserts tbody implicitly).
  for (const node of [...rootNode.walk()]) {
    if (node.tagName === 'TABLE' && !node.find((child) => child.tagName === 'TBODY')) {
      node.append(new Node('tbody'));
    }
  }
  document.body = rootNode;
  return { document, Node, Text };
}

// ------------------------------------------------------------------- test

test('browser-ish: app.js boots, runs a query, and renders released + denied', async (t) => {
  const app = await startServer();
  t.after(() => app.close());

  const { document: doc, Node: DomNode } = await buildDom();
  const document = doc;

  const nativeFetch = globalThis.fetch;
  const fetchImpl = (path, init) => nativeFetch(app.base + path, init);
  const localStorage = {
    store: new Map(),
    getItem(key) {
      return this.store.get(key) ?? null;
    },
    setItem(key, value) {
      this.store.set(key, String(value));
    },
  };

  const source = await readFile(resolve(root, 'public/app.js'), 'utf8');
  const moduleUrl = `data:text/javascript,${encodeURIComponent(source)}`;
  // Patch globals before evaluating the module.
  globalThis.document = document;
  globalThis.fetch = fetchImpl;
  globalThis.localStorage = localStorage;
  globalThis.Node = DomNode;
  globalThis.setTimeout = setTimeout;
  globalThis.clearTimeout = clearTimeout;
  process.on('unhandledRejection', (reason) => {
    console.error('[ui-runtime] unhandled rejection:', reason);
  });

  // app.js calls boot() at import time; give microtasks a chance to settle.
  await import(moduleUrl);
  await new Promise((resolve) => setTimeout(resolve, 400));

  // The caller select should have been populated with the four seeded callers.
  const callerSelect = document.querySelector('#caller-select');
  assert.ok(callerSelect.children.length >= 4);

  // Submit the form as the HR analyst with an innocuous filter.
  callerSelect.value = 'analyst-hr';
  callerSelect.dispatch('change');
  await new Promise((resolve) => setTimeout(resolve, 200));
  document.querySelector('#metric').value = 'count';
  document.querySelector('#groupBy').value = 'none';
  document.querySelector('#groupBy').dispatch('change');
  // Filter selects are populated from /api/meta during boot.
  document.querySelector('#filter-region').value = '华东';
  document.querySelector('#query-form').dispatch('submit');
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(document.querySelector('#status-pill').textContent.includes('已发布'), true);
  const resultsBody = document.querySelector('#results-body');
  assert.ok(resultsBody.children.length >= 1, 'one result row rendered');

  // Run a query that the policy refuses; the UI must show the refusal reason.
  document.querySelector('#filter-region').value = '海外';
  document.querySelector('#filter-dept').value = '法务';
  document.querySelector('#filter-ageBand').value = '50+';
  document.querySelector('#query-form').dispatch('submit');
  await new Promise((resolve) => setTimeout(resolve, 300));

  const privacyTitle = document.querySelector('#privacy-title').textContent;
  assert.equal(privacyTitle, '结果未返回');
  const message = document.querySelector('#privacy-message').textContent;
  assert.match(message, /最小群体阈值/);
  assert.equal(document.querySelector('#data-block').hidden, true);

  // The budget panel should reflect a charge from the one released query.
  const stats = document.querySelector('#budget-stats').textContent;
  assert.match(stats, /已消耗/);

  delete globalThis.document;
  delete globalThis.fetch;
  delete globalThis.localStorage;
  delete globalThis.Node;
});
