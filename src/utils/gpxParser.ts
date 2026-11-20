import {
  ComputedPointStats,
  GpxDocument,
  GpxMetadata,
  GpxTrack,
  TrackPoint,
  TrackSegment,
  TrackStats,
  Waypoint,
} from '../types/gpx';

let idCounter = 1;
export function nextId(prefix = 'id'): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

function getChildText(parent: Element, tagName: string): string | undefined {
  for (let i = 0; i < parent.children.length; i += 1) {
    const child = parent.children[i];
    if (child.localName === tagName || child.tagName === tagName) {
      const txt = child.textContent?.trim();
      return txt ? txt : undefined;
    }
  }
  return undefined;
}

function getChildElement(parent: Element, tagName: string): Element | undefined {
  for (let i = 0; i < parent.children.length; i += 1) {
    const child = parent.children[i];
    if (child.localName === tagName || child.tagName === tagName) {
      return child;
    }
  }
  return undefined;
}

function parsePointElement(el: Element, prefix: string): TrackPoint {
  const lat = parseFloat(el.getAttribute('lat') || '0');
  const lon = parseFloat(el.getAttribute('lon') || '0');
  const eleStr = getChildText(el, 'ele');
  const ele = eleStr !== undefined && !Number.isNaN(parseFloat(eleStr)) ? parseFloat(eleStr) : undefined;
  const time = getChildText(el, 'time');
  const name = getChildText(el, 'name');
  const desc = getChildText(el, 'desc');

  const extEl = getChildElement(el, 'extensions');
  let extensionsXml: string | undefined;
  if (extEl) {
    const serializer = new XMLSerializer();
    extensionsXml = serializer.serializeToString(extEl);
  }

  return {
    id: nextId(prefix),
    lat,
    lon,
    ele,
    time,
    name,
    desc,
    extensionsXml,
  };
}

