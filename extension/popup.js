import { fetchFeed } from './feeds.js';
import { openTopicPreview } from './preview.js';
import { getCredentials, invalidateFeed } from './session.js';

const el = id => document.getElementById(id);
const tabs = [...document.querySelectorAll('[role="tab"]')];
const nav = document.querySelector('.feed-nav');
const list = el('topics');
const scrollArea = el('scroll-area');
const view = { kind: 'latest', node: '', page: 1 };
let nodeChoice = { kind: 'category', node: 'jobs' };
let customNode = 'programmer';
const freshFor = 90_000;
const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
const calendar = new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' });
let pending;
let shown;
let readingId;
let incoming;
let scrollFrame;
let latestHead;


function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function icon(id) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.classList.add('icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', '#' + id);
  svg.append(use);
  return svg;
}

function topicTime(timestamp) {
  const date = new Date(timestamp * 1000);
  const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000));
  let label;
  if (minutes < 1) label = '刚刚';
  else if (minutes < 60) label = minutes + ' 分钟前';
  else if (minutes < 1440) label = Math.floor(minutes / 60) + ' 小时前';
  else if (minutes < 10080) label = Math.floor(minutes / 1440) + ' 天前';
  else label = calendar.format(date);
  const time = make('time', '', label);
  time.dateTime = date.toISOString();
  time.title = '发布于 ' + date.toLocaleString('zh-CN');
  return time;
}

function topicRow(topic) {
  const row = make('li', 'topic');
  row.dataset.topicId = String(topic.id);
  const head = make('div', 'topic-head');
  const link = make('a', 'topic-link', topic.title);
  link.href = 'https://www.v2ex.com/t/' + topic.id;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  const replies = make('span', 'replies');
  replies.title = topic.replies + ' 条回复';
  replies.setAttribute('aria-label', replies.title);
  replies.append(icon('i-reply'), String(topic.replies));
  head.append(link, replies);

  const meta = make('div', 'meta');
  if (topic.node) {
    const node = make('button', 'node-pill', topic.nodeTitle);
    node.type = 'button';
    node.dataset.node = topic.node;
    node.title = '查看节点 /go/' + topic.node;
    meta.append(node);
  }
  if (topic.author) meta.append(make('span', 'author', topic.author));
  if (topic.created) meta.append(topicTime(topic.created));
  const preview = make('button', 'topic-preview', '预览');
  preview.type = 'button';
  preview.setAttribute('aria-label', '预览：' + topic.title);
  preview.addEventListener('click', () => openTopicPreview(topic, preview));
  meta.append(preview);
  row.append(head, meta);
  return row;
}

function showState(title, message, retry = false, settings = false) {
  list.replaceChildren();
  el('state-title').textContent = title;
  el('state-message').textContent = message;
  el('retry').hidden = !retry;
  el('fix-token').hidden = !settings;
  el('state').hidden = false;
}

function drawFeed(entry) {
  if (!entry.topics.length) {
    showState('暂无主题', view.page > 1 ? '可以返回上一页继续浏览。' : '稍后刷新，或切换到其他列表。');
    return;
  }
  el('state').hidden = true;
  list.replaceChildren(...entry.topics.map(topicRow));
}

function showSkeleton() {
  el('state').hidden = true;
  const rows = Array.from({ length: 6 }, () => {
    const row = make('li', 'skeleton');
    row.setAttribute('aria-hidden', 'true');
    return row;
  });
  list.replaceChildren(...rows);
}

function footer(entry, busy, error = false) {
  el('refresh').disabled = busy;
  el('refresh').classList.toggle('is-loading', busy);
  el('feed').setAttribute('aria-busy', String(busy));
  el('status-dot').dataset.tone = error ? 'warn' : (busy ? '' : 'ok');
  let status = entry ? '更新于 ' + clock.format(entry.at) : '加载失败';
  if (busy) status = entry ? '正在刷新…' : '正在读取主题…';
  if (error && entry) status = '上次更新于 ' + clock.format(entry.at);
  el('status-text').textContent = status;
  el('count').textContent = entry ? entry.topics.length + ' 条主题' : '';
  el('pagination').hidden = !(entry?.hasMore || view.page > 1);
  el('previous').disabled = busy || view.page <= 1;
  el('next').disabled = busy || !entry?.hasMore;
  el('page-number').textContent = '第 ' + view.page + ' 页';
}

function categoryList() {
  return view.kind === 'category' || view.kind === 'node';
}

function cacheKey() {
  return view.kind === 'category' ? 'feed-category-' + view.node : 'feed-' + view.kind;
}

function incomingKey() {
  if (view.kind === 'latest') return 'incoming-latest';
  if (view.kind === 'category' && ['jobs', 'deals'].includes(view.node)) return 'incoming-' + view.node;
  return null;
}

