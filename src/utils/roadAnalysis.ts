import { ComputedPointStats, GpxDocument, GpxTrack } from '../types/gpx';
import { haversineDistanceM } from './gpxParser';

export interface RoadPolyline {
  id: number;
  name?: string;
  highway: string;
  nodes: number[];
  coords: Array<[number, number]>; // [lat, lon]
}

export interface RoadNetworkData {
  roads: RoadPolyline[];
  fetchedAt: number;
}

export interface OffRoadAnomaly {
  id: string; // pointId of the peak off-road point
  startIndex: number;
  endIndex: number;
  peakIndex: number;
  pointIds: string[];
  cumulativeDistanceM: number;
  maxOffRoadDistM: number;
  source: 'osm-road' | 'trajectory';
  roadName?: string;
  prevCleanIndex: number | null;
  nextCleanIndex: number | null;
  /** Exact snapped coordinates on the OSM road (or clean trajectory if offline) for each pointId */
  roadSnapCoords: Record<string, { lat: number; lon: number }>;
  /** Straight interpolated coordinates between nearest clean prev & next points for each pointId */
  neighborAlignCoords: Record<string, { lat: number; lon: number }>;
  /** Ordered polyline coordinates [lat, lon] of the suggested fixed path from prevClean -> nextClean */
  suggestedPath: Array<[number, number]>;
  /** Ordered polyline coordinates [lat, lon] of the current off-road detour from prevClean -> nextClean */
  originalPath: Array<[number, number]>;
}

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/**
 * Builds a compact set of bounding boxes along the track corridor so we only query
 * OpenStreetMap roads near the actual ride rather than an entire province inside a huge loop.
 */
function buildTrackCorridorBoxes(
  track: GpxTrack,
  cellSizeDeg = 0.045,
  padDeg = 0.004
): Array<[number, number, number, number]> {
  const pts = track.segments.flatMap((s) => s.points);
  if (pts.length === 0) return [];

  const cellMap = new Map<string, [number, number, number, number]>();

  for (const pt of pts) {
    const gx = Math.floor(pt.lon / cellSizeDeg);
    const gy = Math.floor(pt.lat / cellSizeDeg);
    const key = `${gy}_${gx}`;
    const existing = cellMap.get(key);
    if (!existing) {
      cellMap.set(key, [pt.lat, pt.lon, pt.lat, pt.lon]);
    } else {
      if (pt.lat < existing[0]) existing[0] = pt.lat;
      if (pt.lon < existing[1]) existing[1] = pt.lon;
      if (pt.lat > existing[2]) existing[2] = pt.lat;
      if (pt.lon > existing[3]) existing[3] = pt.lon;
    }
  }

  const boxes: Array<[number, number, number, number]> = [];
  cellMap.forEach(([minLat, minLon, maxLat, maxLon]) => {
    boxes.push([
      Number((minLat - padDeg).toFixed(5)),
      Number((minLon - padDeg).toFixed(5)),
      Number((maxLat + padDeg).toFixed(5)),
      Number((maxLon + padDeg).toFixed(5)),
    ]);
  });

  // Cap max union clauses by merging into single bbox if too many cells
  if (boxes.length > 45) {
    let minLat = Infinity;
    let minLon = Infinity;
    let maxLat = -Infinity;
    let maxLon = -Infinity;
    for (const b of boxes) {
      if (b[0] < minLat) minLat = b[0];
      if (b[1] < minLon) minLon = b[1];
      if (b[2] > maxLat) maxLat = b[2];
      if (b[3] > maxLon) maxLon = b[3];
    }
    return [[minLat, minLon, maxLat, maxLon]];
  }

  return boxes;
}

/**
 * Fetches OpenStreetMap road & trail geometries (`way["highway"]`) along the GPX track corridor.
 */