export function parseGpx(xmlText: string): GpxDocument {
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, 'application/xml');
  const parseError = xml.querySelector('parsererror');
  if (parseError) {
    throw new Error('Invalid GPX/XML file: ' + (parseError.textContent || 'Parse error'));
  }

  const gpxEl = xml.documentElement;
  if (!gpxEl || gpxEl.localName !== 'gpx') {
    throw new Error('Not a valid GPX file (missing <gpx> root element).');
  }

  const metadata: GpxMetadata = {
    creator: gpxEl.getAttribute('creator') || undefined,
  };

  const metaEl = getChildElement(gpxEl, 'metadata');
  if (metaEl) {
    metadata.name = getChildText(metaEl, 'name');
    metadata.desc = getChildText(metaEl, 'desc');
    metadata.time = getChildText(metaEl, 'time');
    const authorEl = getChildElement(metaEl, 'author');
    if (authorEl) {
      metadata.authorName = getChildText(authorEl, 'name');
    }
  } else {
    // GPX 1.0 fallback
    metadata.name = getChildText(gpxEl, 'name');
    metadata.desc = getChildText(gpxEl, 'desc');
    metadata.time = getChildText(gpxEl, 'time');
    metadata.authorName = getChildText(gpxEl, 'author');
  }

  const waypoints: Waypoint[] = [];
  const tracks: GpxTrack[] = [];

  for (let i = 0; i < gpxEl.children.length; i += 1) {
    const child = gpxEl.children[i];
    if (child.localName === 'wpt') {
      const pt = parsePointElement(child, 'wpt');
      waypoints.push({
        id: pt.id,
        lat: pt.lat,
        lon: pt.lon,
        ele: pt.ele,
        time: pt.time,
        name: pt.name,
        desc: pt.desc,
        sym: getChildText(child, 'sym'),
      });
    } else if (child.localName === 'trk') {
      const trkName = getChildText(child, 'name') || `Track ${tracks.length + 1}`;
      const trkDesc = getChildText(child, 'desc');
      const trkType = getChildText(child, 'type');
      const segments: TrackSegment[] = [];

      for (let j = 0; j < child.children.length; j += 1) {
        const segEl = child.children[j];
        if (segEl.localName === 'trkseg') {
          const points: TrackPoint[] = [];
          for (let k = 0; k < segEl.children.length; k += 1) {
            const ptEl = segEl.children[k];
            if (ptEl.localName === 'trkpt') {
              points.push(parsePointElement(ptEl, 'pt'));
            }
          }
          segments.push({
            id: nextId('seg'),
            points,
          });
        }
      }

      tracks.push({
        id: nextId('trk'),
        name: trkName,
        desc: trkDesc,
        type: trkType,
        segments: segments.length > 0 ? segments : [{ id: nextId('seg'), points: [] }],
      });
    } else if (child.localName === 'rte') {
      // Support GPX routes by converting <rte> into a track
      const rteName = getChildText(child, 'name') || `Route ${tracks.length + 1}`;
      const rteDesc = getChildText(child, 'desc');
      const points: TrackPoint[] = [];
      for (let j = 0; j < child.children.length; j += 1) {
        const ptEl = child.children[j];
        if (ptEl.localName === 'rtept') {
          points.push(parsePointElement(ptEl, 'pt'));
        }
      }
      tracks.push({
        id: nextId('trk'),
        name: rteName,
        desc: rteDesc,
        segments: [{ id: nextId('seg'), points }],
      });
    }
  }

  return { metadata, waypoints, tracks };
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function serializeGpx(doc: GpxDocument): string {
  const lines: string[] = [];
  const creator = escapeXml(doc.metadata.creator || 'GPX Analyzer & Editor');
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<gpx version="1.1" creator="${creator}" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd http://www.garmin.com/xmlschemas/TrackPointExtension/v1 http://www.garmin.com/xmlschemas/TrackPointExtensionv1.xsd">`
  );

  // Metadata
  const { name, desc, authorName, time } = doc.metadata;
  if (name || desc || authorName || time) {
    lines.push('  <metadata>');
    if (name) lines.push(`    <name>${escapeXml(name)}</name>`);
    if (desc) lines.push(`    <desc>${escapeXml(desc)}</desc>`);
    if (authorName) {
      lines.push('    <author>');
      lines.push(`      <name>${escapeXml(authorName)}</name>`);
      lines.push('    </author>');
    }
    if (time) lines.push(`    <time>${escapeXml(time)}</time>`);
    lines.push('  </metadata>');
  }

  // Waypoints
  for (const wpt of doc.waypoints) {
    lines.push(`  <wpt lat="${wpt.lat.toFixed(7)}" lon="${wpt.lon.toFixed(7)}">`);
    if (wpt.ele !== undefined) lines.push(`    <ele>${wpt.ele.toFixed(2)}</ele>`);
    if (wpt.time) lines.push(`    <time>${escapeXml(wpt.time)}</time>`);
    if (wpt.name) lines.push(`    <name>${escapeXml(wpt.name)}</name>`);
    if (wpt.desc) lines.push(`    <desc>${escapeXml(wpt.desc)}</desc>`);
    if (wpt.sym) lines.push(`    <sym>${escapeXml(wpt.sym)}</sym>`);
    lines.push('  </wpt>');
  }

  // Tracks
  for (const trk of doc.tracks) {
    lines.push('  <trk>');
    if (trk.name) lines.push(`    <name>${escapeXml(trk.name)}</name>`);
    if (trk.desc) lines.push(`    <desc>${escapeXml(trk.desc)}</desc>`);
    if (trk.type) lines.push(`    <type>${escapeXml(trk.type)}</type>`);
    for (const seg of trk.segments) {
      lines.push('    <trkseg>');
      for (const pt of seg.points) {
        lines.push(`      <trkpt lat="${pt.lat.toFixed(7)}" lon="${pt.lon.toFixed(7)}">`);
        if (pt.ele !== undefined) lines.push(`        <ele>${pt.ele.toFixed(2)}</ele>`);
        if (pt.time) lines.push(`        <time>${escapeXml(pt.time)}</time>`);
        if (pt.name) lines.push(`        <name>${escapeXml(pt.name)}</name>`);
        if (pt.desc) lines.push(`        <desc>${escapeXml(pt.desc)}</desc>`);
        if (pt.extensionsXml) lines.push(`        ${pt.extensionsXml}`);
        lines.push('      </trkpt>');
      }
      lines.push('    </trkseg>');
    }
    lines.push('  </trk>');
  }

  lines.push('</gpx>');
  return lines.join('\n');
}

