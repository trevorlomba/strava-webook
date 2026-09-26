import 'dotenv/config';
import { google } from 'googleapis';

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

function getClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

const writtenIdsCache = {};

async function getWrittenActivityIds(sheets, sheetTitle) {
  if (writtenIdsCache[sheetTitle]) return writtenIdsCache[sheetTitle];
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetTitle}!A2:A`,
    });
    writtenIdsCache[sheetTitle] = new Set((res.data.values ?? []).map((r) => String(r[0])));
  } catch {
    writtenIdsCache[sheetTitle] = new Set();
  }
  return writtenIdsCache[sheetTitle];
}

function markWritten(sheetTitle, activityId) {
  if (writtenIdsCache[sheetTitle]) writtenIdsCache[sheetTitle].add(String(activityId));
}

const ensuredSheets = new Set();

async function ensureSheet(sheets, title, headers) {
  if (ensuredSheets.has(title)) return;
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = meta.data.sheets.some((s) => s.properties.title === title);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title } } }],
      },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${title}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
  }

  ensuredSheets.add(title);
}

/**
 * Append lap rows to the "Laps" sheet.
 * @param {Object} activity  Strava activity object
 * @param {Array} laps
 */
export async function appendLaps(activity, laps) {
  const sheets = getClient();
  const activityId = activity.id;

  const headers = [
    'activity_id', 'activity_name',
    'run_date', 'session_distance_m', 'session_moving_time_s', 'session_elapsed_time_s',
    'session_elev_gain_m', 'session_avg_hr', 'session_max_hr',
    'lap', 'name', 'elapsed_time_s', 'moving_time_s', 'distance_m',
    'avg_speed_ms', 'max_speed_ms',
    'avg_heartrate', 'max_heartrate',
    'avg_cadence', 'avg_watts', 'total_elevation_gain_m',
  ];

  await ensureSheet(sheets, 'Laps', headers);

  const written = await getWrittenActivityIds(sheets, 'Laps');
  if (written.has(String(activityId))) return;

  const rows = laps.map((lap) => [
    activityId,
    activity.name,
    activity.start_date_local?.slice(0, 10) ?? '',
    activity.distance != null ? Math.round(activity.distance) : '',
    activity.moving_time ?? '',
    activity.elapsed_time ?? '',
    activity.total_elevation_gain != null ? +activity.total_elevation_gain.toFixed(1) : '',
    activity.average_heartrate != null ? +activity.average_heartrate.toFixed(1) : '',
    activity.max_heartrate ?? '',
    lap.lap_index,
    lap.name,
    lap.elapsed_time,
    lap.moving_time,
    lap.distance,
    lap.average_speed,
    lap.max_speed,
    lap.average_heartrate ?? '',
    lap.max_heartrate ?? '',
    lap.average_cadence ?? '',
    lap.average_watts ?? '',
    lap.total_elevation_gain ?? '',
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Laps!A1',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
  markWritten('Laps', activityId);
}

async function appendSplitSheet(sheetTitle, splitKey, paceLabel, rows) {
  const sheets = getClient();

  const headers = [
    'activity_id', 'activity_name',
    'run_date', 'session_distance_m', 'session_moving_time_s', 'session_elapsed_time_s',
    'session_elev_gain_m', 'session_avg_hr', 'session_max_hr',
    splitKey, 'distance_m', 'elapsed_time_s',
    'pace', paceLabel, 'grade_adj_pace',
    'avg_hr', 'avg_grade_pct', 'elev_gain_m', 'elev_loss_m',
  ];

  await ensureSheet(sheets, sheetTitle, headers);

  if (!rows.length) return;
  const written = await getWrittenActivityIds(sheets, sheetTitle);
  if (written.has(String(rows[0].activity_id))) return;

  const values = rows.map((r) =>
    headers.map((h) => {
      if (h === paceLabel) return r.pace_raw ?? '';
      if (h === splitKey) return r[splitKey] ?? '';
      return r[h] ?? '';
    }),
  );

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetTitle}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
  markWritten(sheetTitle, rows[0].activity_id);
}

/** @param {Array<Object>} rows  Output of analyzeKmSplits() */
export async function appendKmSplits(rows) {
  return appendSplitSheet('KM Splits', 'km', 'pace_min_km', rows);
}

/** @param {Array<Object>} rows  Output of analyzeMileSplits() */
export async function appendMileSplits(rows) {
  return appendSplitSheet('Mile Splits', 'mile', 'pace_min_mile', rows);
}

/**
 * Append analyzed lap rows (pace, HR, grade) to the "Segment Analysis" sheet.
 * @param {Array<Object>} rows  Output of analyzeLaps()
 */
export async function appendSegmentAnalysis(rows) {
  const sheets = getClient();

  const headers = [
    'activity_id', 'activity_name',
    'run_date', 'session_distance_m', 'session_moving_time_s', 'session_elapsed_time_s',
    'session_elev_gain_m', 'session_avg_hr', 'session_max_hr',
    'lap', 'lap_name', 'distance_m', 'elapsed_time_s', 'moving_time_s',
    'pace', 'pace_min_km', 'grade_adj_pace',
    'avg_hr', 'max_hr',
    'avg_grade_pct', 'elev_gain_m', 'elev_loss_m',
  ];

  await ensureSheet(sheets, 'Segment Analysis', headers);

  if (!rows.length) return;
  const written = await getWrittenActivityIds(sheets, 'Segment Analysis');
  if (written.has(String(rows[0].activity_id))) return;

  const values = rows.map((r) => headers.map((h) => r[h] ?? ''));

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Segment Analysis!A1',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
  markWritten('Segment Analysis', rows[0].activity_id);
}

/**
 * Append one row per stream data point to the "Streams" sheet.
 * @param {string|number} activityId
 * @param {string} activityName
 * @param {Object} streams  Keyed by stream type (key_by_type=true)
 */
export async function appendStreams(activityId, activityName, streams) {
  const sheets = getClient();

  const streamKeys = ['time', 'distance', 'heartrate', 'altitude', 'velocity_smooth', 'cadence', 'watts'];
  const headers = ['activity_id', 'activity_name', ...streamKeys];

  await ensureSheet(sheets, 'Streams', headers);

  const written = await getWrittenActivityIds(sheets, 'Streams');
  if (written.has(String(activityId))) return;

  const length = streams[Object.keys(streams)[0]].data.length;
  const rows = Array.from({ length }, (_, i) => [
    activityId,
    activityName,
    ...streamKeys.map((k) => streams[k]?.data[i] ?? ''),
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Streams!A1',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
  markWritten('Streams', activityId);
}
