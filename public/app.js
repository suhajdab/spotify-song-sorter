// ── Status icons (SVG) ────────────────────────────────────────────────────────
const STATUS_ICONS = {
  waiting: `<svg class="status-svg muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>`,
  loading: `<svg class="status-svg brand spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`,
  done:    `<svg class="status-svg brand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  error:   `<svg class="status-svg error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
};

// ── State ──────────────────────────────────────────────────────────────────────
const selected = new Set();
const sorted = new Set();
const modified = new Set(); // previously sorted but changed since
let allPlaylists = [];
let activeFilter = 'all';

// ── localStorage helpers ───────────────────────────────────────────────────────
const STORAGE_KEY = 'spotify-sorter-snapshots';
function loadSnapshots() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
}
function saveSnapshot(id, snapshotId) {
  const snapshots = loadSnapshots();
  snapshots[id] = snapshotId;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshots));
}

// ── Boot ───────────────────────────────────────────────────────────────────────
(async function init() {
  bindControls();

  const status = await fetch('/auth/status').then(r => r.json());
  if (!status.loggedIn) {
    window.location.replace('/');
    return;
  }
  document.getElementById('displayName').textContent = status.displayName || '';
  await loadPlaylists();
})();

function redirectToLogin() {
  window.location.replace('/auth/logout');
}

function bindControls() {
  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => setFilter(tab.dataset.filter));
  });

  document.getElementById('searchInput')?.addEventListener('input', event => {
    filterPlaylists(event.target.value);
  });

  document.getElementById('logoutBtn')?.addEventListener('click', logout);
  document.getElementById('selectAllBtn')?.addEventListener('click', selectAll);
  document.getElementById('deselectAllBtn')?.addEventListener('click', deselectAll);
  document.getElementById('sortBtn')?.addEventListener('click', startSort);
  document.getElementById('dismissResortBtn')?.addEventListener('click', dismissResort);
  document.getElementById('confirmResortBtn')?.addEventListener('click', confirmResort);
  document.getElementById('doneBtn')?.addEventListener('click', closeModal);
}

// ── Load playlists ─────────────────────────────────────────────────────────────
async function loadPlaylists() {
  const grid = document.getElementById('playlistGrid');
  grid.innerHTML = '<div class="state-message"><div class="spinner"></div>Loading your playlists…</div>';

  try {
    const playlistRes = await fetch('/api/playlists');
    if (playlistRes.status === 401) {
      redirectToLogin();
      return;
    }
    if (playlistRes.status === 429) {
      const { retryAfter } = await playlistRes.json();
      const hint = retryAfter !== '?' ? ` Try again in ${formatDuration(retryAfter)}.` : ' Try again shortly.';
      grid.innerHTML = `<div class="state-message">Spotify rate limit reached.${hint}</div>`;
      return;
    }
    if (!playlistRes.ok) throw new Error('Failed to load playlists');
    allPlaylists = await playlistRes.json();

    if (allPlaylists.length === 0) {
      grid.innerHTML = '<div class="state-message">No playlists found.</div>';
      return;
    }

    const snapshots = loadSnapshots();
    for (const pl of allPlaylists) {
      if (!pl.snapshotId || !snapshots[pl.id]) continue;
      if (snapshots[pl.id] === pl.snapshotId) sorted.add(pl.id);
      else modified.add(pl.id);
    }

    if (modified.size > 0) {
      activeFilter = 'needs-resorting';
      renderGrid();
      showResortPrompt();
    } else {
      renderGrid();
    }
  } catch (err) {
    grid.innerHTML = `<div class="state-message">Error: ${err.message}</div>`;
  }
}

function filteredPlaylists() {
  switch (activeFilter) {
    case 'sorted':         return allPlaylists.filter(pl => sorted.has(pl.id));
    case 'unsorted':       return allPlaylists.filter(pl => !sorted.has(pl.id) && !modified.has(pl.id));
    case 'needs-resorting': return allPlaylists.filter(pl => modified.has(pl.id));
    default:               return allPlaylists;
  }
}

