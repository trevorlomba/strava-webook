import 'dotenv/config';
import express from 'express';
import { fetchActivity, fetchActivityDetail } from './strava.js';
import { appendLaps, appendStreams, appendSegmentAnalysis, appendKmSplits, appendMileSplits } from './sheets.js';
import { analyzeLaps, analyzeKmSplits, analyzeMileSplits } from './analyze.js';

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.STRAVA_WEBHOOK_VERIFY_TOKEN;

// --- Webhook subscription verification (GET) ---
// Strava calls this when you register a webhook subscription.
// https://developers.strava.com/docs/webhooks/
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook subscription verified');
    return res.json({ 'hub.challenge': challenge });
  }

  res.sendStatus(403);
});

// --- Incoming activity events (POST) ---
app.post('/webhook', async (req, res) => {
  // Acknowledge immediately — Strava expects a 200 within 2 seconds.
  res.sendStatus(200);

  const event = req.body;
  console.log('Webhook event:', JSON.stringify(event));

  // Only process new activity creates.
  if (event.object_type !== 'activity' || event.aspect_type !== 'create') return;

  const activityId = event.object_id;
  try {
    const activity = await fetchActivity(activityId);
    if (activity.sport_type !== 'Run') {
      console.log(`Activity ${activityId} is ${activity.sport_type}, skipping.`);
      return;
    }
    const { laps, streams } = await fetchActivityDetail(activityId);
    console.log(`Activity ${activityId}: ${laps.length} laps, streams keys: ${Object.keys(streams).join(', ')}`);
    const analysis = analyzeLaps(activity, laps, streams);
    const kmSplits = analyzeKmSplits(activity, streams);
    const mileSplits = analyzeMileSplits(activity, streams);
    await Promise.all([
      appendLaps(activity, laps),
      appendStreams(activityId, activity.name, streams),
      appendSegmentAnalysis(analysis),
      appendKmSplits(kmSplits),
      appendMileSplits(mileSplits),
    ]);
    console.log(`Activity ${activityId} written to sheets.`);
  } catch (err) {
    console.error(`Failed to fetch detail for activity ${activityId}:`, err.message);
  }
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`Strava webhook server listening on port ${PORT}`));
