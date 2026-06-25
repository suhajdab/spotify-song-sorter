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

To enable push notifications, generate VAPID keys and add them to `.env`:

```bash
npx web-push generate-vapid-keys
```

### 3. Install and run

```bash
npm install
node server.js
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) in your browser.

## Deploy to Vercel

1. Import this repository into Vercel or run `vercel` from the project directory.
2. Add these environment variables to the Vercel project:

   - `SPOTIFY_CLIENT_ID`
   - `SPOTIFY_CLIENT_SECRET`
   - `SPOTIFY_REDIRECT_URI`
   - `SESSION_SECRET`
   - `CRON_SECRET`
   - `VAPID_PUBLIC_KEY`
   - `VAPID_PRIVATE_KEY`
   - `VAPID_SUBJECT`
   - `UPSTASH_REDIS_REST_KV_REST_API_URL`
   - `UPSTASH_REDIS_REST_KV_REST_API_TOKEN`

3. Create an Upstash Redis integration from the Vercel Marketplace and connect
   it to the project. The REST URL and token are used to revoke sessions across
   serverless function instances when a user logs out.
4. Set `SPOTIFY_REDIRECT_URI` to the deployed callback URL, for example:

   ```
   https://spotify-sorter.example/auth/callback
   ```

5. Add the same callback URL to the Redirect URIs for your app in the
   [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
6. Redeploy after changing environment variables.

Use a stable production or custom domain for Spotify login. Each Vercel preview
deployment has a different hostname, and Spotify only redirects to URLs that are
registered exactly.

`SESSION_SECRET` encrypts the cookie that contains the Spotify session. Generate
it with the command in the local setup instructions and keep it private.
Local development uses an in-memory session revocation store. Vercel deployments
require the Upstash Redis REST variables so logout revocation works across
function instances.

The production deployment also uses the same Upstash Redis store for background
playlist tracking and push subscriptions. Vercel Cron calls
`/api/cron/check-resort-needed` once per day at 08:00 UTC by default. If the
project is on Vercel Pro, the cron schedule in `vercel.json` can be changed to
hourly, for example `0 * * * *`.

## Usage

1. Log in with your Spotify account
2. Select one or more playlists (use the search field to find them)
3. Click **Sort Selected Playlists**
4. Sorted playlists get a green checkmark — sorting is non-destructive and can be run again anytime
5. On iOS, add the site to the Home Screen, open it from the Home Screen icon,
   and enable notifications. The app will notify you when a tracked sorted
   playlist has a newer Spotify snapshot and needs re-sorting.

## Notes

- Only playlists you own can be reordered; collaborative/followed playlists show a 🔗 badge
- Large playlists take longer — the app makes one API call per track that needs to move, with a short delay between calls to respect Spotify's rate limits
- Vercel limits each sort request to 5 minutes, so very large playlists may need to be sorted in a different hosting environment
- iOS Web Push requires iOS/iPadOS 16.4 or newer and only works after the site
  is installed as a Home Screen web app
- Sorting state is saved on the server for background checks; older local
  browser state is still used as a fallback in the playlist view