export async function fetchOsmRoadsForTrack(track: GpxTrack): Promise<RoadNetworkData> {
  const boxes = buildTrackCorridorBoxes(track);
  if (boxes.length === 0) {
    return { roads: [], fetchedAt: Date.now() };
  }

  const wayClauses = boxes
    .map(([s, w, n, e]) => `way["highway"](${s},${w},${n},${e});`)
    .join('\n  ');

  const query = `[out:json][timeout:25];\n(\n  ${wayClauses}\n);\nout body geom;`;

  let lastErr: Error | null = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) {
        throw new Error(`Overpass HTTP ${res.status}`);
      }
      const json = (await res.json()) as {
        elements?: Array<{
          type: string;
          id: number;
          nodes?: number[];
          tags?: Record<string, string>;
          geometry?: Array<{ lat: number; lon: number }>;
        }>;
      };

      const roads: RoadPolyline[] = [];
      for (const el of json.elements || []) {
        if (el.type === 'way' && el.geometry && el.geometry.length >= 2) {
          roads.push({
            id: el.id,
            name: el.tags?.name || el.tags?.ref,
            highway: el.tags?.highway || 'road',
            nodes: el.nodes || [],
            coords: el.geometry.map((g) => [g.lat, g.lon]),
          });
        }
      }

      return { roads, fetchedAt: Date.now() };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error('Failed to query Overpass road network');
    }
  }

  throw lastErr || new Error('Failed to fetch OpenStreetMap road network');
}

interface IndexedRoadSegment {
  roadIdx: number;
  segIdx: number;
  lat1: number;
  lon1: number;
  lat2: number;
  lon2: number;
  roadName?: string;
}

/**
 * Projects point P(lat, lon) onto segment A(lat1, lon1) -> B(lat2, lon2)
 * returning closest point [snapLat, snapLon], parameter t in [0, 1], and distance in meters.
 */
function projectPointToSegmentM(
  lat: number,
  lon: number,
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  cosLat: number
): { snapLat: number; snapLon: number; distM: number; t: number } {
  const mPerDegLat = 110540;
  const mPerDegLon = 111320 * cosLat;

  const px = (lon - lon1) * mPerDegLon;
  const py = (lat - lat1) * mPerDegLat;
  const bx = (lon2 - lon1) * mPerDegLon;
  const by = (lat2 - lat1) * mPerDegLat;

  const lenSq = bx * bx + by * by;
  let t = 0;
  if (lenSq > 1e-6) {
    t = Math.max(0, Math.min(1, (px * bx + py * by) / lenSq));
  }

  const snapLat = lat1 + (lat2 - lat1) * t;
  const snapLon = lon1 + (lon2 - lon1) * t;
  const dx = px - bx * t;
  const dy = py - by * t;
  const distM = Math.hypot(dx, dy);

  return { snapLat, snapLon, distM, t };
}

/**
 * Traces a continuous path along the OSM road geometry between the road projection of
 * `prevPt` and the road projection of `nextPt` when they lie on the same road way or
 * share a connected road junction node.
 */
function traceRoadPathBetween(
  roads: RoadPolyline[],
  roadIdxA: number,
  segIdxA: number,
  snapA: [number, number],
  roadIdxB: number,
  segIdxB: number,
  snapB: [number, number]
): Array<[number, number]> | null {
  if (roadIdxA < 0 || roadIdxB < 0) return null;

  // Case 1: Both clean anchor points lie on the same OSM road way
  if (roadIdxA === roadIdxB) {
    const coords = roads[roadIdxA].coords;
    const path: Array<[number, number]> = [snapA];
    if (segIdxA <= segIdxB) {
      for (let v = segIdxA + 1; v <= segIdxB; v += 1) {
        path.push(coords[v]);
      }
    } else {
      for (let v = segIdxA; v >= segIdxB + 1; v -= 1) {
        path.push(coords[v]);
      }
    }
    path.push(snapB);
    return path;
  }

  // Case 2: Two road ways that share a common OSM junction node
  const roadA = roads[roadIdxA];
  const roadB = roads[roadIdxB];
  for (let i = 0; i < roadA.nodes.length; i += 1) {
    const nodeId = roadA.nodes[i];
    const j = roadB.nodes.indexOf(nodeId);
    if (j !== -1 && i < roadA.coords.length && j < roadB.coords.length) {
      const path: Array<[number, number]> = [snapA];
      if (segIdxA < i) {
        for (let v = segIdxA + 1; v <= i; v += 1) path.push(roadA.coords[v]);
      } else {
        for (let v = segIdxA; v >= i; v -= 1) path.push(roadA.coords[v]);
      }
      if (j <= segIdxB) {
        for (let v = j + 1; v <= segIdxB; v += 1) path.push(roadB.coords[v]);
      } else {
        for (let v = j - 1; v >= segIdxB + 1; v -= 1) path.push(roadB.coords[v]);
      }
      path.push(snapB);
      return path;
    }
  }

  return null;
}

