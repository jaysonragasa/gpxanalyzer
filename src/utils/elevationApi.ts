import { TrackPoint } from '../types/gpx';

const OPEN_METEO_ELEVATION_URL = 'https://api.open-meteo.com/v1/elevation';
const OPEN_ELEVATION_URL = 'https://api.open-elevation.com/api/v1/lookup';
const MAX_SAMPLE_POINTS = 150;
const BATCH_SIZE = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchOpenMeteoBatch(batchPts: TrackPoint[]): Promise<number[]> {
  const lats = batchPts.map((p) => p.lat.toFixed(5)).join(',');
  const lons = batchPts.map((p) => p.lon.toFixed(5)).join(',');
  const url = `${OPEN_METEO_ELEVATION_URL}?latitude=${lats}&longitude=${lons}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Open-Meteo HTTP ${res.status}`);
  }
  const data = (await res.json()) as { elevation?: number[] };
  if (!Array.isArray(data.elevation) || data.elevation.length !== batchPts.length) {
    throw new Error('Unexpected response from Open-Meteo');
  }
  return data.elevation;
}

async function fetchOpenElevationBatch(batchPts: TrackPoint[]): Promise<number[]> {
  const res = await fetch(OPEN_ELEVATION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      locations: batchPts.map((p) => ({
        latitude: Number(p.lat.toFixed(5)),
        longitude: Number(p.lon.toFixed(5)),
      })),
    }),
  });
  if (!res.ok) {
    throw new Error(`Open-Elevation HTTP ${res.status}`);
  }
  const data = (await res.json()) as { results?: Array<{ elevation: number }> };
  if (!Array.isArray(data.results) || data.results.length !== batchPts.length) {
    throw new Error('Unexpected response from Open-Elevation');
  }
  return data.results.map((r) => r.elevation);
}

/**
 * Fetches real terrain elevation (DEM) for the given trackpoints' (lat, lon) coordinates.
 * Samples up to 150 points in small batches (with retry & fallback) and linearly interpolates in between.
 */
export async function fetchTerrainElevations(
  points: TrackPoint[]
): Promise<Record<string, number>> {
  if (points.length === 0) return {};

  const sampleIndices: number[] = [];
  if (points.length <= MAX_SAMPLE_POINTS) {
    for (let i = 0; i < points.length; i += 1) sampleIndices.push(i);
  } else {
    const step = (points.length - 1) / (MAX_SAMPLE_POINTS - 1);
    for (let i = 0; i < MAX_SAMPLE_POINTS; i += 1) {
      const idx = Math.round(i * step);
      if (sampleIndices.length === 0 || sampleIndices[sampleIndices.length - 1] !== idx) {
        sampleIndices.push(idx);
      }
    }
    if (sampleIndices[sampleIndices.length - 1] !== points.length - 1) {
      sampleIndices.push(points.length - 1);
    }
  }

  const sampledElevations: number[] = [];
  for (let start = 0; start < sampleIndices.length; start += BATCH_SIZE) {
    if (start > 0) await sleep(150);
    const batch = sampleIndices.slice(start, start + BATCH_SIZE).map((idx) => points[idx]);

    let elevations: number[] | null = null;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        elevations = await fetchOpenMeteoBatch(batch);
        break;
      } catch (err) {
        lastError = err;
        await sleep(300);
      }
    }

    if (!elevations) {
      try {
        elevations = await fetchOpenElevationBatch(batch);
      } catch (fallbackErr) {
        throw new Error(
          `Elevation lookup failed: ${
            lastError instanceof Error ? lastError.message : 'Network error'
          } (fallback: ${
            fallbackErr instanceof Error ? fallbackErr.message : 'Network error'
          })`
        );
      }
    }

    sampledElevations.push(...elevations);
  }

  const result: Record<string, number> = {};
  for (let s = 0; s < sampleIndices.length; s += 1) {
    const idxA = sampleIndices[s];
    const eleA = sampledElevations[s];
    result[points[idxA].id] = eleA;

    if (s < sampleIndices.length - 1) {
      const idxB = sampleIndices[s + 1];
      const eleB = sampledElevations[s + 1];
      const span = idxB - idxA;
      for (let k = 1; k < span; k += 1) {
        const frac = k / span;
        result[points[idxA + k].id] = Number((eleA + (eleB - eleA) * frac).toFixed(2));
      }
    }
  }

  return result;
}
