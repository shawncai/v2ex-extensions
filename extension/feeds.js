import { CATEGORY_LABELS, readCategory } from './categories.js';

const API_ORIGIN = 'https://edge.v2ex.com';
const NODE_NAME = /^[a-z0-9_-]+$/i;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTopic(raw, fallbackNode) {
  if (Number(raw?.deleted) > 0) return null;
  const id = Number(raw?.id);
  const title = text(raw?.title);
  if (!Number.isSafeInteger(id) || id <= 0 || !title) {
    throw new Error('V2EX 返回的主题数据不完整。');
  }

  const name = text(raw.node?.name) || fallbackNode;
  const node = NODE_NAME.test(name) ? name : '';
  return {
    id,
    title,
    node,
    nodeTitle: text(raw.node?.title) || node,
    author: text(raw.member?.username),
    created: Number.isSafeInteger(raw.created) && raw.created > 0 ? raw.created : 0,
    replies: Number.isSafeInteger(raw.replies) && raw.replies >= 0 ? raw.replies : 0
  };
}

function hasNextPage(pagination, page, count) {
  if (count === 0) return false;
  if (Number.isInteger(pagination?.pages)) return page < pagination.pages;
  if (Number.isInteger(pagination?.per_page) && pagination.per_page > 0) {
    if (Number.isInteger(pagination.total)) return page * pagination.per_page < pagination.total;
    return count === pagination.per_page;
  }
  // Some list responses omit totals. An empty result closes pagination.
  return true;
}

function httpError(status, kind, authenticated) {
  let message = `V2EX 请求失败（HTTP ${status}）。`;
  if (status === 401 && authenticated) message = '访问令牌无效或已过期，请更新令牌。';
  if (status === 403) message = 'V2EX 拒绝了此次访问。';
  if (kind === 'topic' && (status === 403 || (status === 401 && !authenticated))) {
    message = '当前身份无法预览此主题，可以打开原帖查看。';
  }
  if (status === 404 && kind === 'node') message = '找不到这个节点，请检查节点名。';
  if (status === 404 && kind === 'topic') message = '找不到此主题，或当前身份无权查看。可以打开原帖确认。';
  if (status === 429) message = '请求次数已达上限，请稍后再试。';
  if (status >= 500) message = 'V2EX 服务暂时不可用，请稍后再试。';
  const error = new Error(message);
  error.status = status;
  return error;
}

async function request(url, { kind, nodeName, token, signal }) {
  const headers = { Accept: kind === 'category' ? 'application/atom+xml' : 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const response = await fetch(url, {
      headers,
      signal,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    });
    if (!response.ok) throw httpError(response.status, kind, Boolean(token));
    return kind === 'category' ? await readCategory(response, nodeName) : await response.json();
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (error.name === 'SyntaxError') throw new Error('V2EX 返回的数据格式异常。');
    if (error.name === 'TypeError') throw new Error('无法连接 V2EX，请检查网络后重试。');
    throw error;
  }
}

export async function fetchTopic({ id, token = '', signal }) {
  const topicId = typeof id === 'string' && /^\d+$/.test(id) ? Number(id) : id;
  if (!Number.isSafeInteger(topicId) || topicId <= 0) throw new Error('主题编号无效。');

  const credential = text(token);
  const url = new URL(credential ? `/api/v2/topics/${topicId}` : '/api/topics/show.json', API_ORIGIN);
  if (!credential) url.searchParams.set('id', String(topicId));
  const body = await request(url, { kind: 'topic', token: credential, signal });
  let raw;
  if (credential) {
    if (body?.success === false) throw new Error('V2EX 未能读取此主题，可以打开原帖查看。');
    if (body?.success !== true || !body.result) throw new Error('V2EX 返回的数据格式异常。');
    raw = body.result;
  } else {
    if (!Array.isArray(body) || body.length > 1) throw new Error('V2EX 返回的数据格式异常。');
    // The public API uses an empty array for missing or inaccessible topics.
    if (body.length === 0) throw httpError(404, 'topic', false);
    raw = body[0];
  }
  const topic = normalizeTopic(raw, '');
  if (!topic) throw httpError(404, 'topic', Boolean(credential));
  if (topic.id !== topicId) throw new Error('V2EX 返回的主题编号与请求不符。');
  if (typeof raw.content !== 'string' && typeof raw.content_rendered !== 'string') {
    throw new Error('V2EX 接口未提供正文，可以打开原帖查看。');
  }
  return {
    ...topic,
    content: typeof raw.content === 'string' ? raw.content : '',
    contentRendered: typeof raw.content_rendered === 'string' ? raw.content_rendered : ''
  };
}

export async function fetchFeed({ kind, node = '', page = 1, token = '', signal }) {
  const nodeName = text(node);
  if (!['latest', 'hot', 'node', 'category'].includes(kind)) throw new Error('未知的主题列表。');
  if (kind === 'node' && !NODE_NAME.test(nodeName)) throw new Error('请输入有效的节点名。');
  if (kind === 'category' && !Object.hasOwn(CATEGORY_LABELS, nodeName)) throw new Error('未知的主题分类。');
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('页码无效。');

  const credential = (kind === 'latest' || kind === 'node') ? text(token) : '';
  const authenticated = Boolean(credential);
  if (!authenticated && page > 1) return { topics: [], hasMore: false };
  let url;
  if (kind === 'category') {
    url = new URL(`/feed/tab/${nodeName}.xml`, API_ORIGIN);
  } else if (authenticated) {
    const path = kind === 'latest' ? 'topics/latest' : `nodes/${nodeName}/topics`;
    url = new URL(`/api/v2/${path}`, API_ORIGIN);
    url.searchParams.set('p', String(page));
  } else {
    const resource = kind === 'node' ? 'show' : kind;
    url = new URL(`/api/topics/${resource}.json`, API_ORIGIN);
    if (kind === 'node') url.searchParams.set('node_name', nodeName);
  }

  const body = await request(url, { kind, nodeName, token: credential, signal });
  if (kind === 'category') return body;
  if (authenticated && body?.success === false) throw new Error('V2EX 未能读取主题列表。');
  const entries = authenticated ? body?.result : body;
  if (!Array.isArray(entries)) throw new Error('V2EX 返回的数据格式异常。');
  const fallbackNode = kind === 'node' ? nodeName : '';
  const topics = entries.map(entry => normalizeTopic(entry, fallbackNode)).filter(Boolean);
  return {
    topics,
    hasMore: authenticated && hasNextPage(body.pagination, page, entries.length)
  };
}
