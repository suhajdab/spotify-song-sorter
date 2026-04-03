// ── State ──────────────────────────────────────────────────────────────────────
const selected = new Set();
const sorted = new Set();
let allPlaylists = [];

// ── Boot ───────────────────────────────────────────────────────────────────────
(async function init() {
  const status = await fetch('/auth/status').then(r => r.json());
  if (!status.loggedIn) {
    window.location.href = '/';
    return;
  }
  document.getElementById('displayName').textContent = status.displayName || '';
  await loadPlaylists();
})();

// ── Load playlists ─────────────────────────────────────────────────────────────
async function loadPlaylists() {
  const grid = document.getElementById('playlistGrid');
  grid.innerHTML = '<div class="state-message"><div class="spinner"></div>Loading your playlists…</div>';

  try {
    const playlistRes = await fetch('/api/playlists');
    if (playlistRes.status === 429) {
      const { retryAfter } = await playlistRes.json();
      const hint = retryAfter !== '?' ? ` Try again in ${retryAfter} seconds.` : ' Try again shortly.';
      grid.innerHTML = `<div class="state-message">Spotify rate limit reached.${hint}</div>`;
      return;
    }
    if (!playlistRes.ok) throw new Error('Failed to load playlists');
    allPlaylists = await playlistRes.json();

    if (allPlaylists.length === 0) {
      grid.innerHTML = '<div class="state-message">No playlists found.</div>';
      return;
    }

    renderGrid();
  } catch (err) {
    grid.innerHTML = `<div class="state-message">Error: ${err.message}</div>`;
  }
}

function renderGrid() {
  const grid = document.getElementById('playlistGrid');
  grid.innerHTML = '';

  for (const pl of allPlaylists) {
    const card = document.createElement('div');
    card.className = 'playlist-card' + (selected.has(pl.id) ? ' selected' : '') + (sorted.has(pl.id) ? ' sorted' : '');
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
  for (const pl of allPlaylists) selected.add(pl.id);
  updateSelectionUI();
}

function deselectAll() {
  selected.clear();
  updateSelectionUI();
}

function markSorted(id) {
  sorted.add(id);
  selected.delete(id);
  updateSelectionUI();
}

function updateSelectionUI() {
  // Update card styles
  for (const card of document.querySelectorAll('.playlist-card')) {
    card.classList.toggle('selected', selected.has(card.dataset.id));
    card.classList.toggle('sorted', sorted.has(card.dataset.id));
  }

  // Update count label and sort button
  const count = selected.size;
  document.getElementById('selectionCount').textContent =
    count === 0 ? '0 selected' : `${count} playlist${count !== 1 ? 's' : ''} selected`;
  document.getElementById('sortBtn').disabled = count === 0;
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
        <span class="status-icon" id="icon-${id}">⏳</span>
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
        setIcon(id, '✅');
        setBar(id, 100);
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
        setStatus(id, `Moving "${truncate(event.name, 40)}"…`, null);
      } else {
        setStatus(id, `Checking position ${event.position + 1} of ${event.total}…`, null);
      }
      setIcon(id, '🔄');
      break;
    }

    case 'error':
      setStatus(id, `Error: ${event.message}`, null);
      setIcon(id, '❌');
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
  if (el) el.textContent = icon;
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

function logout() {
  window.location.href = '/auth/logout';
}