function feedScope(auth) {
  return view.kind === 'latest' || view.kind === 'node' ? auth.scope : 'public';
}

function matches(entry, scope, page = view.page) {
  return entry && entry.scope === scope && entry.slug === view.node && entry.page === page;
}

function syncControls() {
  const selected = categoryList() ? 'node' : view.kind;
  for (const tab of tabs) {
    const active = tab.dataset.kind === selected;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  el('feed').setAttribute('aria-labelledby', 'tab-' + selected);
  el('category-choices').hidden = !categoryList();
  el('node-form').hidden = view.kind !== 'node';
  if (!categoryList()) return;
  nodeChoice = { kind: view.kind, node: view.node };
  if (view.kind === 'node') customNode = view.node;
  el('node-input').value = customNode;
  for (const button of el('category-choices').querySelectorAll('button')) {
    const active = button.dataset.category ? view.kind === 'category' && button.dataset.category === view.node
      : view.kind === 'node';
    button.setAttribute('aria-pressed', String(active));
  }
}

function listSignature(topics) {
  return JSON.stringify(topics.map(({ id, replies, title }) => [id, replies, title]));
}

function showUpdateButton() {
  const button = el('apply-update');
  button.hidden = true;
  if (!shown || !matches(incoming, shown.scope, 1) || incoming.at <= shown.at) return;
  const lastSeen = view.page === 1 ? listSignature(shown.topics) :
    (latestHead?.scope === shown.scope ? latestHead.signature : null);
  button.textContent = view.page === 1 ? '查看更新' : '查看首页更新';
  button.hidden = !lastSeen || lastSeen === listSignature(incoming.topics);
}

function position() {
  const top = scrollArea.getBoundingClientRect().top;
  const anchor = [...list.children].find(row => row.getBoundingClientRect().bottom > top);
  return {
    id: readingId, scrollTop: scrollArea.scrollTop,
    topicId: anchor?.dataset.topicId, offset: anchor ? anchor.getBoundingClientRect().top - top : 0
  };
}

function rememberPosition() {
  if (!readingId) return;
  void chrome.storage.session.set({ readerPosition: position() }).catch(() => {});
}

function restorePosition(saved) {
  if (!saved) { scrollArea.scrollTop = 0; return; }
  const anchor = [...list.children].find(row => row.dataset.topicId === saved.topicId);
  if (anchor) {
    scrollArea.scrollTop += anchor.getBoundingClientRect().top - scrollArea.getBoundingClientRect().top - saved.offset;
  } else {
    scrollArea.scrollTop = saved.scrollTop;
  }
}

function present(entry, savedPosition, existingId) {
  shown = entry;
  readingId = existingId || crypto.randomUUID();
  if (view.kind === 'latest' && view.page === 1) {
    latestHead = { scope: entry.scope, signature: listSignature(entry.topics) };
  }
  drawFeed(entry);
  restorePosition(savedPosition);
  footer(entry, false);
  showUpdateButton();
  if (existingId) return;
  // The reading copy stays intact when the worker stages a newer first page.
  const reading = { id: readingId, view: { ...view }, entry };
  if (view.kind === 'latest' && view.page > 1 && latestHead?.scope === entry.scope) {
    reading.latestHead = latestHead;
  }
  void chrome.storage.session.set({ reading, readerPosition: position(), [cacheKey()]: entry }).catch(() => {});
}

async function load({ force = false, keepScroll = false } = {}) {
  pending?.abort();
  const controller = new AbortController();
  pending = controller;
  const { signal } = controller;
  let entry = keepScroll ? shown : null;
  const savedPosition = entry ? position() : null;
  let scope;
  if (!entry) {
    readingId = null;
    shown = null;
    scrollArea.scrollTop = 0;
    showSkeleton();
  }
  incoming = null;
  el('notice').hidden = true;
  showUpdateButton();
  footer(entry, true);
  let timeout;
  try {
    const key = cacheKey();
    const stagedKey = incomingKey();
    const [auth, snapshot] = await Promise.all([
      getCredentials(), chrome.storage.session.get(stagedKey ? [key, stagedKey] : key)
    ]);
    if (signal.aborted) return;
    scope = feedScope(auth);
    incoming = snapshot[stagedKey];
    let cached = snapshot[key];
    if (!matches(cached, scope)) cached = null;
    const useStaged = matches(incoming, scope) && (!cached || incoming.at >= cached.at);
    if (useStaged) cached = incoming;
    if (cached && !entry) {
      entry = cached;
      present(entry);
    }
    if (!force && cached && Date.now() - cached.at < (useStaged ? 3 * 60 * 60_000 : freshFor)) return;
    footer(entry, true);
    timeout = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), 12_000);
    const result = await fetchFeed({ ...view, token: auth.token, signal });
    if (pending !== controller || signal.aborted) return;
    entry = { ...result, at: Date.now(), scope, slug: view.node, page: view.page };
    present(entry, savedPosition);
  } catch (error) {
    if (pending !== controller || error.name === 'AbortError') return;
    const message = error.name === 'TimeoutError' ? '连接 V2EX 超时，请稍后重试。' : error.message;
    if (error.status === 401 || error.status === 403) {
      entry = shown = readingId = null;
      await invalidateFeed(view.kind, scope, view.node);
      if (pending !== controller) return;
    }
    if (entry) {
      el('notice').textContent = '显示上次读取的列表。' + message;
      el('notice').hidden = false;
    } else {
      showState('暂时无法加载主题', message, true, error.status === 401);
    }
    footer(entry, false, true);
    showUpdateButton();
  } finally {
    clearTimeout(timeout);
  }
}