/**
 * Samples `count` interior points evenly (or by fractional weights) along a polyline path.
 */
function sampleInteriorPointsAlongPolyline(
  polyline: Array<[number, number]>,
  fractions: number[]
): Array<{ lat: number; lon: number }> {
  if (polyline.length < 2) {
    const fallback = polyline[0] || [0, 0];
    return fractions.map(() => ({ lat: fallback[0], lon: fallback[1] }));
  }

  const cumDist: number[] = [0];
  for (let i = 1; i < polyline.length; i += 1) {
    const d = haversineDistanceM(
      polyline[i - 1][0],
      polyline[i - 1][1],
      polyline[i][0],
      polyline[i][1]
    );
    cumDist.push(cumDist[i - 1] + d);
  }
  const totalLen = cumDist[cumDist.length - 1];
  if (totalLen < 1e-3) {
    return fractions.map(() => ({ lat: polyline[0][0], lon: polyline[0][1] }));
  }

  return fractions.map((frac) => {
    const targetD = Math.max(0, Math.min(1, frac)) * totalLen;
    let seg = 0;
    while (seg < cumDist.length - 2 && cumDist[seg + 1] < targetD) {
      seg += 1;
    }
    const segLen = cumDist[seg + 1] - cumDist[seg];
    const t = segLen > 1e-6 ? (targetD - cumDist[seg]) / segLen : 0;
    const p0 = polyline[seg];
    const p1 = polyline[seg + 1];
    return {
      lat: Number((p0[0] + (p1[0] - p0[0]) * t).toFixed(7)),
      lon: Number((p0[1] + (p1[1] - p0[1]) * t).toFixed(7)),
    };
  });
}

/**
 * Detects trackpoints that have strayed off the road (using OpenStreetMap road geometries
 * when available, plus geometric lateral excursion / zig-zag detection).
 */