export function haversineDistanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function computeBearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function getGoogleStreetViewUrl(points: TrackPoint[], pointId: string): string | null {
  const idx = points.findIndex((p) => p.id === pointId);
  if (idx === -1) return null;
  const pt = points[idx];
  let heading = 0;
  if (idx < points.length - 1) {
    const next = points[idx + 1];
    heading = computeBearingDeg(pt.lat, pt.lon, next.lat, next.lon);
  } else if (idx > 0) {
    const prev = points[idx - 1];
    heading = computeBearingDeg(prev.lat, prev.lon, pt.lat, pt.lon);
  }
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${pt.lat.toFixed(
    6
  )},${pt.lon.toFixed(6)}&heading=${Math.round(heading)}`;
}

export function computeTrackStats(track: GpxTrack | undefined): TrackStats {
  const empty: TrackStats = {
    totalPoints: 0,
    totalDistanceM: 0,
    totalDurationSec: 0,
    movingDurationSec: 0,
    avgSpeedKmh: 0,
    movingAvgSpeedKmh: 0,
    maxSpeedKmh: 0,
    elevationGainM: 0,
    elevationLossM: 0,
    minElevationM: null,
    maxElevationM: null,
    startTime: null,
    endTime: null,
    pointStats: [],
  };

  if (!track) return empty;
  const allPoints = track.segments.flatMap((s) => s.points);
  if (allPoints.length === 0) return empty;

  let cumulativeDistanceM = 0;
  let movingDurationSec = 0;
  let maxSpeedKmh = 0;
  let elevationGainM = 0;
  let elevationLossM = 0;
  let minElevationM: number | null = null;
  let maxElevationM: number | null = null;

  const pointStats: ComputedPointStats[] = [];

  for (let i = 0; i < allPoints.length; i += 1) {
    const pt = allPoints[i];
    if (pt.ele !== undefined) {
      if (minElevationM === null || pt.ele < minElevationM) minElevationM = pt.ele;
      if (maxElevationM === null || pt.ele > maxElevationM) maxElevationM = pt.ele;
    }

    let segmentDistanceM = 0;
    let segmentDurationSec = 0;
    let speedKmh = 0;
    let gradePct = 0;

    if (i > 0) {
      const prev = allPoints[i - 1];
      segmentDistanceM = haversineDistanceM(prev.lat, prev.lon, pt.lat, pt.lon);
      cumulativeDistanceM += segmentDistanceM;

      if (prev.time && pt.time) {
        const t1 = Date.parse(prev.time);
        const t2 = Date.parse(pt.time);
        if (!Number.isNaN(t1) && !Number.isNaN(t2) && t2 > t1) {
          segmentDurationSec = (t2 - t1) / 1000;
          speedKmh = (segmentDistanceM / segmentDurationSec) * 3.6;
          // Filter GPS speed spikes (> 120 km/h) only for moving stats if unreasonable? Keep raw max up to 250 km/h
          if (speedKmh > 0.8 && speedKmh < 250) {
            movingDurationSec += segmentDurationSec;
          }
          if (speedKmh > maxSpeedKmh && speedKmh < 250) {
            maxSpeedKmh = speedKmh;
          }
        }
      }

      if (prev.ele !== undefined && pt.ele !== undefined) {
        const dEle = pt.ele - prev.ele;
        if (dEle > 0) elevationGainM += dEle;
        else elevationLossM += Math.abs(dEle);

        if (segmentDistanceM > 1) {
          gradePct = (dEle / segmentDistanceM) * 100;
        }
      }
    }

    pointStats.push({
      index: i,
      point: pt,
      cumulativeDistanceM,
      segmentDistanceM,
      segmentDurationSec,
      speedKmh,
      gradePct,
    });
  }

  let startTime: string | null = null;
  let endTime: string | null = null;
  for (const pt of allPoints) {
    if (pt.time) {
      if (!startTime) startTime = pt.time;
      endTime = pt.time;
    }
  }

  let totalDurationSec = 0;
  if (startTime && endTime) {
    const t1 = Date.parse(startTime);
    const t2 = Date.parse(endTime);
    if (!Number.isNaN(t1) && !Number.isNaN(t2) && t2 >= t1) {
      totalDurationSec = (t2 - t1) / 1000;
    }
  }

  const avgSpeedKmh = totalDurationSec > 0 ? (cumulativeDistanceM / totalDurationSec) * 3.6 : 0;
  const movingAvgSpeedKmh = movingDurationSec > 0 ? (cumulativeDistanceM / movingDurationSec) * 3.6 : 0;

  return {
    totalPoints: allPoints.length,
    totalDistanceM: cumulativeDistanceM,
    totalDurationSec,
    movingDurationSec,
    avgSpeedKmh,
    movingAvgSpeedKmh,
    maxSpeedKmh,
    elevationGainM,
    elevationLossM,
    minElevationM,
    maxElevationM,
    startTime,
    endTime,
    pointStats,
  };
}

export function shiftDocumentTime(doc: GpxDocument, offsetMs: number): GpxDocument {
  const shiftIso = (iso?: string): string | undefined => {
    if (!iso) return undefined;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return iso;
    return toStravaIso(ms + offsetMs);
  };

  return {
    ...doc,
    metadata: {
      ...doc.metadata,
      time: shiftIso(doc.metadata.time),
    },
    waypoints: doc.waypoints.map((w) => ({ ...w, time: shiftIso(w.time) })),
    tracks: doc.tracks.map((t) => ({
      ...t,
      segments: t.segments.map((s) => ({
        ...s,
        points: s.points.map((p) => ({ ...p, time: shiftIso(p.time) })),
      })),
    })),
  };
}

export function setTrackStartTime(
  doc: GpxDocument,
  trackId: string,
  newStartIso: string,
  fallbackSpeedKmh = 15
): GpxDocument {
  const targetMs = Date.parse(newStartIso);
  if (Number.isNaN(targetMs)) return doc;

  const targetTrack = doc.tracks.find((t) => t.id === trackId);
  if (!targetTrack) return doc;

  const firstTimePt = targetTrack.segments.flatMap((s) => s.points).find((p) => p.time && !Number.isNaN(Date.parse(p.time)));

  if (firstTimePt && firstTimePt.time) {
    const oldStartMs = Date.parse(firstTimePt.time);
    const shifted = shiftDocumentTime(doc, targetMs - oldStartMs);
    return {
      ...shifted,
      metadata: {
        ...shifted.metadata,
        time: toStravaIso(targetMs),
      },
    };
  }

  // No existing timestamps: synthesize timestamps based on distance and fallbackSpeedKmh
  const speedMs = Math.max(0.5, (fallbackSpeedKmh * 1000) / 3600);
  let currentMs = targetMs;
  let prevPt: TrackPoint | null = null;

  return {
    ...doc,
    metadata: {
      ...doc.metadata,
      time: toStravaIso(targetMs),
    },
    tracks: doc.tracks.map((t) => {
      if (t.id !== trackId) return t;
      return {
        ...t,
        segments: t.segments.map((s) => ({
          ...s,
          points: s.points.map((p) => {
            if (prevPt) {
              const dist = haversineDistanceM(prevPt.lat, prevPt.lon, p.lat, p.lon);
              currentMs += Math.max(1000, Math.round((dist / speedMs) * 1000));
            }
            prevPt = p;
            return {
              ...p,
              time: toStravaIso(currentMs),
            };
          }),
        })),
      };
    }),
  };
}

function interpolatePoint(prev: TrackPoint, curr: TrackPoint, next: TrackPoint): TrackPoint {
  let ratio = 0.5;
  if (prev.time && curr.time && next.time) {
    const t0 = Date.parse(prev.time);
    const t1 = Date.parse(curr.time);
    const t2 = Date.parse(next.time);
    if (!Number.isNaN(t0) && !Number.isNaN(t1) && !Number.isNaN(t2) && t2 > t0) {
      const clamped = Math.max(t0, Math.min(t2, t1));
      ratio = (clamped - t0) / (t2 - t0);
    }
  }

  const lat = prev.lat + (next.lat - prev.lat) * ratio;
  const lon = prev.lon + (next.lon - prev.lon) * ratio;
  const ele =
    prev.ele !== undefined && next.ele !== undefined
      ? prev.ele + (next.ele - prev.ele) * ratio
      : curr.ele;

  let time = curr.time;
  if (prev.time && next.time) {
    const t0 = Date.parse(prev.time);
    const t2 = Date.parse(next.time);
    if (!Number.isNaN(t0) && !Number.isNaN(t2) && t2 >= t0) {
      time = new Date(t0 + (t2 - t0) * ratio).toISOString();
    }
  }

  return { ...curr, lat, lon, ele, time };
}

export function smoothTrackPoint(doc: GpxDocument, trackId: string, pointId: string): GpxDocument {
  return {
    ...doc,
    tracks: doc.tracks.map((trk) => {
      if (trk.id !== trackId) return trk;
      return {
        ...trk,
        segments: trk.segments.map((seg) => {
          const idx = seg.points.findIndex((p) => p.id === pointId);
          if (idx <= 0 || idx >= seg.points.length - 1) return seg;
          const nextPts = [...seg.points];
          nextPts[idx] = interpolatePoint(seg.points[idx - 1], seg.points[idx], seg.points[idx + 1]);
          return { ...seg, points: nextPts };
        }),
      };
    }),
  };
}

export function fixSpeedSpikes(
  doc: GpxDocument,
  trackId: string,
  maxSpeedKmh: number,
  mode: 'interpolate' | 'remove'
): { doc: GpxDocument; fixedCount: number } {
  let fixedCount = 0;

  const updatedDoc: GpxDocument = {
    ...doc,
    tracks: doc.tracks.map((trk) => {
      if (trk.id !== trackId) return trk;
      return {
        ...trk,
        segments: trk.segments.map((seg) => {
          const pts = seg.points;
          if (pts.length < 3) return seg;

          const result: TrackPoint[] = [pts[0]];
          for (let i = 1; i < pts.length; i += 1) {
            const prev = result[result.length - 1];
            const curr = pts[i];
            let isSpike = false;

            if (prev.time && curr.time) {
              const t1 = Date.parse(prev.time);
              const t2 = Date.parse(curr.time);
              if (!Number.isNaN(t1) && !Number.isNaN(t2) && t2 > t1) {
                const dist = haversineDistanceM(prev.lat, prev.lon, curr.lat, curr.lon);
                const speedKmh = (dist / ((t2 - t1) / 1000)) * 3.6;
                if (speedKmh > maxSpeedKmh) {
                  isSpike = true;
                }
              }
            }

            if (isSpike) {
              fixedCount += 1;
              if (mode === 'remove') {
                continue;
              }
              if (i < pts.length - 1) {
                result.push(interpolatePoint(prev, curr, pts[i + 1]));
                continue;
              }
            }
            result.push(curr);
          }

          return { ...seg, points: result };
        }),
      };
    }),
  };

  return { doc: updatedDoc, fixedCount };
}

export function getGradeColor(gradePct: number): string {
  if (gradePct < -3) return '#38bdf8'; // Descent
  if (gradePct < 3) return '#22c55e'; // Flat / Gentle
  if (gradePct < 6) return '#eab308'; // Moderate climb
  if (gradePct < 10) return '#f97316'; // Steep climb
  return '#ef4444'; // Very steep
}

export function toStravaIso(ms: number): string {
  return new Date(Math.round(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface TimestampHealth {
  totalPoints: number;
  missingCount: number;
  duplicateCount: number;
  outOfOrderCount: number;
  hasIssues: boolean;
}

export function analyzeTimestampHealth(track: GpxTrack | undefined): TimestampHealth {
  if (!track) {
    return { totalPoints: 0, missingCount: 0, duplicateCount: 0, outOfOrderCount: 0, hasIssues: false };
  }
  const pts = track.segments.flatMap((s) => s.points);
  let missingCount = 0;
  let duplicateCount = 0;
  let outOfOrderCount = 0;
  let prevMs: number | null = null;

  for (const pt of pts) {
    const ms = pt.time ? Date.parse(pt.time) : NaN;
    if (Number.isNaN(ms)) {
      missingCount += 1;
      continue;
    }
    if (prevMs !== null) {
      if (ms === prevMs) duplicateCount += 1;
      else if (ms < prevMs) outOfOrderCount += 1;
    }
    prevMs = ms;
  }

  const hasAnyTime = missingCount < pts.length;
  const hasIssues =
    pts.length > 0 &&
    ((hasAnyTime && missingCount > 0) || duplicateCount > 0 || outOfOrderCount > 0);

  return {
    totalPoints: pts.length,
    missingCount,
    duplicateCount,
    outOfOrderCount,
    hasIssues,
  };
}

/**
 * Repairs missing, duplicate, or out-of-order timestamps so Strava accepts the GPX cleanly.
 * Guarantees every trackpoint has a strictly increasing UTC ISO-8601 timestamp (whole seconds)
 * and syncs metadata.time to the first trackpoint's timestamp.
 */
export function repairTrackTimestamps(
  doc: GpxDocument,
  trackId: string,
  fallbackSpeedKmh = 15
): { doc: GpxDocument; repairedCount: number } {
  let repairedCount = 0;
  const speedMs = Math.max(0.5, (fallbackSpeedKmh * 1000) / 3600);
  let firstTrackTime: string | undefined;

  const updatedTracks = doc.tracks.map((trk) => {
    if (trk.id !== trackId) return trk;

    // Flatten to find first valid timestamp if any
    const flatPts = trk.segments.flatMap((s) => s.points);
    const firstValidMs = flatPts
      .map((p) => (p.time ? Date.parse(p.time) : NaN))
      .find((ms) => !Number.isNaN(ms));

    let prevMs = firstValidMs !== undefined ? firstValidMs - 1000 : Date.now() - flatPts.length * 1000;
    let prevPt: TrackPoint | null = null;

    const updatedSegments = trk.segments.map((seg) => {
      const nextPts = seg.points.map((pt) => {
        const parsed = pt.time ? Date.parse(pt.time) : NaN;
        let nextMs: number;

        if (Number.isNaN(parsed) || parsed <= prevMs) {
          repairedCount += 1;
          const dist = prevPt ? haversineDistanceM(prevPt.lat, prevPt.lon, pt.lat, pt.lon) : 0;
          const stepMs = Math.max(1000, Math.round((dist / speedMs) * 1000));
          nextMs = prevMs + stepMs;
        } else {
          // Normalize to whole seconds while keeping strictly > prevMs
          const rounded = Math.round(parsed / 1000) * 1000;
          nextMs = rounded > prevMs ? rounded : prevMs + 1000;
          if (nextMs !== parsed && Math.abs(nextMs - parsed) >= 1000) {
            repairedCount += 1;
          }
        }

        prevMs = nextMs;
        prevPt = pt;
        const iso = toStravaIso(nextMs);
        if (!firstTrackTime) firstTrackTime = iso;
        return { ...pt, time: iso };
      });

      return { ...seg, points: nextPts };
    });

    return { ...trk, segments: updatedSegments };
  });

  return {
    doc: {
      ...doc,
      metadata: {
        ...doc.metadata,
        time: firstTrackTime ?? doc.metadata.time,
      },
      tracks: updatedTracks,
    },
    repairedCount,
  };
}

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0s';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) return `${hrs}h ${mins.toString().padStart(2, '0')}m ${secs.toString().padStart(2, '0')}s`;
  if (mins > 0) return `${mins}m ${secs.toString().padStart(2, '0')}s`;
  return `${secs}s`;
}

export function toLocalDateTimeInputValue(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}`;
}

