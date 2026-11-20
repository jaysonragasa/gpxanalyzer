import JSZip from 'jszip';
import FitParser from 'fit-file-parser';
import { computeTrackStats, haversineDistanceM, parseGpx, serializeGpx } from './gpxParser';
import { GpxDocument, TrackPoint } from '../types/gpx';

export interface ArchivePoint {
  lat: number;
  lon: number;
}

export interface ArchiveActivity {
  id: string;
  stravaId?: string;
  name: string;
  type: string;
  dateIso: string | null;
  points: ArchivePoint[];
  distanceM: number;
  durationSec: number;
  elevGainM: number;
  maxSpeedKmh: number;
  maxElevationM: number | null;
  maxHeartRate: number | null;
  maxPower: number | null;
  rawGpxText?: string;
}

export interface ArchiveProgress {
  current: number;
  total: number;
  label: string;
}

interface CsvMeta {
  activityId?: string;
  name?: string;
  type?: string;
  dateIso?: string;
  maxHeartRate?: number;
  maxPower?: number;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

function parseActivitiesCsv(csvText: string): Record<string, CsvMeta> {
  const map: Record<string, CsvMeta> = {};
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return map;

  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idxId = headers.indexOf('activity id');
  const idxFile = headers.indexOf('filename');
  const idxName = headers.indexOf('activity name');
  const idxType = headers.indexOf('activity type');
  const idxDate = headers.indexOf('activity date');
  const idxMaxHr = headers.indexOf('max heart rate');
  const idxMaxPwr = headers.indexOf('max power');
  if (idxFile === -1) return map;

  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]);
    const rawFile = cols[idxFile];
    if (!rawFile) continue;
    const norm = rawFile.replace(/\\/g, '/').replace(/^\.\//, '');
    const base = norm.split('/').pop() || norm;
    const parsedDate = idxDate !== -1 && cols[idxDate] ? Date.parse(cols[idxDate]) : NaN;
    const parsedHr = idxMaxHr !== -1 && cols[idxMaxHr] ? parseFloat(cols[idxMaxHr]) : NaN;
    const parsedPwr = idxMaxPwr !== -1 && cols[idxMaxPwr] ? parseFloat(cols[idxMaxPwr]) : NaN;
    const meta: CsvMeta = {
      activityId: idxId !== -1 && cols[idxId] ? cols[idxId].trim() : undefined,
      name: idxName !== -1 ? cols[idxName] : undefined,
      type: idxType !== -1 ? cols[idxType] : undefined,
      dateIso: !Number.isNaN(parsedDate) ? new Date(parsedDate).toISOString() : undefined,
      maxHeartRate: !Number.isNaN(parsedHr) && parsedHr > 0 ? parsedHr : undefined,
      maxPower: !Number.isNaN(parsedPwr) && parsedPwr > 0 ? parsedPwr : undefined,
    };
    map[norm] = meta;
    map[base] = meta;
  }
  return map;
}

async function gunzipToBuffer(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser does not support gzip decompression.');
  }
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

async function gunzipToString(buffer: ArrayBuffer): Promise<string> {
  const ab = await gunzipToBuffer(buffer);
  return new TextDecoder().decode(ab);
}

async function parseFitToGpxDoc(
  buffer: ArrayBuffer,
  fallbackName: string
): Promise<{ doc: GpxDocument; maxHeartRate: number | null; maxPower: number | null }> {
  const parser = new FitParser({
    force: true,
    speedUnit: 'km/h',
    lengthUnit: 'm',
    mode: 'list',
  });
  const parsed = await parser.parseAsync(buffer);
  const records = (parsed as { records?: Array<Record<string, unknown>> }).records || [];
  const points: TrackPoint[] = [];
  let maxHeartRate: number | null = null;
  let maxPower: number | null = null;

  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i];
    const lat = typeof rec.position_lat === 'number' ? rec.position_lat : NaN;
    const lon = typeof rec.position_long === 'number' ? rec.position_long : NaN;
    if (Number.isNaN(lat) || Number.isNaN(lon)) continue;

    if (typeof rec.heart_rate === 'number' && rec.heart_rate > 0 && rec.heart_rate < 250) {
      if (maxHeartRate === null || rec.heart_rate > maxHeartRate) {
        maxHeartRate = rec.heart_rate;
      }
    }
    if (typeof rec.power === 'number' && rec.power > 0 && rec.power < 3000) {
      if (maxPower === null || rec.power > maxPower) {
        maxPower = rec.power;
      }
    }

    const eleRaw =
      typeof rec.enhanced_altitude === 'number'
        ? rec.enhanced_altitude
        : typeof rec.altitude === 'number'
          ? rec.altitude
          : undefined;

    let timeIso: string | undefined;
    if (rec.timestamp instanceof Date && !Number.isNaN(rec.timestamp.getTime())) {
      timeIso = rec.timestamp.toISOString();
    } else if (typeof rec.timestamp === 'string') {
      timeIso = rec.timestamp;
    }

    points.push({
      id: `fit_${i}`,
      lat,
      lon,
      ele: eleRaw !== undefined && !Number.isNaN(eleRaw) ? eleRaw : undefined,
      time: timeIso,
    });
  }

  const sports = (parsed as { sports?: Array<{ sport?: string }> }).sports;
  const sport = sports?.[0]?.sport;

  return {
    doc: {
      metadata: { name: fallbackName, time: points[0]?.time },
      waypoints: [],
      tracks: [
        {
          id: 'fit_trk_1',
          name: fallbackName,
          type: sport,
          segments: [{ id: 'fit_seg_1', points }],
        },
      ],
    },
    maxHeartRate,
    maxPower,
  };
}

