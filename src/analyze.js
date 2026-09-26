/**
 * Compute per-lap pace, HR, and grade metrics from laps + streams.
 *
 * Strava laps include start_index and end_index that map into stream arrays,
 * so we slice each stream by those bounds for accurate per-lap stats.
 */

function mean(arr) {
  const clean = arr.filter((v) => v != null && !isNaN(v));
  return clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
}

function mpsToMinPerKm(mps) {
  if (!mps || mps === 0) return null;
  return 1000 / mps / 60;
}

function mpsToMinPerMile(mps) {
  if (!mps || mps === 0) return null;
  return 1609.344 / mps / 60;
}

function fmtPace(minPerKm) {
  if (minPerKm == null) return '';
  const mins = Math.floor(minPerKm);
  const secs = Math.round((minPerKm - mins) * 60);
  return `${mins}.${String(secs).padStart(2, '0')}`;
}

/**
 * Compute grade (%) point-by-point within a stream slice, then average.
 * More accurate than simple start/end delta for hilly segments.
 */
function avgGrade(altSlice, distSlice) {
  if (!altSlice || !distSlice || altSlice.length < 2) return null;
  const grades = [];
  for (let i = 1; i < altSlice.length; i++) {
    const dDist = distSlice[i] - distSlice[i - 1];
    if (dDist > 0) {
      grades.push(((altSlice[i] - altSlice[i - 1]) / dDist) * 100);
    }
  }
  return mean(grades);
}

/**
 * Grade-adjusted pace using a standard running effort curve.
 * Adds ~8 sec/km per 1% uphill grade, removes ~5 sec/km per 1% downhill.
 */
function gradeAdjustedPace(paceMinKm, gradePct) {
  if (paceMinKm == null || gradePct == null) return null;
  const adjust = gradePct > 0 ? gradePct * (8 / 60) : gradePct * (5 / 60);
  return paceMinKm - adjust;
}

function sessionFields(activity) {
  return {
    run_date: activity.start_date_local?.slice(0, 10) ?? '',
    session_distance_m: activity.distance != null ? Math.round(activity.distance) : '',
    session_moving_time_s: activity.moving_time ?? '',
    session_elapsed_time_s: activity.elapsed_time ?? '',
    session_elev_gain_m: activity.total_elevation_gain != null ? +activity.total_elevation_gain.toFixed(1) : '',
    session_avg_hr: activity.average_heartrate != null ? +activity.average_heartrate.toFixed(1) : '',
    session_max_hr: activity.max_heartrate ?? '',
  };
}

function analyzeSplits(activity, streams, intervalM, paceConverter, splitLabel) {
  const dist = streams.distance?.data;
  const alt = streams.altitude?.data;
  const hr = streams.heartrate?.data;
  const vel = streams.velocity_smooth?.data;
  const time = streams.time?.data;

  if (!dist || dist.length < 2) return [];

  const totalDist = dist[dist.length - 1];
  const numSplits = Math.ceil(totalDist / intervalM);
  const results = [];

  for (let i = 0; i < numSplits; i++) {
    const fromM = i * intervalM;
    const toM = Math.min((i + 1) * intervalM, totalDist);

    const s = dist.findIndex((d) => d >= fromM);
    let e = dist.findIndex((d) => d >= toM);
    if (e === -1) e = dist.length - 1;

    const altSlice = alt?.slice(s, e + 1);
    const distSlice = dist.slice(s, e + 1);
    const hrSlice = hr?.slice(s, e + 1);
    const velSlice = vel?.slice(s, e + 1);
    const timeSlice = time?.slice(s, e + 1);

    const avgVel = velSlice ? mean(velSlice) : null;
    const pace = paceConverter(avgVel);
    const avgHr = hrSlice ? mean(hrSlice) : null;
    const grade = avgGrade(altSlice, distSlice);
    const gap = gradeAdjustedPace(pace, grade);
    const elapsedS = timeSlice ? timeSlice[timeSlice.length - 1] - timeSlice[0] : null;
    const elevGain = altSlice
      ? altSlice.reduce((sum, v, j) => (j > 0 && v > altSlice[j - 1] ? sum + v - altSlice[j - 1] : sum), 0)
      : null;
    const elevLoss = altSlice
      ? altSlice.reduce((sum, v, j) => (j > 0 && v < altSlice[j - 1] ? sum + altSlice[j - 1] - v : sum), 0)
      : null;

    results.push({
      activity_id: activity.id,
      activity_name: activity.name,
      ...sessionFields(activity),
      [splitLabel]: i + 1,
      distance_m: Math.round(toM - fromM),
      elapsed_time_s: elapsedS != null ? Math.round(elapsedS) : '',
      pace: fmtPace(pace),
      pace_raw: pace != null ? +pace.toFixed(3) : '',
      grade_adj_pace: fmtPace(gap),
      avg_hr: avgHr != null ? +avgHr.toFixed(1) : '',
      avg_grade_pct: grade != null ? +grade.toFixed(2) : '',
      elev_gain_m: elevGain != null ? +elevGain.toFixed(1) : '',
      elev_loss_m: elevLoss != null ? +elevLoss.toFixed(1) : '',
    });
  }

  return results;
}

