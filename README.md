# Spotify Song Sorter

Sorts your Spotify playlists so the most recently added song always plays first — without changing the original "Added" dates.

Useful for interfaces that don't expose a sort-by-date option, since the custom position order is always respected.

## How it works

Uses Spotify's reorder API (`PUT /playlists/{id}/items` with `range_start` + `insert_before`) to move tracks into newest-first order. This preserves `added_at` timestamps — only the playback position changes.

## Setup

### 1. Create a Spotify app

Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), create an app, and add the following Redirect URI:

```
http://127.0.0.1:3000/auth/callback
```

### 2. Configure credentials

```bash
cp .env.example .env
```

Edit `.env` and fill in your Client ID, Client Secret, and a random session secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Install and run

```bash
npm install
node server.js
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) in your browser.

## Usage

1. Log in with your Spotify account
2. Select one or more playlists (use the search field to find them)
3. Click **Sort Selected Playlists**
4. Sorted playlists get a green checkmark — sorting is non-destructive and can be run again anytime

## Notes

- Only playlists you own can be reordered; collaborative/followed playlists show a 🔗 badge
- Large playlists take longer — the app makes one API call per track that needs to move, with a short delay between calls to respect Spotify's rate limits
- Sorting state (the green checkmarks) resets on page refresh