function updateFilterTabs() {
  const unsortedCount = allPlaylists.filter(pl => !sorted.has(pl.id) && !modified.has(pl.id)).length;
  document.getElementById('count-all').textContent = allPlaylists.length;
  document.getElementById('count-unsorted').textContent = unsortedCount;
  document.getElementById('count-sorted').textContent = sorted.size;
  document.getElementById('count-needs-resorting').textContent = modified.size;

  for (const tab of document.querySelectorAll('.filter-tab')) {
    tab.classList.toggle('active', tab.dataset.filter === activeFilter);
  }
}

function setFilter(filter) {
  activeFilter = filter;
  renderGrid();
}

function renderGrid() {
  const grid = document.getElementById('playlistGrid');
  grid.innerHTML = '';

  updateFilterTabs();

  const visible = filteredPlaylists();
  if (visible.length === 0) {
    grid.innerHTML = '<div class="state-message">No playlists match this filter.</div>';
    return;
  }

  for (const pl of visible) {
    const card = document.createElement('div');
    card.className = 'playlist-card' +
      (selected.has(pl.id)  ? ' selected'  : '') +
      (sorted.has(pl.id)    ? ' sorted'    : '') +
      (modified.has(pl.id)  ? ' modified'  : '');
    card.dataset.id = pl.id;
    card.onclick = () => toggleSelect(pl.id);

    const imgHtml = pl.imageUrl
      ? `<img src="${escHtml(pl.imageUrl)}" alt="" loading="lazy" />`
      : `<div class="no-image">♫</div>`;

    card.innerHTML = `
      ${imgHtml}
      <div class="playlist-name" title="${escHtml(pl.name)}">${escHtml(pl.name)}</div>
      <div class="playlist-meta">${pl.trackCount} track${pl.trackCount !== 1 ? 's' : ''}</div>
      <div class="check-badge">
        <svg viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </div>
      <div class="modified-badge" title="Modified since last sort">⚠️</div>
      <div class="sorted-badge">
        <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </div>
    `;

    grid.appendChild(card);
  }
}

// ── Selection ──────────────────────────────────────────────────────────────────
function toggleSelect(id) {
  if (selected.has(id)) {
    selected.delete(id);
  } else {
    selected.add(id);
  }
  updateSelectionUI();
}

function selectAll() {
  for (const pl of filteredPlaylists()) selected.add(pl.id);
  updateSelectionUI();
}

function deselectAll() {
  for (const pl of filteredPlaylists()) selected.delete(pl.id);
  updateSelectionUI();
}

function markSorted(id) {
  sorted.add(id);
  selected.delete(id);
  modified.delete(id);
  updateSelectionUI();
}

function updateSelectionUI() {
  // Update card styles
  for (const card of document.querySelectorAll('.playlist-card')) {
    card.classList.toggle('selected', selected.has(card.dataset.id));
    card.classList.toggle('sorted', sorted.has(card.dataset.id));
    card.classList.toggle('modified', modified.has(card.dataset.id));
  }

  // Update count label and sort button
  const count = selected.size;
  document.getElementById('selectionCount').textContent =
    count === 0 ? '0 selected' : `${count} playlist${count !== 1 ? 's' : ''} selected`;
  const sortBtn = document.getElementById('sortBtn');
  sortBtn.disabled = count === 0;
  sortBtn.textContent = count > 0 ? `Sort Selected Playlists (${count})` : 'Sort Selected Playlists';

  updateFilterTabs();
}

// ── Sort ───────────────────────────────────────────────────────────────────────
async function startSort() {
  if (selected.size === 0) return;

  const ids = [...selected];
  openModal(ids);

  for (const id of ids) {
    await sortOnePlaylist(id);
  }

  document.getElementById('doneBtn').style.display = 'inline-block';
}