export function createSampleGpx(): GpxDocument {
  // Scenic loop around Mt. Tamalpais / Marin Headlands area
  const coords: Array<[number, number, number]> = [
    [37.8270, -122.4994, 42],
    [37.8285, -122.4972, 68],
    [37.8304, -122.4945, 95],
    [37.8321, -122.4910, 134],
    [37.8342, -122.4878, 178],
    [37.8365, -122.4842, 215],
    [37.8380, -122.4801, 248],
    [37.8392, -122.4765, 265],
    [37.8376, -122.4730, 232],
    [37.8351, -122.4708, 194],
    [37.8324, -122.4719, 156],
    [37.8300, -122.4750, 118],
    [37.8282, -122.4792, 85],
    [37.8268, -122.4840, 62],
    [37.8262, -122.4895, 51],
    [37.8265, -122.4948, 45],
    [37.8270, -122.4994, 42],
  ];

  const startMs = Date.now() - 3600 * 1000; // 1 hour ago
  let currentMs = startMs;
  const points: TrackPoint[] = coords.map(([lat, lon, ele], idx) => {
    if (idx > 0) {
      const [pLat, pLon] = coords[idx - 1];
      const dist = haversineDistanceM(pLat, pLon, lat, lon);
      currentMs += Math.round((dist / 3.2) * 1000); // ~11.5 km/h trail pace
    }
    return {
      id: nextId('pt'),
      lat,
      lon,
      ele,
      time: new Date(currentMs).toISOString(),
    };
  });

  return {
    metadata: {
      name: 'Marin Headlands Ridge Loop',
      desc: 'Sample scenic trail loop with elevation and timestamps.',
      authorName: 'GPX Explorer',
      time: new Date(startMs).toISOString(),
      creator: 'GPX Analyzer & Editor',
    },
    waypoints: [
      {
        id: nextId('wpt'),
        lat: 37.8392,
        lon: -122.4765,
        ele: 265,
        name: 'Ridge Summit Overlook',
        desc: 'Highest point on the loop',
        sym: 'Summit',
      },
    ],
    tracks: [
      {
        id: nextId('trk'),
        name: 'Marin Headlands Ridge Loop',
        desc: 'Morning trail run',
        type: 'running',
        segments: [
          {
            id: nextId('seg'),
            points,
          },
        ],
      },
    ],
  };
}

