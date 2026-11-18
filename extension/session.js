const PUBLIC = Object.freeze({ token: '', scope: 'public' });

export async function getCredentials() {
  const { credentials } = await chrome.storage.session.get('credentials');
  return credentials || PUBLIC;
}

export async function setToken(token) {
  const credentials = token ? { token, scope: crypto.randomUUID() } : PUBLIC;
  const { reading } = await chrome.storage.session.get('reading');
  const reset = { credentials, 'feed-latest': null, 'feed-node': null, 'incoming-latest': null };
  if (reading && ['latest', 'node'].includes(reading.view.kind)) reset.reading = null;
  await chrome.storage.session.set(reset);
}

export async function invalidateFeed(kind, scope, slug = '') {
  const protectedFeed = scope !== 'public';
  const keys = protectedFeed ? ['feed-latest', 'feed-node', 'incoming-latest']
    : [kind === 'category' ? 'feed-category-' + slug : 'feed-' + kind];
  if (!protectedFeed && (kind === 'latest' || kind === 'category')) {
    keys.push('incoming-' + (kind === 'latest' ? 'latest' : slug));
  }
  const saved = await chrome.storage.session.get(['credentials', 'reading', ...keys]);
  if (protectedFeed && saved.credentials?.scope !== scope) return;
  const reset = {};
  for (const key of keys) {
    if (saved[key]?.scope === scope) reset[key] = null;
  }
  const reading = saved.reading;
  if (reading?.entry.scope === scope && (protectedFeed ||
      (reading.view.kind === kind && reading.entry.slug === slug))) reset.reading = null;
  if (Object.keys(reset).length) await chrome.storage.session.set(reset);
}
