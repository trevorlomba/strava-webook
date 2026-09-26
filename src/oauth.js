/**
 * One-time OAuth flow to obtain a refresh token.
 * Run with: npm run oauth
 *
 * Steps:
 *  1. Open the printed URL in your browser and authorize the app.
 *  2. Strava redirects to localhost:3000/oauth/callback with a `code` param.
 *  3. This server exchanges the code for tokens and prints the refresh token.
 *     Copy it into your .env as STRAVA_REFRESH_TOKEN.
 */

import 'dotenv/config';
import http from 'http';
import { URL } from 'url';

const { STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET } = process.env;

if (!STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET) {
  console.error('Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in .env first.');
  process.exit(1);
}

const REDIRECT_URI = 'http://localhost:3000/oauth/callback';
const SCOPE = 'activity:read_all';

const authUrl =
  `https://www.strava.com/oauth/authorize` +
  `?client_id=${STRAVA_CLIENT_ID}` +
  `&response_type=code` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&scope=${SCOPE}` +
  `&approval_prompt=force`;

console.log('Open this URL in your browser:\n');
console.log(authUrl);
console.log('\nWaiting for callback...\n');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:3000`);
  if (url.pathname !== '/oauth/callback') {
    res.end('Not found');
    return;
  }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error || !code) {
    res.end(`Authorization failed: ${error ?? 'no code received'}`);
    server.close();
    return;
  }

  try {
    const tokenRes = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: STRAVA_CLIENT_ID,
        client_secret: STRAVA_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
      }),
    });

    const data = await tokenRes.json();

    if (!tokenRes.ok) {
      throw new Error(JSON.stringify(data));
    }

    console.log('=== Success ===');
    console.log(`Athlete: ${data.athlete.firstname} ${data.athlete.lastname}`);
    console.log(`\nAdd to your .env:\nSTRAVA_REFRESH_TOKEN=${data.refresh_token}`);

    res.end('Success! You can close this tab and check your terminal.');
  } catch (err) {
    console.error('Token exchange failed:', err.message);
    res.end('Token exchange failed. Check your terminal.');
  } finally {
    server.close();
  }
});

server.listen(3000);