/**
 * Merges an incoming GPX document's trackpoints and waypoints into the active track
 * of `baseDoc`, ordering chronologically when possible and ensuring monotonic timestamps
 * so the merged GPX stays Strava-compatible.
 */
export function mergeGpxDocuments(
  baseDoc: GpxDocument,
  incomingDoc: GpxDocument,
  activeTrackId?: string | null,
  incomingName?: string
): { doc: GpxDocument; addedPoints: number; addedWaypoints: number } {
  const incomingPts = incomingDoc.tracks.flatMap((t) => t.segments.flatMap((s) => s.points));
  const segId = nextId('seg');
  const segName =
    incomingName || incomingDoc.tracks[0]?.name || incomingDoc.metadata.name || 'Merged GPX';
  const incomingWpts = incomingDoc.waypoints.map((w) => ({ ...w, sourceId: segId }));

  if (incomingPts.length === 0 && incomingWpts.length === 0) {
    return { doc: baseDoc, addedPoints: 0, addedWaypoints: 0 };
  }

  const targetTrack =
    baseDoc.tracks.find((t) => t.id === activeTrackId) || baseDoc.tracks[0];

  if (!targetTrack) {
    return {
      doc: {
        ...baseDoc,
        waypoints: [...baseDoc.waypoints, ...incomingWpts],
        tracks: incomingDoc.tracks.map((t, idx) =>
          idx === 0
            ? {
                ...t,
                segments: t.segments.map((s, sIdx) => ({
                  ...s,
                  name: s.name || (sIdx === 0 ? segName : `${segName} (${sIdx + 1})`),
                })),
              }
            : t
        ),
      },
      addedPoints: incomingPts.length,
      addedWaypoints: incomingWpts.length,
    };
  }

  const nonEmptyBaseSegs = targetTrack.segments.filter((s) => s.points.length > 0);
  const basePts = nonEmptyBaseSegs.flatMap((s) => s.points);

  const firstTime = (pts: TrackPoint[]): number | null => {
    for (const p of pts) {
      if (p.time) {
        const ms = Date.parse(p.time);
        if (!Number.isNaN(ms)) return ms;
      }
    }
    return null;
  };

  const lastTime = (pts: TrackPoint[]): number | null => {
    for (let i = pts.length - 1; i >= 0; i -= 1) {
      const p = pts[i];
      if (p.time) {
        const ms = Date.parse(p.time);
        if (!Number.isNaN(ms)) return ms;
      }
    }
    return null;
  };

  const baseStart = firstTime(basePts);
  const baseEnd = lastTime(basePts);
  const incStart = firstTime(incomingPts);
  const incEnd = lastTime(incomingPts);

  const incomingBeforeBase =
    basePts.length > 0 && incEnd !== null && baseStart !== null && incEnd < baseStart;

  let nextIncomingPts = incomingPts;
  let nextBaseSegs = nonEmptyBaseSegs.map((s, idx) => ({
    ...s,
    name: s.name || targetTrack.name || `Track Part ${idx + 1}`,
  }));

  if (incomingBeforeBase) {
    // Incoming goes before base; check if base starts <= incEnd (already false since incEnd < baseStart)
    nextIncomingPts = incomingPts;
  } else if (baseEnd !== null) {
    if (incStart !== null && incStart <= baseEnd) {
      const shiftMs = baseEnd + 1000 - incStart;
      nextIncomingPts = incomingPts.map((p) => {
        if (!p.time) return p;
        const ms = Date.parse(p.time);
        return Number.isNaN(ms) ? p : { ...p, time: toStravaIso(ms + shiftMs) };
      });
    } else if (incStart === null) {
      let curMs = baseEnd;
      let prevPt: TrackPoint | null = basePts[basePts.length - 1] || null;
      nextIncomingPts = incomingPts.map((p) => {
        const dist = prevPt ? haversineDistanceM(prevPt.lat, prevPt.lon, p.lat, p.lon) : 0;
        curMs += Math.max(1000, Math.round((dist / 4) * 1000));
        prevPt = p;
        return { ...p, time: toStravaIso(curMs) };
      });
    }
  }

  // Ensure incoming segment has strictly increasing timestamps (fixes Komoot duplicate/0.001s exports)
  let prevIncMs: number | null = !incomingBeforeBase && baseEnd !== null ? baseEnd : null;
  let prevIncPt: TrackPoint | null =
    !incomingBeforeBase && basePts.length > 0 ? basePts[basePts.length - 1] : null;
  const fallbackSpeedMs = (15 * 1000) / 3600;
  nextIncomingPts = nextIncomingPts.map((p) => {
    const parsed = p.time ? Date.parse(p.time) : NaN;
    let nextMs: number;
    if (Number.isNaN(parsed) || (prevIncMs !== null && parsed <= prevIncMs)) {
      const dist = prevIncPt ? haversineDistanceM(prevIncPt.lat, prevIncPt.lon, p.lat, p.lon) : 0;
      const stepMs = Math.max(1000, Math.round((dist / fallbackSpeedMs) * 1000));
      nextMs = (prevIncMs ?? Date.now()) + stepMs;
    } else {
      nextMs = parsed;
    }
    prevIncMs = nextMs;
    prevIncPt = p;
    return p.time ? { ...p, time: toStravaIso(nextMs) } : p;
  });

  const newSeg: TrackSegment = {
    id: segId,
    name: segName,
    points: nextIncomingPts,
  };

  const mergedSegments: TrackSegment[] = incomingBeforeBase
    ? [newSeg, ...nextBaseSegs]
    : [...nextBaseSegs, newSeg];

  const mergedStart = firstTime(mergedSegments.flatMap((s) => s.points));

  return {
    doc: {
      ...baseDoc,
      metadata: {
        ...baseDoc.metadata,
        time: mergedStart !== null ? toStravaIso(mergedStart) : baseDoc.metadata.time,
      },
      waypoints: [...baseDoc.waypoints, ...incomingWpts],
      tracks: baseDoc.tracks.map((t) =>
        t.id === targetTrack.id
          ? {
              ...t,
              segments: mergedSegments,
            }
          : t
      ),
    },
    addedPoints: incomingPts.length,
    addedWaypoints: incomingWpts.length,
  };
}

