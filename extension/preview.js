import { fetchTopic } from './feeds.js';
import { getCredentials } from './session.js';
import { renderTopicContent } from './topic-content.js';

const dialog = document.getElementById('topic-preview');
const scroller = document.getElementById('preview-scroll');
const close = document.getElementById('preview-close');
const title = document.getElementById('preview-title');
const meta = document.getElementById('preview-meta');
const status = document.getElementById('preview-status');
const retry = document.getElementById('preview-retry');
const content = document.getElementById('preview-content');
const original = document.getElementById('preview-open-original');
const publishedAt = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
let active;

function showHeading(topic) {
  const date = new Date(topic.created * 1000);
  const when = topic.created && Number.isFinite(date.getTime()) ? publishedAt.format(date) : '';
  title.textContent = topic.title;
  meta.textContent = [topic.nodeTitle, topic.author, when, topic.replies + ' 条回复'].filter(Boolean).join(' · ');
}

function showStatus(message, canRetry = false) {
  status.textContent = message;
  status.hidden = !message;
  retry.hidden = !canRetry;
}

async function loadTopic() {
  const preview = active;
  preview.controller?.abort();
  const controller = new AbortController();
  preview.controller = controller;
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]);
  const isCurrent = () => dialog.open && active === preview && !controller.signal.aborted;
  showStatus('正在读取正文…');
  content.replaceChildren();
  content.setAttribute('aria-busy', 'true');

  try {
    const { token } = await getCredentials();
    if (!isCurrent()) return;
    const detail = await fetchTopic({ id: preview.topic.id, token, signal });
    if (!isCurrent()) return;
    showHeading(detail);
    content.replaceChildren(renderTopicContent(detail));
    showStatus('');
  } catch (error) {
    if (!isCurrent()) return;
    const message = error.name === 'TimeoutError'
      ? '读取正文超时，请重试。'
      : error.message || '暂时无法读取正文。';
    showStatus(message, error.status !== 404 && error.status !== 401 && error.status !== 403);
  } finally {
    if (isCurrent()) content.removeAttribute('aria-busy');
  }
}

export function openTopicPreview(topic, trigger) {
  if (dialog.open) return;
  active?.controller?.abort();
  active = { topic, trigger };
  original.href = 'https://www.v2ex.com/t/' + topic.id;
  showHeading(topic);
  dialog.showModal();
  scroller.scrollTop = 0;
  void loadTopic();
}

close.addEventListener('click', () => dialog.close());
retry.addEventListener('click', () => {
  close.focus({ preventScroll: true });
  void loadTopic();
});
dialog.addEventListener('close', () => {
  if (dialog.open) return;
  active?.controller?.abort();
  const trigger = active?.trigger;
  active = null;
  content.replaceChildren();
  content.removeAttribute('aria-busy');
  if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  else document.getElementById('scroll-area').focus({ preventScroll: true });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.credentials && dialog.open) dialog.close();
});
window.addEventListener('pagehide', () => active?.controller?.abort(), { once: true });
