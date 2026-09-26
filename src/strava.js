import 'dotenv/config';

const { STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET } = process.env;
let cachedToken = { accessToken: null, expiresAt: 0 };

async function getAccessToken() {
  if (cachedToken.accessToken && Date.now() / 1000 < cachedToken.expiresAt - 60) {
    return cachedToken.accessToken;
  }

  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      refresh_token: process.env.STRAVA_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);

  cachedToken = { accessToken: data.access_token, expiresAt: data.expires_at };
  return data.access_token;
}

async function stravaGet(path) {
  const token = await getAccessToken();
  const res = await fetch(`https://www.strava.com/api/v3${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 429) {
    // Use Strava's retry-after header if present, otherwise wait 15 minutes
    const retryAfter = parseInt(res.headers.get('x-ratelimit-usage') ?? '0') > 0
      ? 15 * 60
      : parseInt(res.headers.get('retry-after') ?? '900');
    const waitS = retryAfter || 900;
    console.warn(`Rate limited. Waiting ${waitS}s before retrying...`);
    await new Promise((r) => setTimeout(r, waitS * 1000));
    return stravaGet(path);
  }

  const data = await res.json();
  if (!res.ok) throw new Error(`Strava API error on ${path}: ${JSON.stringify(data)}`);
  return data;
}

/**
 * Fetch a single activity summary.
 * @param {number|string} activityId
 * @returns {Promise<Object>}
 */
export async function fetchActivity(activityId) {
  return stravaGet(`/activities/${activityId}`);
}

/**
 * Fetch lap splits for an activity.
 * @param {number|string} activityId
 * @returns {Promise<Array>}
 */
export async function fetchLaps(activityId) {
  return stravaGet(`/activities/${activityId}/laps`);
}

/**
 * Fetch time-series streams for an activity.
 * @param {number|string} activityId
 * @param {string[]} keys  Stream types to request (defaults to a useful set)
 * @returns {Promise<Object>} Keyed by stream type
 */
export async function fetchStreams(
  activityId,
  keys = ['time', 'distance', 'heartrate', 'altitude', 'velocity_smooth', 'cadence', 'watts'],
) {
  const params = new URLSearchParams({ keys: keys.join(','), key_by_type: 'true' });
  return stravaGet(`/activities/${activityId}/streams?${params}`);
}

/**
 * Convenience: fetch both laps and streams in parallel.
 * @param {number|string} activityId
 * @returns {Promise<{ laps: Array, streams: Object }>}
 */
export async function fetchActivityDetail(activityId) {
  const [laps, streams] = await Promise.all([fetchLaps(activityId), fetchStreams(activityId)]);
  return { laps, streams };
}

/**
 * List activities for the authenticated athlete.
 * @param {{ page?: number, perPage?: number, before?: number, after?: number }} opts
 * @returns {Promise<Array>}
 */
export async function listActivities({ page = 1, perPage = 30, before, after } = {}) {
  const params = new URLSearchParams({ page, per_page: perPage });
  if (before) params.set('before', before);
  if (after) params.set('after', after);
  return stravaGet(`/athlete/activities?${params}`);
}
