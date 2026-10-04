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
 *   node src/backfill.js --days=3 --refresh=123,456   # also replace these activities' rows
 *
 * Activities already in the sheet are normally skipped. --refresh deletes the listed
 * activities' rows and writes them again from Strava (any date), so edits made on Strava
 * replace the old version. A refreshed activity that is no longer a run is only removed.
 */

import 'dotenv/config';
import { listActivities, fetchActivity, fetchActivityDetail } from './strava.js';
import { appendLaps, appendStreams, appendSegmentAnalysis, appendKmSplits, appendMileSplits, deleteActivityRows } from './sheets.js';
import { analyzeLaps, analyzeKmSplits, analyzeMileSplits } from './analyze.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')),
);
const limit = args.limit ? parseInt(args.limit) : Infinity;
const after = Math.floor(Date.now() / 1000) - parseInt(args.days ?? 30) * 86400;
const refresh = new Set(String(args.refresh ?? '').split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s)));

async function writeActivity(activity) {
  const { laps, streams } = await fetchActivityDetail(activity);
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
}

async function refreshActivities() {
  for (const id of refresh) {
    console.log(`\n[refresh] ${id}`);
    try {
      const activity = await fetchActivity(id);
      const removed = await deleteActivityRows(id);
      console.log(`  removed ${removed} old rows`);
      if (activity.sport_type !== 'Run') {
        console.log(`  now ${activity.sport_type}, not re-imported`);
        continue;
      }
      await writeActivity(activity);
      console.log('  rewritten to sheets');
    } catch (err) {
      console.error(`  error: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function run() {
  await refreshActivities();

  let page = 1;
  let fetched = 0;

  while (fetched < limit) {
    const activities = await listActivities({ page, perPage: 30, after });
    if (activities.length === 0) break;

    const runs = activities.filter((a) => a.sport_type === 'Run');

    for (const activity of runs) {
      if (fetched >= limit) break;
      if (refresh.has(String(activity.id))) continue;   // already rewritten above
      console.log(`\n[${fetched + 1}] ${activity.name} (${activity.id}) — ${activity.start_date_local}`);

      try {
        await writeActivity(activity);
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