function cosineWeight(offset: number, radius: number): number {
  if (radius <= 0) return offset === 0 ? 1 : 0;
  const abs = Math.abs(offset);
  if (abs > radius) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * abs) / (radius + 1)));
}

/**
 * Adjusts elevation of `pointId` to `newEle`. When `smoothRadius > 0`, neighboring points
 * within `±smoothRadius` follow smoothly using a cosine bell curve.
 */
export function adjustTrackElevation(
  doc: GpxDocument,
  trackId: string,
  pointId: string,
  newEle: number,
  smoothRadius = 0
): GpxDocument {
  const targetTrack = doc.tracks.find((t) => t.id === trackId);
  if (!targetTrack) return doc;

  const allPts = targetTrack.segments.flatMap((s) => s.points);
  const centerIdx = allPts.findIndex((p) => p.id === pointId);
  if (centerIdx === -1) return doc;

  const oldEle = allPts[centerIdx].ele ?? 0;
  const deltaEle = newEle - oldEle;

  let globalIdx = 0;
  return {
    ...doc,
    tracks: doc.tracks.map((trk) => {
      if (trk.id !== trackId) return trk;
      return {
        ...trk,
        segments: trk.segments.map((seg) => ({
          ...seg,
          points: seg.points.map((pt) => {
            const idx = globalIdx;
            globalIdx += 1;
            const w = cosineWeight(idx - centerIdx, smoothRadius);
            if (w <= 0) return pt;
            const base = pt.ele ?? oldEle;
            return { ...pt, ele: Number((base + deltaEle * w).toFixed(2)) };
          }),
        })),
      };
    }),
  };
}