function extractXmlMaxHrAndPower(xmlText: string): {
  maxHeartRate: number | null;
  maxPower: number | null;
} {
  let maxHeartRate: number | null = null;
  let maxPower: number | null = null;

  for (const m of xmlText.matchAll(/<(?:gpxtpx:hr|hr|ns3:hr)>(\d+(?:\.\d+)?)<\/(?:gpxtpx:hr|hr|ns3:hr)>/gi)) {
    const v = parseFloat(m[1]);
    if (v > 0 && v < 250 && (maxHeartRate === null || v > maxHeartRate)) maxHeartRate = v;
  }
  for (const m of xmlText.matchAll(/<HeartRateBpm>\s*<Value>(\d+(?:\.\d+)?)<\/Value>\s*<\/HeartRateBpm>/gi)) {
    const v = parseFloat(m[1]);
    if (v > 0 && v < 250 && (maxHeartRate === null || v > maxHeartRate)) maxHeartRate = v;
  }
  for (const m of xmlText.matchAll(/<(?:power|watts|ns3:watts)>(\d+(?:\.\d+)?)<\/(?:power|watts|ns3:watts)>/gi)) {
    const v = parseFloat(m[1]);
    if (v > 0 && v < 3000 && (maxPower === null || v > maxPower)) maxPower = v;
  }

  return { maxHeartRate, maxPower };
}

function parseTcxToGpxDoc(xmlText: string, fallbackName: string): GpxDocument {
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, 'application/xml');
  const points: TrackPoint[] = [];
  const trkpts = xml.getElementsByTagName('Trackpoint');

  for (let i = 0; i < trkpts.length; i += 1) {
    const tp = trkpts[i];
    const latEl = tp.getElementsByTagName('LatitudeDegrees')[0];
    const lonEl = tp.getElementsByTagName('LongitudeDegrees')[0];
    if (!latEl?.textContent || !lonEl?.textContent) continue;

    const lat = parseFloat(latEl.textContent);
    const lon = parseFloat(lonEl.textContent);
    if (Number.isNaN(lat) || Number.isNaN(lon)) continue;

    const eleEl = tp.getElementsByTagName('AltitudeMeters')[0];
    const timeEl = tp.getElementsByTagName('Time')[0];
    const ele = eleEl?.textContent ? parseFloat(eleEl.textContent) : undefined;

    points.push({
      id: `tcx_${i}`,
      lat,
      lon,
      ele: ele !== undefined && !Number.isNaN(ele) ? ele : undefined,
      time: timeEl?.textContent?.trim() || undefined,
    });
  }

  const sportEl = xml.getElementsByTagName('Activity')[0];
  const sport = sportEl?.getAttribute('Sport') || undefined;

  return {
    metadata: { name: fallbackName, time: points[0]?.time },
    waypoints: [],
    tracks: [
      {
        id: 'tcx_trk_1',
        name: fallbackName,
        type: sport,
        segments: [{ id: 'tcx_seg_1', points }],
      },
    ],
  };
}

function downsamplePoints(pts: TrackPoint[], maxCount = 260): ArchivePoint[] {
  if (pts.length <= maxCount) {
    return pts.map((p) => ({ lat: p.lat, lon: p.lon }));
  }
  const out: ArchivePoint[] = [];
  const step = (pts.length - 1) / (maxCount - 1);
  for (let i = 0; i < maxCount; i += 1) {
    const p = pts[Math.round(i * step)];
    out.push({ lat: p.lat, lon: p.lon });
  }
  return out;
}