function choose(kind, node = '') {
  if (view.kind === kind && view.node === node) return;
  Object.assign(view, { kind, node, page: 1 });
  syncControls();
  void load();
}

function chooseTab(kind) {
  if (kind === 'node') choose(nodeChoice.kind, nodeChoice.node);
  else choose(kind);
}

nav.addEventListener('click', event => {
  const tab = event.target.closest('[role="tab"]');
  if (tab) chooseTab(tab.dataset.kind);
});
nav.addEventListener('keydown', event => {
  const index = tabs.indexOf(event.target);
  if (index < 0) return;
  const destinations = { ArrowLeft: (index + 2) % 3, ArrowRight: (index + 1) % 3, Home: 0, End: 2 };
  const target = tabs[destinations[event.key]];
  if (!target) return;
  event.preventDefault();
  target.focus();
  chooseTab(target.dataset.kind);
});
el('category-choices').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.category) choose('category', button.dataset.category);
  else {
    choose('node', customNode);
    el('node-input').focus();
  }
});
list.addEventListener('click', event => {
  const node = event.target.closest('button[data-node]');
  if (node) {
    choose('node', node.dataset.node);
    el('node-input').focus();
  }
});
el('node-form').addEventListener('submit', event => {
  event.preventDefault();
  const slug = el('node-input').value.trim().toLowerCase();
  if (slug === view.node) {
    view.page = 1;
    void load({ force: true });
  } else {
    choose('node', slug);
  }
});
el('previous').addEventListener('click', () => { view.page--; void load(); });
el('next').addEventListener('click', () => { view.page++; void load(); });
el('refresh').addEventListener('click', () => void load({ force: true, keepScroll: true }));
el('retry').addEventListener('click', () => void load({ force: true }));
el('apply-update').addEventListener('click', () => {
  if (!incoming || el('apply-update').hidden) return;
  pending?.abort();
  view.page = 1;
  el('notice').hidden = true;
  present(incoming);
});
for (const id of ['settings-open', 'fix-token']) {
  el(id).addEventListener('click', () => {
    rememberPosition();
    void chrome.runtime.openOptionsPage();
  });
}

scrollArea.addEventListener('scroll', () => {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; rememberPosition(); });
}, { passive: true });
// Persist before a native target=_blank link dismisses the toolbar popup.
for (const type of ['pointerdown', 'click', 'auxclick']) {
  document.addEventListener(type, event => {
    if (event.target.closest('a')) rememberPosition();
  }, true);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) rememberPosition();
});
window.addEventListener('pagehide', () => { rememberPosition(); pending?.abort(); }, { once: true });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  if (changes.credentials) latestHead = null;
  if ((changes.credentials && ['latest', 'node'].includes(view.kind)) ||
      (readingId && changes.reading?.oldValue?.id === readingId && changes.reading.newValue === null)) {
    view.page = 1;
    void load();
    return;
  }
  const next = changes[incomingKey()];
  if (next) { incoming = next.newValue; showUpdateButton(); }
});

async function openReader() {
  try {
    const saved = await chrome.storage.session.get(['credentials', 'reading', 'readerPosition',
      'incoming-latest', 'incoming-jobs', 'incoming-deals']);
    if (pending) return;
    const reading = saved.reading;
    if (reading && ['latest', 'hot', 'category', 'node'].includes(reading.view.kind)) {
      Object.assign(view, reading.view);
      if (matches(reading.entry, feedScope(saved.credentials || { scope: 'public' }))) {
        syncControls();
        incoming = saved[incomingKey()];
        latestHead = reading.latestHead;
        const pos = saved.readerPosition?.id === reading.id ? saved.readerPosition : null;
        present(reading.entry, pos, reading.id);
        if (pos) {
          // Chrome can finish sizing a toolbar popup after its first layout.
          requestAnimationFrame(() => {
            if (readingId === reading.id) restorePosition(pos);
          });
        }
        return;
      }
      view.page = 1;
    }
  } catch { /* Without a usable reading snapshot, open the requested list normally. */ }
  syncControls();
  void load();
}
void openReader();