/**
 * Adjusts incoming speed at `pointId` to `targetSpeedKmh` (clamped >= 0.5 km/h) by
 * adjusting segment durations and shifting subsequent timestamps so the track remains
 * strictly monotonic and Strava-compatible.
 */
export function adjustTrackSpeed(
  doc: GpxDocument,
  trackId: string,
  pointId: string,
  targetSpeedKmh: number,
  smoothRadius = 0
): GpxDocument {
  const targetTrack = doc.tracks.find((t) => t.id === trackId);
  if (!targetTrack) return doc;

  const allPts = targetTrack.segments.flatMap((s) => s.points);
  const centerIdx = allPts.findIndex((p) => p.id === pointId);
  if (centerIdx <= 0) return doc;

  const prevCenter = allPts[centerIdx - 1];
  const currCenter = allPts[centerIdx];
  if (!prevCenter.time || !currCenter.time) return doc;

  const tPrev = Date.parse(prevCenter.time);
  const tCurr = Date.parse(currCenter.time);
  if (Number.isNaN(tPrev) || Number.isNaN(tCurr) || tCurr <= tPrev) return doc;

  const centerDist = haversineDistanceM(prevCenter.lat, prevCenter.lon, currCenter.lat, currCenter.lon);
  const oldCenterSpeed = (centerDist / ((tCurr - tPrev) / 1000)) * 3.6;
  const clampedTarget = Math.max(0.5, Math.min(200, targetSpeedKmh));
  const deltaSpeed = clampedTarget - oldCenterSpeed;

  // Rebuild timestamps sequentially from point 0 preserving original dt outside smoothRadius
  const newTimesMs: Array<number | null> = allPts.map((p) =>
    p.time && !Number.isNaN(Date.parse(p.time)) ? Date.parse(p.time) : null
  );

  let curMs = newTimesMs[0];
  for (let i = 1; i < allPts.length; i += 1) {
    const origPrev = allPts[i - 1].time ? Date.parse(allPts[i - 1].time!) : NaN;
    const origCurr = allPts[i].time ? Date.parse(allPts[i].time!) : NaN;
    if (curMs === null || Number.isNaN(origPrev) || Number.isNaN(origCurr)) {
      curMs = newTimesMs[i];
      continue;
    }

    let dtMs = Math.max(1000, origCurr - origPrev);
    const w = cosineWeight(i - centerIdx, smoothRadius);
    if (w > 0 && dtMs > 0) {
      const dist = haversineDistanceM(
        allPts[i - 1].lat,
        allPts[i - 1].lon,
        allPts[i].lat,
        allPts[i].lon
      );
      const oldSpeed = (dist / (dtMs / 1000)) * 3.6;
      const desiredSpeed = Math.max(0.5, oldSpeed + deltaSpeed * w);
      if (dist > 0.1) {
        dtMs = Math.max(1000, Math.round(((dist / (desiredSpeed / 3.6)) * 1000) / 1000) * 1000);
      }
    }

    curMs += dtMs;
    newTimesMs[i] = curMs;
  }

  let globalIdx = 0;
  return {
    ...doc,
    tracks: doc.tracks.map((trk) => {
      if (trk.id !== trackId) return trk;
      return {
        ...trk,
        segments: trk.segments.map((seg) => ({
          ...seg,
          points: seg.points.map((pt) => {
            const ms = newTimesMs[globalIdx];
            globalIdx += 1;
            return ms !== null ? { ...pt, time: toStravaIso(ms) } : pt;
          }),
        })),
      };
    }),
  };
}