function openModal(ids) {
  const list = document.getElementById('progressList');
  list.innerHTML = '';

  for (const id of ids) {
    const pl = allPlaylists.find(p => p.id === id);
    const item = document.createElement('div');
    item.className = 'playlist-progress-item';
    item.id = `progress-${id}`;
    item.innerHTML = `
      <div class="name">
        <span>${escHtml(pl?.name || id)}</span>
        <span class="status-icon" id="icon-${id}">${STATUS_ICONS.waiting}</span>
      </div>
      <div class="status-text" id="status-${id}">Waiting…</div>
      <div class="progress-bar-bg">
        <div class="progress-bar-fill" id="bar-${id}"></div>
      </div>
    `;
    list.appendChild(item);
  }

  document.getElementById('doneBtn').style.display = 'none';
  document.getElementById('modalOverlay').classList.add('visible');
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('visible');
  setFilter('all');
}

async function sortOnePlaylist(id) {
  setStatus(id, 'Connecting…', null);

  return new Promise((resolve) => {
    const es = new EventSource(`/api/playlists/${id}/sort`);
    // EventSource only supports GET; we need POST — fall back to fetch+ReadableStream
    es.close();
    sortViaFetch(id).then(resolve);
  });
}

// Use fetch with a ReadableStream to consume the SSE from a POST endpoint
async function sortViaFetch(id) {
  const res = await fetch(`/api/playlists/${id}/sort`, { method: 'POST' });

  if (res.status === 401) {
    redirectToLogin();
    return;
  }

  if (!res.ok) {
    setStatus(id, 'Request failed', null, '❌');
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        handleSSEEvent(id, JSON.parse(line.slice(6)));
      } catch {
        // ignore malformed line
      }
    }
  }
}

function handleSSEEvent(id, event) {
  switch (event.type) {
    case 'status':
      setStatus(id, event.message, null);
      if (event.message.startsWith('Done')) {
        setIcon(id, 'done');
        setBar(id, 100);
        const snapshotId = event.snapshotId || allPlaylists.find(p => p.id === id)?.snapshotId;
        if (snapshotId) saveSnapshot(id, snapshotId);
        markSorted(id);
      }
      break;

    case 'total':
      setBar(id, 0);
      break;

    case 'progress': {
      const pct = Math.round((event.position / event.total) * 100);
      setBar(id, pct);
      if (event.moved) {
        setStatus(id, `Moving "${escHtml(truncate(event.name, 40))}"…`);
      } else {
        setStatus(id, `Checking position ${event.position + 1} of ${event.total}…`, null);
      }
      setIcon(id, 'loading');
      break;
    }

    case 'error':
      setStatus(id, `Error: ${escHtml(event.message)}`);
      setIcon(id, 'error');
      break;

    case 'auth_expired':
      redirectToLogin();
      break;

    case 'done':
      // final sentinel — status message already set
      break;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function setStatus(id, text) {
  const el = document.getElementById(`status-${id}`);
  if (el) el.textContent = text;
}

function setIcon(id, icon) {
  const el = document.getElementById(`icon-${id}`);
  if (el) el.innerHTML = STATUS_ICONS[icon] || icon;
}

function setBar(id, pct) {
  const el = document.getElementById(`bar-${id}`);
  if (el) el.style.width = pct + '%';
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function filterPlaylists(query) {
  const q = query.trim().toLowerCase();
  for (const card of document.querySelectorAll('.playlist-card')) {
    const name = card.querySelector('.playlist-name').textContent.toLowerCase();
    card.style.display = name.includes(q) ? '' : 'none';
  }
}

function formatDuration(seconds) {
  seconds = parseInt(seconds, 10);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ── Re-sort prompt ─────────────────────────────────────────────────────────────
function showResortPrompt() {
  const list = document.getElementById('resortList');
  list.innerHTML = '';
  for (const id of modified) {
    const pl = allPlaylists.find(p => p.id === id);
    const li = document.createElement('li');
    li.textContent = pl?.name || id;
    list.appendChild(li);
  }
  document.getElementById('resortOverlay').classList.add('visible');
}

function dismissResort() {
  document.getElementById('resortOverlay').classList.remove('visible');
  activeFilter = 'all';
  renderGrid();
}

function confirmResort() {
  document.getElementById('resortOverlay').classList.remove('visible');
  for (const id of modified) selected.add(id);
  updateSelectionUI();
  startSort();
}

function logout() {
  window.location.href = '/auth/logout';
}
