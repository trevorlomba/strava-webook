/**
 * Fetch laps and streams for existing activities and write them to Google Sheets.
 * Run with: node src/backfill.js
 *
 * Strava rate limits: 100 requests/15 min, 1000/day.
 * This script fetches 2 requests per activity (laps + streams) plus 1 per page of listing.
 *
 * Examples:
 *   node src/backfill.js                          # all runs
 *   node src/backfill.js --days=30                # runs in the last 30 days
 *   node src/backfill.js --days=30 --limit=10     # up to 10 runs in the last 30 days
 */

import 'dotenv/config';
import { listActivities, fetchActivityDetail } from './strava.js';
import { appendLaps, appendStreams, appendSegmentAnalysis, appendKmSplits, appendMileSplits } from './sheets.js';
import { analyzeLaps, analyzeKmSplits, analyzeMileSplits } from './analyze.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')),
);
const limit = args.limit ? parseInt(args.limit) : Infinity;
const after = Math.floor(Date.now() / 1000) - parseInt(args.days ?? 30) * 86400;

async function run() {
  let page = 1;
  let fetched = 0;

  while (fetched < limit) {
    const activities = await listActivities({ page, perPage: 30, after });
    if (activities.length === 0) break;

    const runs = activities.filter((a) => a.sport_type === 'Run');

    for (const activity of runs) {
      if (fetched >= limit) break;
      console.log(`\n[${fetched + 1}] ${activity.name} (${activity.id}) — ${activity.start_date_local}`);

      try {
        const { laps, streams } = await fetchActivityDetail(activity.id);
        console.log(`  laps: ${laps.length}, streams: ${Object.keys(streams).join(', ')}`);
        const analysis = analyzeLaps(activity, laps, streams);
        const kmSplits = analyzeKmSplits(activity, streams);
        const mileSplits = analyzeMileSplits(activity, streams);
        await Promise.all([
          appendLaps(activity, laps),
          appendStreams(activity.id, activity.name, streams),
          appendSegmentAnalysis(analysis),
          appendKmSplits(kmSplits),
          appendMileSplits(mileSplits),
        ]);
        console.log('  written to sheets');
      } catch (err) {
        console.error(`  error: ${err.message}`);
      }

      fetched++;
      // Stay under rate limits: ~1 req/sec for the detail calls
      await new Promise((r) => setTimeout(r, 1000));
    }

    page++;
  }

  console.log(`\nDone. Processed ${fetched} activities.`);
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