/**
 * Split streams into 1km segments.
 * Pace expressed in min/km.
 */
export function analyzeKmSplits(activity, streams) {
  return analyzeSplits(activity, streams, 1000, mpsToMinPerKm, 'km');
}

/**
 * Split streams into 1-mile segments.
 * Pace expressed in min/mile.
 */
export function analyzeMileSplits(activity, streams) {
  return analyzeSplits(activity, streams, 1609.344, mpsToMinPerMile, 'mile');
}

/**
 * @param {Object} activity   Strava activity object
 * @param {Array} laps        From /activities/:id/laps
 * @param {Object} streams    key_by_type=true response from /activities/:id/streams
 * @returns {Array<Object>}   One row per lap
 */
export function analyzeLaps(activity, laps, streams) {
  const activityId = activity.id;
  const activityName = activity.name;
  const alt = streams.altitude?.data;
  const dist = streams.distance?.data;
  const hr = streams.heartrate?.data;
  const vel = streams.velocity_smooth?.data;

  return laps.map((lap) => {
    const s = lap.start_index;
    const e = lap.end_index;

    const altSlice = alt?.slice(s, e + 1);
    const distSlice = dist?.slice(s, e + 1);
    const hrSlice = hr?.slice(s, e + 1);
    const velSlice = vel?.slice(s, e + 1);

    const avgVel = velSlice ? mean(velSlice) : lap.average_speed;
    const pace = mpsToMinPerKm(avgVel);
    const avgHr = hrSlice ? mean(hrSlice) : lap.average_heartrate;
    const grade = avgGrade(altSlice, distSlice);
    const gap = gradeAdjustedPace(pace, grade);
    const elevGain = altSlice
      ? altSlice.reduce((sum, v, i) => (i > 0 && v > altSlice[i - 1] ? sum + v - altSlice[i - 1] : sum), 0)
      : lap.total_elevation_gain;
    const elevLoss = altSlice
      ? altSlice.reduce((sum, v, i) => (i > 0 && v < altSlice[i - 1] ? sum + altSlice[i - 1] - v : sum), 0)
      : null;

    return {
      activity_id: activityId,
      activity_name: activityName,
      ...sessionFields(activity),
      lap: lap.lap_index,
      lap_name: lap.name,
      distance_m: Math.round(lap.distance),
      elapsed_time_s: lap.elapsed_time,
      moving_time_s: lap.moving_time,
      pace: fmtPace(pace),
      pace_min_km: pace != null ? +pace.toFixed(3) : '',
      grade_adj_pace: fmtPace(gap),
      avg_hr: avgHr != null ? +avgHr.toFixed(1) : '',
      max_hr: lap.max_heartrate ?? '',
      avg_grade_pct: grade != null ? +grade.toFixed(2) : '',
      elev_gain_m: elevGain != null ? +elevGain.toFixed(1) : '',
      elev_loss_m: elevLoss != null ? +elevLoss.toFixed(1) : '',
    };
  });
}
