export interface TrackPoint {
  id: string;
  lat: number;
  lon: number;
  ele?: number;
  time?: string; // ISO 8601 string
  name?: string;
  desc?: string;
  extensionsXml?: string; // Preserves raw extensions XML if present
}

export interface Waypoint {
  id: string;
  lat: number;
  lon: number;
  ele?: number;
  time?: string;
  name?: string;
  desc?: string;
  sym?: string;
  sourceId?: string;
}

export interface TrackSegment {
  id: string;
  name?: string;
  points: TrackPoint[];
}

export interface GpxTrack {
  id: string;
  name: string;
  desc?: string;
  type?: string;
  segments: TrackSegment[];
}

export interface GpxMetadata {
  name?: string;
  desc?: string;
  authorName?: string;
  time?: string; // ISO 8601
  creator?: string;
}

export interface GpxDocument {
  metadata: GpxMetadata;
  waypoints: Waypoint[];
  tracks: GpxTrack[];
}

export interface ComputedPointStats {
  index: number;
  point: TrackPoint;
  cumulativeDistanceM: number;
  segmentDistanceM: number;
  segmentDurationSec: number;
  speedKmh: number;
  gradePct: number;
}

export interface TrackStats {
  totalPoints: number;
  totalDistanceM: number;
  totalDurationSec: number;
  movingDurationSec: number;
  avgSpeedKmh: number;
  movingAvgSpeedKmh: number;
  maxSpeedKmh: number;
  elevationGainM: number;
  elevationLossM: number;
  minElevationM: number | null;
  maxElevationM: number | null;
  startTime: string | null;
  endTime: string | null;
  pointStats: ComputedPointStats[];
}

export type MapEditMode = 'select' | 'add' | 'waypoint';
export type MapLayerType = 'osm' | 'topo' | 'satellite';