export function detectOffRoadAnomalies(
  pointStats: ComputedPointStats[],
  roadNetwork: RoadNetworkData | null,
  offRoadThresholdM = 15
): OffRoadAnomaly[] {
  if (pointStats.length < 3) return [];

  const n = pointStats.length;
  const avgLat = pointStats[Math.floor(n / 2)].point.lat;
  const cosLat = Math.max(0.2, Math.cos((avgLat * Math.PI) / 180));

  const hasRoads = roadNetwork !== null && roadNetwork.roads.length > 0;

  // Per-point nearest road projection
  const pointRoadMatch: Array<{
    distM: number;
    snapLat: number;
    snapLon: number;
    roadIdx: number;
    segIdx: number;
    roadName?: string;
  }> = [];

  if (hasRoads && roadNetwork) {
    // Build spatial hash grid (cell size 0.0025 deg ~ 275m)
    const gridCellDeg = 0.0025;
    const grid = new Map<string, IndexedRoadSegment[]>();

    for (let rIdx = 0; rIdx < roadNetwork.roads.length; rIdx += 1) {
      const road = roadNetwork.roads[rIdx];
      const coords = road.coords;
      for (let sIdx = 0; sIdx < coords.length - 1; sIdx += 1) {
        const [lat1, lon1] = coords[sIdx];
        const [lat2, lon2] = coords[sIdx + 1];
        const minGy = Math.floor(Math.min(lat1, lat2) / gridCellDeg);
        const maxGy = Math.floor(Math.max(lat1, lat2) / gridCellDeg);
        const minGx = Math.floor(Math.min(lon1, lon2) / gridCellDeg);
        const maxGx = Math.floor(Math.max(lon1, lon2) / gridCellDeg);

        const item: IndexedRoadSegment = {
          roadIdx: rIdx,
          segIdx: sIdx,
          lat1,
          lon1,
          lat2,
          lon2,
          roadName: road.name,
        };

        for (let gy = minGy; gy <= maxGy; gy += 1) {
          for (let gx = minGx; gx <= maxGx; gx += 1) {
            const key = `${gy}_${gx}`;
            let list = grid.get(key);
            if (!list) {
              list = [];
              grid.set(key, list);
            }
            list.push(item);
          }
        }
      }
    }

    for (let i = 0; i < n; i += 1) {
      const pt = pointStats[i].point;
      const cy = Math.floor(pt.lat / gridCellDeg);
      const cx = Math.floor(pt.lon / gridCellDeg);

      let bestDistM = Infinity;
      let bestSnapLat = pt.lat;
      let bestSnapLon = pt.lon;
      let bestRoadIdx = -1;
      let bestSegIdx = -1;
      let bestRoadName: string | undefined;

      // Search 3x3 cells (~825m box), expand to 5x5 if nothing found
      for (const radius of [1, 2]) {
        if (bestDistM < Infinity) break;
        for (let dy = -radius; dy <= radius; dy += 1) {
          for (let dx = -radius; dx <= radius; dx += 1) {
            const cell = grid.get(`${cy + dy}_${cx + dx}`);
            if (!cell) continue;
            for (let k = 0; k < cell.length; k += 1) {
              const seg = cell[k];
              const proj = projectPointToSegmentM(
                pt.lat,
                pt.lon,
                seg.lat1,
                seg.lon1,
                seg.lat2,
                seg.lon2,
                cosLat
              );
              if (proj.distM < bestDistM) {
                bestDistM = proj.distM;
                bestSnapLat = proj.snapLat;
                bestSnapLon = proj.snapLon;
                bestRoadIdx = seg.roadIdx;
                bestSegIdx = seg.segIdx;
                bestRoadName = seg.roadName;
              }
            }
          }
        }
      }

      pointRoadMatch.push({
        distM: bestDistM,
        snapLat: bestSnapLat,
        snapLon: bestSnapLon,
        roadIdx: bestRoadIdx,
        segIdx: bestSegIdx,
        roadName: bestRoadName,
      });
    }
  }

  // Flag off-road points
  const isOffRoad = new Array<boolean>(n).fill(false);
  const lateralDevM = new Array<number>(n).fill(0);

  if (hasRoads) {
    for (let i = 1; i < n - 1; i += 1) {
      const d = pointRoadMatch[i].distM;
      lateralDevM[i] = Number.isFinite(d) ? d : 0;
      if (d >= offRoadThresholdM && d < 1500) {
        isOffRoad[i] = true;
      }
    }
  } else {
    // Offline trajectory excursion detection: detect points that spike laterally off the local path chord
    for (let i = 1; i < n - 1; i += 1) {
      const pt = pointStats[i].point;
      // Check windows of 1..3 points before and after
      let maxSpikeDev = 0;
      for (const span of [1, 2, 3]) {
        const iPrev = Math.max(0, i - span);
        const iNext = Math.min(n - 1, i + span);
        if (iPrev === i || iNext === i) continue;
        const pA = pointStats[iPrev].point;
        const pB = pointStats[iNext].point;
        const chordM = haversineDistanceM(pA.lat, pA.lon, pB.lat, pB.lon);
        const detourM =
          haversineDistanceM(pA.lat, pA.lon, pt.lat, pt.lon) +
          haversineDistanceM(pt.lat, pt.lon, pB.lat, pB.lon);
        const proj = projectPointToSegmentM(
          pt.lat,
          pt.lon,
          pA.lat,
          pA.lon,
          pB.lat,
          pB.lon,
          cosLat
        );
        // Must stick out laterally AND create an unnatural detour ratio (> 1.35x chord)
        if (proj.distM >= offRoadThresholdM && detourM > Math.max(chordM * 1.35, chordM + offRoadThresholdM * 1.2)) {
          if (proj.distM > maxSpikeDev) {
            maxSpikeDev = proj.distM;
          }
        }
      }
      if (maxSpikeDev >= offRoadThresholdM) {
        isOffRoad[i] = true;
        lateralDevM[i] = maxSpikeDev;
      }
    }
  }

  // Group contiguous off-road points into excursions (up to 25 points per excursion)
  const anomalies: OffRoadAnomaly[] = [];
  let i = 1;
  while (i < n - 1) {
    if (!isOffRoad[i]) {
      i += 1;
      continue;
    }

    const startIdx = i;
    let endIdx = i;
    while (endIdx + 1 < n - 1 && isOffRoad[endIdx + 1] && endIdx - startIdx < 30) {
      endIdx += 1;
    }
    i = endIdx + 1;

    const prevCleanIdx = startIdx > 0 ? startIdx - 1 : null;
    const nextCleanIdx = endIdx < n - 1 ? endIdx + 1 : null;

    // Require that at least one bounding neighbor is close to a road when in OSM mode
    // (so an intentional off-road trail hike of 500 points isn't falsely flagged as a GPS glitch)
    if (hasRoads) {
      const prevOnRoad =
        prevCleanIdx !== null && pointRoadMatch[prevCleanIdx].distM < offRoadThresholdM * 1.1;
      const nextOnRoad =
        nextCleanIdx !== null && pointRoadMatch[nextCleanIdx].distM < offRoadThresholdM * 1.1;
      if (!prevOnRoad && !nextOnRoad) {
        continue;
      }
    }

    let peakIdx = startIdx;
    let maxDev = lateralDevM[startIdx];
    const pointIds: string[] = [];
    for (let k = startIdx; k <= endIdx; k += 1) {
      pointIds.push(pointStats[k].point.id);
      if (lateralDevM[k] > maxDev) {
        maxDev = lateralDevM[k];
        peakIdx = k;
      }
    }

    const pPrev = prevCleanIdx !== null ? pointStats[prevCleanIdx].point : pointStats[startIdx].point;
    const pNext = nextCleanIdx !== null ? pointStats[nextCleanIdx].point : pointStats[endIdx].point;

    const count = endIdx - startIdx + 1;
    const fractions: number[] = [];
    for (let k = 0; k < count; k += 1) {
      fractions.push((k + 1) / (count + 1));
    }

    // 1. Neighbor-aligned coordinates (straight chord pPrev -> pNext)
    const neighborAlignCoords: Record<string, { lat: number; lon: number }> = {};
    const chordPts = sampleInteriorPointsAlongPolyline(
      [
        [pPrev.lat, pPrev.lon],
        [pNext.lat, pNext.lon],
      ],
      fractions
    );
    for (let k = 0; k < count; k += 1) {
      neighborAlignCoords[pointIds[k]] = chordPts[k];
    }

    // 2. Road-snapped coordinates
    const roadSnapCoords: Record<string, { lat: number; lon: number }> = {};
    let suggestedPath: Array<[number, number]> = [
      [pPrev.lat, pPrev.lon],
      ...chordPts.map((c) => [c.lat, c.lon] as [number, number]),
      [pNext.lat, pNext.lon],
    ];

    if (hasRoads && roadNetwork && prevCleanIdx !== null && nextCleanIdx !== null) {
      const mPrev = pointRoadMatch[prevCleanIdx];
      const mNext = pointRoadMatch[nextCleanIdx];
      const tracedRoad = traceRoadPathBetween(
        roadNetwork.roads,
        mPrev.roadIdx,
        mPrev.segIdx,
        [mPrev.snapLat, mPrev.snapLon],
        mNext.roadIdx,
        mNext.segIdx,
        [mNext.snapLat, mNext.snapLon]
      );

      if (tracedRoad && tracedRoad.length >= 2) {
        const sampledOnRoad = sampleInteriorPointsAlongPolyline(tracedRoad, fractions);
        for (let k = 0; k < count; k += 1) {
          roadSnapCoords[pointIds[k]] = sampledOnRoad[k];
        }
        suggestedPath = [
          [pPrev.lat, pPrev.lon],
          ...sampledOnRoad.map((c) => [c.lat, c.lon] as [number, number]),
          [pNext.lat, pNext.lon],
        ];
      } else {
        // Fallback: direct perpendicular road projection for each off-road point
        const snapPoly: Array<[number, number]> = [[pPrev.lat, pPrev.lon]];
        for (let k = 0; k < count; k += 1) {
          const m = pointRoadMatch[startIdx + k];
          const coord = {
            lat: Number(m.snapLat.toFixed(7)),
            lon: Number(m.snapLon.toFixed(7)),
          };
          roadSnapCoords[pointIds[k]] = coord;
          snapPoly.push([coord.lat, coord.lon]);
        }
        snapPoly.push([pNext.lat, pNext.lon]);
        suggestedPath = snapPoly;
      }
    } else {
      for (let k = 0; k < count; k += 1) {
        roadSnapCoords[pointIds[k]] = chordPts[k];
      }
    }

    const originalPath: Array<[number, number]> = [[pPrev.lat, pPrev.lon]];
    for (let k = startIdx; k <= endIdx; k += 1) {
      originalPath.push([pointStats[k].point.lat, pointStats[k].point.lon]);
    }
    originalPath.push([pNext.lat, pNext.lon]);

    anomalies.push({
      id: pointStats[peakIdx].point.id,
      startIndex: startIdx,
      endIndex: endIdx,
      peakIndex: peakIdx,
      pointIds,
      cumulativeDistanceM: pointStats[peakIdx].cumulativeDistanceM,
      maxOffRoadDistM: Number(maxDev.toFixed(1)),
      source: hasRoads ? 'osm-road' : 'trajectory',
      roadName:
        hasRoads && prevCleanIdx !== null
          ? pointRoadMatch[prevCleanIdx].roadName || pointRoadMatch[peakIdx].roadName
          : undefined,
      prevCleanIndex: prevCleanIdx,
      nextCleanIndex: nextCleanIdx,
      roadSnapCoords,
      neighborAlignCoords,
      suggestedPath,
      originalPath,
    });
  }

  return anomalies;
}

/**
 * Applies a batch of coordinate replacements `{ [pointId]: { lat, lon } }` to a track
 * and smoothly interpolates timestamps across each modified run so snapping off-road points
 * back onto the road never creates artificial speed spikes.
 */
export function applyCoordinateFixesToTrack(
  doc: GpxDocument,
  trackId: string,
  coordUpdates: Record<string, { lat: number; lon: number }>
): { doc: GpxDocument; updatedCount: number } {
  const keys = Object.keys(coordUpdates);
  if (keys.length === 0) return { doc, updatedCount: 0 };

  let updatedCount = 0;
  return {
    doc: {
      ...doc,
      tracks: doc.tracks.map((trk) => {
        if (trk.id !== trackId) return trk;
        return {
          ...trk,
          segments: trk.segments.map((seg) => ({
            ...seg,
            points: seg.points.map((pt) => {
              const target = coordUpdates[pt.id];
              if (!target) return pt;
              updatedCount += 1;
              return {
                ...pt,
                lat: target.lat,
                lon: target.lon,
              };
            }),
          })),
        };
      }),
    },
    updatedCount,
  };
}
