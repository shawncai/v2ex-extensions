export const CATEGORY_LABELS = Object.freeze({
  tech: '技术',
  creative: '创意',
  play: '好玩',
  apple: 'Apple',
  jobs: '酷工作',
  deals: '交易'
});

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 200;
const FORMAT_ERROR = 'V2EX 分类订阅格式异常，请稍后重试。';
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function xmlText(value) {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);|&/g, (_, entity) => {
    if (!entity) throw new Error(FORMAT_ERROR);
    if (Object.hasOwn(XML_ENTITIES, entity)) return XML_ENTITIES[entity];
    const hex = entity.startsWith('#x');
    const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      throw new Error(FORMAT_ERROR);
    }
    return String.fromCodePoint(code);
  });
}

function attributes(source) {
  if (source.length > 4096) throw new Error(FORMAT_ERROR);
  const attrs = Object.create(null);
  for (const match of source.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[match[1]] = xmlText(match[2] ?? match[3]);
  }
  return attrs;
}

function categoryTopic(entry) {
  const link = /^https:\/\/(?:www|edge)\.v2ex\.com\/t\/([1-9]\d*)#reply(\d+)$/.exec(entry.href);
  const id = Number(link?.[1]);
  const replies = Number(link?.[2]);
  const title = entry.title.trim();
  const author = entry.author.trim();
  const created = Math.floor(Date.parse(entry.published.trim()) / 1000);
  if (!Number.isSafeInteger(id) || !Number.isSafeInteger(replies) || !title || !author || !(created > 0)) {
    throw new Error(FORMAT_ERROR);
  }
  // Tab feeds aggregate multiple nodes and omit each topic's node.
  return { id, title, node: '', nodeTitle: '', author, created, replies };
}

// Service workers have no DOMParser. Read only the Atom fields we display.
// Treat CDATA and comments as whole tokens, so post bodies cannot add entries.
function parseAtom(xml, category) {
  const tokens = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([\w:.-]+)((?:[^<>"']|"[^"]*"|'[^']*')*)>|([^<]+)/gy;
  const stack = [];
  const topics = [];
  let entry;
  let feedTitle = '';
  let validSelfLink = false;
  let closed = false;
  let offset = 0;
  while (offset < xml.length) {
    const token = tokens.exec(xml);
    if (!token) throw new Error(FORMAT_ERROR);
    offset = tokens.lastIndex;
    const [, cdata, slash, tag, attrText, rawText] = token;
    const path = stack.join('/');
    if (cdata !== undefined || rawText !== undefined) {
      const value = () => cdata ?? xmlText(rawText);
      if (path === 'feed/title') feedTitle += value();
      else if (path === 'feed/entry/title') entry.title += value();
      else if (path === 'feed/entry/author/name') entry.author += value();
      else if (path === 'feed/entry/published') entry.published += value();
      else if (!path && value().trim()) throw new Error(FORMAT_ERROR);
      continue;
    }
    if (!tag) continue;
    if (slash) {
      if (stack.pop() !== tag) throw new Error(FORMAT_ERROR);
      if (path === 'feed/entry') topics.push(categoryTopic(entry));
      if (path === 'feed') closed = true;
      continue;
    }
    if (!path && (closed || tag !== 'feed' || attributes(attrText).xmlns !== 'http://www.w3.org/2005/Atom')) {
      throw new Error(FORMAT_ERROR);
    }
    if (tag === 'entry') {
      if (path !== 'feed' || topics.length >= MAX_ENTRIES || attrText.trimEnd().endsWith('/')) {
        throw new Error(FORMAT_ERROR);
      }
      entry = { title: '', published: '', author: '', href: '' };
    }
    if (tag === 'link' && (path === 'feed' || path === 'feed/entry')) {
      const { rel, href } = attributes(attrText);
      if (path === 'feed' && rel === 'self') {
        validSelfLink = href === `https://www.v2ex.com/feed/tab/${category}.xml`
          || href === `https://edge.v2ex.com/feed/tab/${category}.xml`;
      }
      if (path === 'feed/entry' && rel === 'alternate') entry.href = href;
    }
    if (stack.length >= 32) throw new Error(FORMAT_ERROR);
    if (!attrText.trimEnd().endsWith('/')) stack.push(tag);
  }
  if (!closed || stack.length || !validSelfLink || feedTitle.trim() !== 'V2EX - ' + CATEGORY_LABELS[category]) {
    throw new Error(FORMAT_ERROR);
  }
  return { topics, hasMore: false };
}

export async function readCategory(response, category) {
  if (!response.body) throw new Error(FORMAT_ERROR);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let xml = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) {
        await reader.cancel();
        throw new Error('V2EX 分类订阅过大，请稍后重试。');
      }
      xml += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return parseAtom(xml + decoder.decode(), category);
}
