const ELEMENTS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'sub', 'sup', 'kbd',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'code',
  'figure', 'figcaption', 'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td'
]);
const DISCARD = new Set([
  'script', 'style', 'noscript', 'template', 'link', 'base', 'meta',
  'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'input', 'button',
  'select', 'textarea', 'video', 'audio', 'source', 'track', 'canvas', 'title'
]);
const IMAGE_ORIGINS = new Set(['https://i.v2ex.co', 'https://cdn.v2ex.com']);

function webUrl(value) {
  const raw = value?.trim();
  if (!raw || /[\u0000-\u001f\u007f\\]/.test(raw) || !/^(?:https?:\/\/|\/)/i.test(raw)) return null;
  try {
    const url = new URL(raw, 'https://www.v2ex.com');
    return !url.username && !url.password && ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function makeLink(url) {
  const a = document.createElement('a');
  a.href = url.href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function appendImage(source, parent) {
  const url = webUrl(source.getAttribute('src'));
  const alt = source.getAttribute('alt') || '';
  if (!url) {
    if (alt) parent.append(alt);
    return;
  }
  if (IMAGE_ORIGINS.has(url.origin)) {
    const img = document.createElement('img');
    img.alt = alt || '主题图片';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.src = url.href;
    parent.append(img);
    return;
  }
  const link = makeLink(url);
  link.className = 'topic-image-link';
  link.textContent = '查看图片';
  if (alt) link.setAttribute('aria-label', '查看图片：' + alt);
  parent.append(link);
}

function appendChildren(source, parent) {
  for (const child of source.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      parent.append(child.data);
      continue;
    }
    if (child.namespaceURI !== 'http://www.w3.org/1999/xhtml' || DISCARD.has(child.localName)) continue;
    const tag = child.localName;
    if (tag === 'img') {
      appendImage(child, parent);
    } else if (tag === 'a') {
      const children = document.createDocumentFragment();
      appendChildren(child, children);
      const url = webUrl(child.getAttribute('href'));
      // Linked third-party thumbnails already became independent image links.
      if (!url || children.querySelector('a')) {
        parent.append(children);
      } else {
        const link = makeLink(url);
        link.append(children);
        parent.append(link);
      }
    } else if (ELEMENTS.has(tag)) {
      const element = document.createElement(tag);
      appendChildren(child, element);
      parent.append(element);
    } else {
      appendChildren(child, parent);
    }
  }
}

export function renderTopicContent({ content, contentRendered } = {}) {
  const fragment = document.createDocumentFragment();
  if (typeof contentRendered === 'string' && contentRendered.trim()) {
    // Template contents remain inert. Only newly constructed elements enter the popup.
    const template = document.createElement('template');
    template.innerHTML = contentRendered;
    appendChildren(template.content, fragment);
    if (fragment.textContent.trim() || fragment.querySelector('img')) return fragment;
    fragment.replaceChildren();
  }
  const hasContent = typeof content === 'string' && Boolean(content.trim());
  const plain = document.createElement(hasContent ? 'pre' : 'p');
  if (hasContent) {
    plain.className = 'topic-content-plain';
    plain.textContent = content;
  } else {
    plain.className = 'topic-content-empty';
    plain.textContent = '这个主题没有正文。';
  }
  fragment.append(plain);
  return fragment;
}