export async function parseStravaArchiveZip(
  file: File,
  onProgress: (progress: ArchiveProgress) => void
): Promise<ArchiveActivity[]> {
  onProgress({ current: 0, total: 1, label: 'Reading ZIP archive...' });
  const zip = await JSZip.loadAsync(file);

  const csvEntry = zip.file(/(^|\/)activities\.csv$/i)[0];
  const csvMap = csvEntry ? parseActivitiesCsv(await csvEntry.async('string')) : {};

  const activityFiles = Object.values(zip.files).filter((entry) => {
    if (entry.dir) return false;
    const lower = entry.name.toLowerCase();
    return (
      lower.endsWith('.gpx') ||
      lower.endsWith('.gpx.gz') ||
      lower.endsWith('.tcx') ||
      lower.endsWith('.tcx.gz') ||
      lower.endsWith('.fit') ||
      lower.endsWith('.fit.gz')
    );
  });

  if (activityFiles.length === 0) {
    throw new Error(
      'No .gpx, .tcx, or .fit activity files were found in this ZIP. Please upload a valid Strava export archive.'
    );
  }

  const activities: ArchiveActivity[] = [];
  const total = activityFiles.length;

  for (let i = 0; i < total; i += 1) {
    const entry = activityFiles[i];
    const shortName = entry.name.split('/').pop() || entry.name;
    onProgress({
      current: i + 1,
      total,
      label: `Parsing ${shortName} (${i + 1}/${total})`,
    });

    if (i % 8 === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }

    try {
      const lower = entry.name.toLowerCase();
      const isGpx = lower.endsWith('.gpx') || lower.endsWith('.gpx.gz');
      const isFit = lower.endsWith('.fit') || lower.endsWith('.fit.gz');

      let doc: GpxDocument;
      let rawGpxText: string | undefined;
      let fileMaxHr: number | null = null;
      let fileMaxPower: number | null = null;

      if (isFit) {
        const rawBuf = await entry.async('arraybuffer');
        const fitBuf = lower.endsWith('.gz') ? await gunzipToBuffer(rawBuf) : rawBuf;
        const fitRes = await parseFitToGpxDoc(fitBuf, shortName);
        doc = fitRes.doc;
        fileMaxHr = fitRes.maxHeartRate;
        fileMaxPower = fitRes.maxPower;
        rawGpxText = serializeGpx(doc);
      } else {
        const text = lower.endsWith('.gz')
          ? await gunzipToString(await entry.async('arraybuffer'))
          : await entry.async('string');
        doc = isGpx ? parseGpx(text) : parseTcxToGpxDoc(text, shortName);
        const xmlMetrics = extractXmlMaxHrAndPower(text);
        fileMaxHr = xmlMetrics.maxHeartRate;
        fileMaxPower = xmlMetrics.maxPower;
        rawGpxText = isGpx ? text : serializeGpx(doc);
      }

      const track = doc.tracks[0];
      if (!track) continue;

      const allPts = track.segments.flatMap((s) => s.points);
      if (allPts.length < 2) continue;

      const stats = computeTrackStats(track);
      const normPath = entry.name.replace(/\\/g, '/').replace(/^\.\//, '');
      const csvMeta = csvMap[normPath] || csvMap[shortName];

      // Compute fallback distance if needed
      let distanceM = stats.totalDistanceM;
      if (distanceM === 0 && allPts.length > 1) {
        for (let k = 1; k < allPts.length; k += 1) {
          distanceM += haversineDistanceM(
            allPts[k - 1].lat,
            allPts[k - 1].lon,
            allPts[k].lat,
            allPts[k].lon
          );
        }
      }

      // Filter obvious GPS teleportation spikes (>= 130 km/h) for archive summary
      let cleanMaxSpeed = 0;
      for (const ps of stats.pointStats) {
        if (ps.speedKmh < 130 && ps.speedKmh > cleanMaxSpeed) {
          cleanMaxSpeed = ps.speedKmh;
        }
      }

      activities.push({
        id: `act_${i}_${shortName}`,
        stravaId: csvMeta?.activityId,
        name: csvMeta?.name || track.name || doc.metadata.name || shortName,
        type: csvMeta?.type || track.type || 'Activity',
        dateIso: stats.startTime || csvMeta?.dateIso || doc.metadata.time || null,
        points: downsamplePoints(allPts),
        distanceM,
        durationSec: stats.movingDurationSec > 0 ? stats.movingDurationSec : stats.totalDurationSec,
        elevGainM: stats.elevationGainM,
        maxSpeedKmh: cleanMaxSpeed,
        maxElevationM: stats.maxElevationM,
        maxHeartRate: fileMaxHr ?? csvMeta?.maxHeartRate ?? null,
        maxPower: fileMaxPower ?? csvMeta?.maxPower ?? null,
        rawGpxText,
      });
    } catch {
      // Skip malformed individual activity files without failing the whole archive
    }
  }

  if (activities.length === 0) {
    throw new Error('Found activity files in the ZIP, but none contained valid GPS coordinates.');
  }

  activities.sort((a, b) => {
    const ta = a.dateIso ? Date.parse(a.dateIso) : 0;
    const tb = b.dateIso ? Date.parse(b.dateIso) : 0;
    return tb - ta;
  });

  return activities;
}
