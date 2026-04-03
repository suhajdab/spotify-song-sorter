const { getPlaylistTracks, reorderTrack } = require('./spotifyClient');

const MOVE_DELAY_MS = 150; // ms between reorder API calls to avoid rate limiting

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Sort a playlist so the most recently added track is at position 0.
// Uses selection-sort style moves: for each desired position i, find where
// the correct track currently lives and move it there. This preserves added_at.
//
// `onProgress` is called with { type, ... } objects for SSE streaming.
async function sortPlaylist(session, playlistId, onProgress) {
  onProgress({ type: 'status', message: 'Fetching tracks…' });

  const tracks = await getPlaylistTracks(session, playlistId);

  if (tracks.length === 0) {
    onProgress({ type: 'status', message: 'Playlist is empty.' });
    return;
  }

  onProgress({ type: 'total', total: tracks.length });

  // Build the desired order: sort by addedAt descending (newest first).
  // Stable sort: ties keep their original relative order.
  const desired = [...tracks].sort((a, b) => {
    if (b.addedAt !== a.addedAt) return b.addedAt - a.addedAt;
    return a.position - b.position; // stable tie-break
  });

  // currentPositions[i] = current playlist position of the track that belongs
  // at desired slot i.
  // We also need a reverse map: given a track's uri+original_position, where is
  // it now?  We track this as an array mirroring the current playlist order.

  // currentOrder[pos] = index into `desired` array
  // i.e. currentOrder tells us "which desired-slot track is at each real position"
  const desiredIndexByUri = new Map();
  desired.forEach((t, i) => desiredIndexByUri.set(`${t.uri}:${t.position}`, i));

  // Build the initial current order: for each real position, which desired-slot?
  const currentOrder = tracks.map((t) => desiredIndexByUri.get(`${t.uri}:${t.position}`));
  // Inverse: desiredSlotToCurrentPos[desiredSlot] = current real position
  const desiredSlotToCurrentPos = new Array(desired.length);
  currentOrder.forEach((desiredSlot, realPos) => {
    desiredSlotToCurrentPos[desiredSlot] = realPos;
  });

  let snapshotId = null;
  let moveCount = 0;

  for (let i = 0; i < desired.length; i++) {
    const currentPos = desiredSlotToCurrentPos[i];

    if (currentPos === i) {
      // Already in the right place
      onProgress({ type: 'progress', position: i, total: desired.length, moved: false, name: desired[i].name });
      continue;
    }

    onProgress({ type: 'progress', position: i, total: desired.length, moved: true, name: desired[i].name });

    snapshotId = await reorderTrack(session, playlistId, currentPos, i, snapshotId);
    moveCount++;

    // Update our position tracking to reflect this move.
    // Moving from currentPos to i (insert_before=i means insert AT position i,
    // shifting everything between i and currentPos-1 one slot down).
    //
    // Case: currentPos > i  (moving a track forward/up the list)
    //   Tracks at positions [i, currentPos-1] shift to [i+1, currentPos].
    //   The moved track lands at position i.
    for (let p = 0; p < desired.length; p++) {
      const pos = desiredSlotToCurrentPos[p];
      if (p === i) continue; // we'll set this below
      if (pos >= i && pos < currentPos) {
        desiredSlotToCurrentPos[p] = pos + 1;
      }
    }
    desiredSlotToCurrentPos[i] = i;

    await sleep(MOVE_DELAY_MS);
  }

  onProgress({ type: 'status', message: `Done. Moved ${moveCount} of ${desired.length} tracks.`, snapshotId });
}

module.exports = { sortPlaylist };
