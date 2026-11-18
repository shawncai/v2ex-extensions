import { fetchFeed } from './feeds.js';
import { getCredentials, invalidateFeed } from './session.js';

const ALARM = 'v2ex-poll-feeds';
const INTERVAL_MINUTES = 180;
const FEEDS = ['latest', 'jobs', 'deals'];
let scheduling;
let polling;

async function scheduleIfMissing() {
  if (!await chrome.alarms.get(ALARM)) {
    await chrome.alarms.create(ALARM, { periodInMinutes: INTERVAL_MINUTES });
  }
}

function ensureAlarm() {
  scheduling ??= scheduleIfMissing()
    .catch(() => console.warn('V2EX 定时更新暂时无法启动。'))
    .finally(() => { scheduling = undefined; });
  return scheduling;
}

async function stageFeed(kind) {
  const at = Date.now();
  const category = kind !== 'latest';
  const credentials = category ? { scope: 'public' } : await getCredentials();
  const request = category ? { kind: 'category', node: kind } : { kind, token: credentials.token };
  let result;
  try {
    result = await fetchFeed({ ...request, page: 1, signal: AbortSignal.timeout(12_000) });
  } catch (error) {
    if (!category && credentials.token && (error.status === 401 || error.status === 403)) {
      await invalidateFeed(kind, credentials.scope);
    }
    return;
  }
  if (!result.topics.length) return;
  if (!category && (await getCredentials()).scope !== credentials.scope) return;
  await chrome.storage.session.set({
    ['incoming-' + kind]: {
      topics: result.topics, hasMore: result.hasMore,
      scope: credentials.scope, slug: category ? kind : '', page: 1, at
    }
  });
}

async function pollFeeds() {
  // An unavailable list must not discard an earlier successful update.
  await Promise.allSettled(FEEDS.map(stageFeed));
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== ALARM) return;
  polling ??= pollFeeds()
    .finally(() => { polling = undefined; });
  return polling;
});
void ensureAlarm();
