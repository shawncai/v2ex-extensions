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
  if (status === 404 && kind === 'node') message = '找不到这个节点，请检查节点名。';
  if (status === 429) message = '请求次数已达上限，请稍后再试。';
  if (status >= 500) message = 'V2EX 服务暂时不可用，请稍后再试。';
  const error = new Error(message);
  error.status = status;
  return error;
}

export async function fetchFeed({ kind, node = '', page = 1, token = '', signal }) {
  const nodeName = text(node);
  if (!['latest', 'hot', 'node', 'category'].includes(kind)) throw new Error('未知的主题列表。');
  if (kind === 'node' && !NODE_NAME.test(nodeName)) throw new Error('请输入有效的节点名。');
  if (kind === 'category' && !Object.hasOwn(CATEGORY_LABELS, nodeName)) throw new Error('未知的主题分类。');
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('页码无效。');

  const authenticated = (kind === 'latest' || kind === 'node') && Boolean(text(token));
  if (!authenticated && page > 1) return { topics: [], hasMore: false };
  let url;
  const headers = { Accept: 'application/json' };
  if (kind === 'category') {
    url = new URL(`/feed/tab/${nodeName}.xml`, API_ORIGIN);
    headers.Accept = 'application/atom+xml';
  } else if (authenticated) {
    const path = kind === 'latest' ? 'topics/latest' : `nodes/${nodeName}/topics`;
    url = new URL(`/api/v2/${path}`, API_ORIGIN);
    url.searchParams.set('p', String(page));
    headers.Authorization = `Bearer ${token.trim()}`;
  } else {
    const resource = kind === 'node' ? 'show' : kind;
    url = new URL(`/api/topics/${resource}.json`, API_ORIGIN);
    if (kind === 'node') url.searchParams.set('node_name', nodeName);
  }

  let body;
  try {
    const response = await fetch(url, {
      headers,
      signal,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    });
    if (!response.ok) throw httpError(response.status, kind, authenticated);
    if (kind === 'category') return await readCategory(response, nodeName);
    body = await response.json();
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (error.name === 'SyntaxError') throw new Error('V2EX 返回的数据格式异常。');
    if (error.name === 'TypeError') throw new Error('无法连接 V2EX，请检查网络后重试。');
    throw error;
  }

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
