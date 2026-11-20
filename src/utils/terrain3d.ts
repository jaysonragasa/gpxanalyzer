import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { TrackPoint } from '../types/gpx';

export type BaseShape3D = 'rectangle' | 'circle' | 'hexagon' | 'ribbon';
export type ColorTheme3D =
  | 'satellite'
  | 'topo'
  | 'alpine'
  | 'volcanic'
  | 'glacier'
  | 'pla'
  | 'custom';

export interface Terrain3DOptions {
  baseShape: BaseShape3D;
  gridSize: number; // e.g. 40..80
  zExaggeration: number; // 0.5 .. 3.5
  baseThicknessMm: number; // 3 .. 20
  trackWidthMm: number; // 1.0 .. 5.0
  trackHeightMm: number; // 0.8 .. 4.0
  titleText: string;
  titleSizeMm: number; // 4 .. 12
  theme: ColorTheme3D;
  customLowColor: string;
  customHighColor: string;
  customTrackColor: string;
  customBaseColor: string;
}

export interface DemGridData {
  rows: number;
  cols: number;
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
  elevations: number[][]; // [row][col] from minLat (row 0, South) to maxLat (row rows-1, North)
}

export interface Map3DBundle {
  demGrid: DemGridData;
  satelliteCanvas: HTMLCanvasElement | null;
  topoCanvas: HTMLCanvasElement | null;
}

export interface TerrainSceneBundle {
  displayGroup: THREE.Group;
  exportGroup: THREE.Group;
  stats: {
    triangleCount: number;
    widthMm: number;
    lengthMm: number;
    heightMm: number;
  };
}

// Convert hex string to THREE.Color
function hexToThreeColor(hex: string): THREE.Color {
  return new THREE.Color(hex);
}

// Web Mercator slippy tile helpers
function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * Math.pow(2, z);
}

function latToTileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z)
  );
}

function loadImageCors(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load tile: ${url}`));
    img.src = url;
  });
}

export function computeTrackBoundingBox(points: TrackPoint[]) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  const latPad = Math.max(0.0025, (maxLat - minLat) * 0.16);
  const lonPad = Math.max(0.0025, (maxLon - minLon) * 0.16);
  return {
    minLat: minLat - latPad,
    maxLat: maxLat + latPad,
    minLon: minLon - lonPad,
    maxLon: maxLon + lonPad,
  };
}

/**
 * Fetches stitched tile canvas for the track's bounding box
 */
async function fetchStitchedTileCanvas(
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number },
  urlBuilder: (z: number, x: number, y: number) => string,
  outSize = 512
): Promise<HTMLCanvasElement> {
  let chosenZ = 13;
  for (let z = 14; z >= 9; z -= 1) {
    const x0 = Math.floor(lonToTileX(bbox.minLon, z));
    const x1 = Math.floor(lonToTileX(bbox.maxLon, z));
    const y0 = Math.floor(latToTileY(bbox.maxLat, z));
    const y1 = Math.floor(latToTileY(bbox.minLat, z));
    if (x1 - x0 <= 3 && y1 - y0 <= 3) {
      chosenZ = z;
      break;
    }
  }

  const txMin = lonToTileX(bbox.minLon, chosenZ);
  const txMax = lonToTileX(bbox.maxLon, chosenZ);
  const tyMin = latToTileY(bbox.maxLat, chosenZ);
  const tyMax = latToTileY(bbox.minLat, chosenZ);

  const ix0 = Math.floor(txMin);
  const ix1 = Math.floor(txMax);
  const iy0 = Math.floor(tyMin);
  const iy1 = Math.floor(tyMax);

  const tilesW = ix1 - ix0 + 1;
  const tilesH = iy1 - iy0 + 1;

  const stitchCanvas = document.createElement('canvas');
  stitchCanvas.width = tilesW * 256;
  stitchCanvas.height = tilesH * 256;
  const sCtx = stitchCanvas.getContext('2d')!;

  const jobs: Array<Promise<void>> = [];
  for (let ty = iy0; ty <= iy1; ty += 1) {
    for (let tx = ix0; tx <= ix1; tx += 1) {
      const dx = (tx - ix0) * 256;
      const dy = (ty - iy0) * 256;
      jobs.push(
        loadImageCors(urlBuilder(chosenZ, tx, ty)).then((img) => {
          sCtx.drawImage(img, dx, dy, 256, 256);
        })
      );
    }
  }
  await Promise.all(jobs);

  const cropX = (txMin - ix0) * 256;
  const cropY = (tyMin - iy0) * 256;
  const cropW = Math.max(1, (txMax - txMin) * 256);
  const cropH = Math.max(1, (tyMax - tyMin) * 256);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = outSize;
  outCanvas.height = outSize;
  const oCtx = outCanvas.getContext('2d')!;
  oCtx.drawImage(stitchCanvas, cropX, cropY, cropW, cropH, 0, 0, outSize, outSize);
  return outCanvas;
}

/**
 * Fetches 3D terrain depth map (AWS Terrarium DEM) and satellite/topo textures
 */
export async function fetchMap3DTerrainAndTextures(
  points: TrackPoint[]
): Promise<Map3DBundle> {
  const bbox = computeTrackBoundingBox(points);

  const satPromise = fetchStitchedTileCanvas(
    bbox,
    (z, x, y) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    512
  ).catch(() => null);

  const topoPromise = fetchStitchedTileCanvas(
    bbox,
    (z, x, y) => `https://tile.opentopomap.org/${z}/${x}/${y}.png`,
    512
  ).catch(() => null);

  let demGrid: DemGridData | null = null;
  try {
    const gridDim = 80;
    const demCanvas = await fetchStitchedTileCanvas(
      bbox,
      (z, x, y) =>
        `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
      gridDim
    );
    const ctx = demCanvas.getContext('2d')!;
    const imgData = ctx.getImageData(0, 0, gridDim, gridDim).data;
    const elevations: number[][] = [];

    for (let r = 0; r < gridDim; r += 1) {
      const imgRow = gridDim - 1 - r;
      const rowEle: number[] = [];
      for (let c = 0; c < gridDim; c += 1) {
        const idx = (imgRow * gridDim + c) * 4;
        const R = imgData[idx];
        const G = imgData[idx + 1];
        const B = imgData[idx + 2];
        const ele = R * 256 + G + B / 256 - 32768;
        rowEle.push(ele > -500 && ele < 9000 ? ele : 0);
      }
      elevations.push(rowEle);
    }

    demGrid = {
      rows: gridDim,
      cols: gridDim,
      ...bbox,
      elevations,
    };
  } catch {
    demGrid = await fetchOpenMeteoDemGrid(bbox, 12);
  }

  const [satelliteCanvas, topoCanvas] = await Promise.all([satPromise, topoPromise]);

  return {
    demGrid,
    satelliteCanvas,
    topoCanvas,
  };
}

async function fetchOpenMeteoDemGrid(
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number },
  gridDim = 12
): Promise<DemGridData> {
  const coords: Array<{ lat: number; lon: number }> = [];
  for (let r = 0; r < gridDim; r += 1) {
    const lat = bbox.minLat + (r / (gridDim - 1)) * (bbox.maxLat - bbox.minLat);
    for (let c = 0; c < gridDim; c += 1) {
      const lon = bbox.minLon + (c / (gridDim - 1)) * (bbox.maxLon - bbox.minLon);
      coords.push({ lat, lon });
    }
  }

  const allEle: number[] = [];
  for (let i = 0; i < coords.length; i += 50) {
    if (i > 0) await new Promise((res) => setTimeout(res, 140));
    const batch = coords.slice(i, i + 50);
    const lats = batch.map((p) => p.lat.toFixed(5)).join(',');
    const lons = batch.map((p) => p.lon.toFixed(5)).join(',');
    const res = await fetch(
      `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`
    );
    if (!res.ok) throw new Error(`DEM HTTP ${res.status}`);
    const data = (await res.json()) as { elevation?: number[] };
    allEle.push(...(data.elevation || []));
  }

  const elevations: number[][] = [];
  for (let r = 0; r < gridDim; r += 1) {
    elevations.push(allEle.slice(r * gridDim, (r + 1) * gridDim));
  }

  return {
    rows: gridDim,
    cols: gridDim,
    ...bbox,
    elevations,
  };
}

function sampleBilinearDem(dem: DemGridData, lat: number, lon: number): number {
  const u = Math.max(0, Math.min(1, (lon - dem.minLon) / Math.max(1e-6, dem.maxLon - dem.minLon)));
  const v = Math.max(0, Math.min(1, (lat - dem.minLat) / Math.max(1e-6, dem.maxLat - dem.minLat)));
  const cFloat = u * (dem.cols - 1);
  const rFloat = v * (dem.rows - 1);
  const c0 = Math.floor(cFloat);
  const r0 = Math.floor(rFloat);
  const c1 = Math.min(dem.cols - 1, c0 + 1);
  const r1 = Math.min(dem.rows - 1, r0 + 1);
  const fc = cFloat - c0;
  const fr = rFloat - r0;

  const v00 = dem.elevations[r0][c0];
  const v10 = dem.elevations[r0][c1];
  const v01 = dem.elevations[r1][c0];
  const v11 = dem.elevations[r1][c1];
  const top = v00 + (v10 - v00) * fc;
  const bot = v01 + (v11 - v01) * fc;
  return top + (bot - top) * fr;
}

const FONT_5X7: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

// Map UV to base shapes
function mapUvToShapeXY(
  u: number,
  v: number,
  shape: BaseShape3D,
  halfW: number,
  halfH: number
): [number, number] {
  if (shape === 'circle') {
    const r = Math.min(halfW, halfH);
    const x = u * Math.sqrt(Math.max(0, 1 - (v * v) / 2)) * r;
    const y = v * Math.sqrt(Math.max(0, 1 - (u * u) / 2)) * r;
    return [x, y];
  }
  if (shape === 'hexagon') {
    const r = Math.min(halfW, halfH);
    const dx = u * Math.sqrt(Math.max(0, 1 - (v * v) / 2));
    const dy = v * Math.sqrt(Math.max(0, 1 - (u * u) / 2));
    const rad = Math.hypot(dx, dy);
    if (rad < 1e-6) return [0, 0];
    const angle = Math.atan2(dy, dx);
    const sector = Math.PI / 3;
    const localAngle = ((angle % sector) + sector) % sector - sector / 2;
    const hexScale = Math.cos(Math.PI / 6) / Math.cos(localAngle);
    return [dx * hexScale * r, dy * hexScale * r];
  }
  return [u * halfW, v * halfH];
}

// Get palette colors for thematic shading
function getThemePalette(opts: Terrain3DOptions): {
  low: THREE.Color;
  mid: THREE.Color;
  high: THREE.Color;
  base: THREE.Color;
  track: THREE.Color;
} {
  if (opts.theme === 'volcanic') {
    return {
      low: new THREE.Color('#22242b'),
      mid: new THREE.Color('#554848'),
      high: new THREE.Color('#a87558'),
      base: new THREE.Color('#16181f'),
      track: new THREE.Color('#ff5500'),
    };
  }
  if (opts.theme === 'glacier') {
    return {
      low: new THREE.Color('#214068'),
      mid: new THREE.Color('#5894c2'),
      high: new THREE.Color('#f0f8ff'),
      base: new THREE.Color('#16253d'),
      track: new THREE.Color('#facc15'),
    };
  }
  if (opts.theme === 'pla') {
    return {
      low: new THREE.Color('#cbd5e1'),
      mid: new THREE.Color('#e2e8f0'),
      high: new THREE.Color('#f8fafc'),
      base: new THREE.Color('#94a3b8'),
      track: new THREE.Color('#f1f5f9'),
    };
  }
  if (opts.theme === 'custom') {
    const low = hexToThreeColor(opts.customLowColor);
    const high = hexToThreeColor(opts.customHighColor);
    const mid = low.clone().lerp(high, 0.5);
    return {
      low,
      mid,
      high,
      base: hexToThreeColor(opts.customBaseColor),
      track: hexToThreeColor(opts.customTrackColor),
    };
  }
  // Default Alpine
  return {
    low: new THREE.Color('#2d6a4f'),
    mid: new THREE.Color('#8c7a6b'),
    high: new THREE.Color('#f8fafc'),
    base: new THREE.Color('#1e293b'),
    track: new THREE.Color('#fc4c02'),
  };
}

/**
 * Creates 3D Box geometry helper pushing indexed quad faces
 */
function pushBoxToBuffers(
  positions: number[],
  normals: number[],
  indices: number[],
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number
) {
  const p000 = [x0, y0, z0];
  const p100 = [x1, y0, z0];
  const p110 = [x1, y1, z0];
  const p010 = [x0, y1, z0];
  const p001 = [x0, y0, z1];
  const p101 = [x1, y0, z1];
  const p111 = [x1, y1, z1];
  const p011 = [x0, y1, z1];

  const pushFace = (
    a: number[],
    b: number[],
    c: number[],
    d: number[],
    norm: [number, number, number]
  ) => {
    const baseIdx = positions.length / 3;
    positions.push(...a, ...b, ...c, ...d);
    normals.push(...norm, ...norm, ...norm, ...norm);
    indices.push(baseIdx, baseIdx + 1, baseIdx + 2, baseIdx, baseIdx + 2, baseIdx + 3);
  };

  // Top (+Z)
  pushFace(p001, p101, p111, p011, [0, 0, 1]);
  // Bottom (-Z)
  pushFace(p010, p110, p100, p000, [0, 0, -1]);
  // Front (-Y)
  pushFace(p000, p100, p101, p001, [0, -1, 0]);
  // Right (+X)
  pushFace(p100, p110, p111, p101, [1, 0, 0]);
  // Back (+Y)
  pushFace(p110, p010, p011, p111, [0, 1, 0]);
  // Left (-X)
  pushFace(p010, p000, p001, p011, [-1, 0, 0]);
}

/**
 * Builds the complete Three.js 3D scene objects with continuous track geometry,
 * realistic terrain mesh, base pedestal, and embossed title text.
 */
export function buildTerrainSceneObjects(
  points: TrackPoint[],
  terrainElevations: Record<string, number>,
  demGrid: DemGridData | null,
  textureCanvas: HTMLCanvasElement | null,
  opts: Terrain3DOptions
): TerrainSceneBundle {
  const displayGroup = new THREE.Group();
  displayGroup.name = 'displayGroup';

  const exportGroup = new THREE.Group();
  exportGroup.name = 'exportGroup';

  if (points.length < 2) {
    return {
      displayGroup,
      exportGroup,
      stats: { triangleCount: 0, widthMm: 0, lengthMm: 0, heightMm: 0 },
    };
  }

  const palette = getThemePalette(opts);
  const bbox = demGrid
    ? {
        minLat: demGrid.minLat,
        maxLat: demGrid.maxLat,
        minLon: demGrid.minLon,
        maxLon: demGrid.maxLon,
      }
    : computeTrackBoundingBox(points);

  let minEle = Infinity;
  let maxEle = -Infinity;

  const ptEles = points.map((p) => {
    const e = terrainElevations[p.id] !== undefined ? terrainElevations[p.id] : p.ele ?? 0;
    if (e < minEle) minEle = e;
    if (e > maxEle) maxEle = e;
    return e;
  });

  if (demGrid) {
    for (const row of demGrid.elevations) {
      for (const e of row) {
        if (e < minEle) minEle = e;
        if (e > maxEle) maxEle = e;
      }
    }
  }

  const midLatRad = (((bbox.minLat + bbox.maxLat) / 2) * Math.PI) / 180;
  const cosLat = Math.max(0.2, Math.cos(midLatRad));
  const spanLon = Math.max(1e-5, (bbox.maxLon - bbox.minLon) * cosLat);
  const spanLat = Math.max(1e-5, bbox.maxLat - bbox.minLat);

  const maxSideMm = 110;
  const aspect = spanLon / spanLat;
  const halfW =
    opts.baseShape === 'circle' || opts.baseShape === 'hexagon'
      ? maxSideMm / 2
      : aspect >= 1
      ? maxSideMm / 2
      : (maxSideMm * aspect) / 2;
  const halfH =
    opts.baseShape === 'circle' || opts.baseShape === 'hexagon'
      ? maxSideMm / 2
      : aspect >= 1
      ? maxSideMm / (2 * aspect)
      : maxSideMm / 2;

  const eleSpan = Math.max(10, maxEle - minEle);
  const maxReliefMm = 26 * opts.zExaggeration;
  const eleToZ = (ele: number) =>
    opts.baseThicknessMm + Math.max(0, ((ele - minEle) / eleSpan) * maxReliefMm);

  // Elevation evaluator
  const stepAnchor = Math.max(1, Math.floor(points.length / 180));
  const anchors: Array<{ x: number; y: number; ele: number }> = [];
  for (let i = 0; i < points.length; i += stepAnchor) {
    const p = points[i];
    const u = ((p.lon - bbox.minLon) / Math.max(1e-6, bbox.maxLon - bbox.minLon)) * 2 - 1;
    const v = ((p.lat - bbox.minLat) / Math.max(1e-6, bbox.maxLat - bbox.minLat)) * 2 - 1;
    anchors.push({ x: u * halfW, y: v * halfH, ele: ptEles[i] });
  }

  const evalElevationAtXY = (x: number, y: number): number => {
    if (demGrid) {
      const u = Math.max(0, Math.min(1, (x / halfW + 1) / 2));
      const v = Math.max(0, Math.min(1, (y / halfH + 1) / 2));
      const lon = bbox.minLon + u * (bbox.maxLon - bbox.minLon);
      const lat = bbox.minLat + v * (bbox.maxLat - bbox.minLat);
      return sampleBilinearDem(demGrid, lat, lon);
    }

    let weightSum = 0;
    let eleSum = 0;
    let minDist = Infinity;
    for (let i = 0; i < anchors.length; i += 1) {
      const a = anchors[i];
      const d2 = (x - a.x) * (x - a.x) + (y - a.y) * (y - a.y);
      if (d2 < minDist) minDist = d2;
      const w = 1 / (d2 + 18);
      weightSum += w;
      eleSum += a.ele * w;
    }
    const idwEle = weightSum > 0 ? eleSum / weightSum : minEle;
    const distMm = Math.sqrt(minDist);
    const falloff = Math.exp(-(distMm * distMm) / (halfW * halfW * 0.65));
    return minEle + (idwEle - minEle) * (0.35 + 0.65 * falloff);
  };

  let totalTriangles = 0;

  // 1. TERRAIN & BASE MESH
  if (opts.baseShape !== 'ribbon') {
    const N = Math.max(20, Math.min(80, opts.gridSize));

    const terrainPositions: number[] = [];
    const terrainUvs: number[] = [];
    const terrainColors: number[] = [];
    const terrainIndices: number[] = [];

    const basePositions: number[] = [];
    const baseNormals: number[] = [];
    const baseIndices: number[] = [];

    // Precalculate grid coordinates
    const gridXYZ: [number, number, number][][] = [];
    const gridEle: number[][] = [];
    const gridUV: [number, number][][] = [];

    for (let r = 0; r <= N; r += 1) {
      const v = (r / N) * 2 - 1;
      const rowXYZ: [number, number, number][] = [];
      const rowEle: number[] = [];
      const rowUV: [number, number][] = [];

      for (let c = 0; c <= N; c += 1) {
        const u = (c / N) * 2 - 1;
        const [x, y] = mapUvToShapeXY(u, v, opts.baseShape, halfW, halfH);
        const ele = evalElevationAtXY(x, y);
        const z = eleToZ(ele);
        rowXYZ.push([x, y, z]);
        rowEle.push(ele);

        // UV for satellite texture: u in [0, 1] West to East, v in [0, 1] South to North
        const uTex = Math.max(0, Math.min(1, (x / halfW + 1) * 0.5));
        const vTex = Math.max(0, Math.min(1, (y / halfH + 1) * 0.5));
        rowUV.push([uTex, vTex]);
      }
      gridXYZ.push(rowXYZ);
      gridEle.push(rowEle);
      gridUV.push(rowUV);
    }

    // Build terrain surface vertices & quads
    for (let r = 0; r <= N; r += 1) {
      for (let c = 0; c <= N; c += 1) {
        const [x, y, z] = gridXYZ[r][c];
        const ele = gridEle[r][c];
        const [uTex, vTex] = gridUV[r][c];

        terrainPositions.push(x, y, z);
        terrainUvs.push(uTex, vTex);

        // Calculate elevation gradient color for non-texture themes
        const t = Math.max(0, Math.min(1, (ele - minEle) / eleSpan));
        const color =
          t < 0.5
            ? palette.low.clone().lerp(palette.mid, t * 2)
            : palette.mid.clone().lerp(palette.high, (t - 0.5) * 2);
        terrainColors.push(color.r, color.g, color.b);
      }
    }

    for (let r = 0; r < N; r += 1) {
      for (let c = 0; c < N; c += 1) {
        const i00 = r * (N + 1) + c;
        const i10 = r * (N + 1) + (c + 1);
        const i11 = (r + 1) * (N + 1) + (c + 1);
        const i01 = (r + 1) * (N + 1) + c;

        terrainIndices.push(i00, i10, i11);
        terrainIndices.push(i00, i11, i01);
      }
    }

    const terrainGeom = new THREE.BufferGeometry();
    terrainGeom.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(terrainPositions, 3)
    );
    terrainGeom.setAttribute('uv', new THREE.Float32BufferAttribute(terrainUvs, 2));
    terrainGeom.setAttribute('color', new THREE.Float32BufferAttribute(terrainColors, 3));
    terrainGeom.setIndex(terrainIndices);
    terrainGeom.computeVertexNormals();

    let terrainMat: THREE.Material;
    if (textureCanvas && (opts.theme === 'satellite' || opts.theme === 'topo')) {
      const tex = new THREE.CanvasTexture(textureCanvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;

      terrainMat = new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 0.82,
        metalness: 0.05,
      });
    } else {
      terrainMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.78,
        metalness: 0.08,
      });
    }

    const terrainMesh = new THREE.Mesh(terrainGeom, terrainMat);
    terrainMesh.name = 'terrainMesh';
    terrainMesh.castShadow = true;
    terrainMesh.receiveShadow = true;
    displayGroup.add(terrainMesh);
    exportGroup.add(terrainMesh.clone());
    totalTriangles += terrainIndices.length / 3;

    // 2. BASE PEDESTAL WALLS & FLAT BOTTOM AT z=0
    const addWallEdge = (
      pA: [number, number, number],
      pB: [number, number, number]
    ) => {
      const bA = [pA[0], pA[1], 0];
      const bB = [pB[0], pB[1], 0];

      const vA = new THREE.Vector3(...pA);
      const vB = new THREE.Vector3(...pB);
      const edge = new THREE.Vector3().subVectors(vB, vA);
      const down = new THREE.Vector3(0, 0, -1);
      const wallNorm = new THREE.Vector3().crossVectors(down, edge).normalize();

      const baseIdx = basePositions.length / 3;
      basePositions.push(...bA, ...bB, ...pB, ...pA);
      baseNormals.push(
        wallNorm.x,
        wallNorm.y,
        wallNorm.z,
        wallNorm.x,
        wallNorm.y,
        wallNorm.z,
        wallNorm.x,
        wallNorm.y,
        wallNorm.z,
        wallNorm.x,
        wallNorm.y,
        wallNorm.z
      );
      baseIndices.push(baseIdx, baseIdx + 1, baseIdx + 2, baseIdx, baseIdx + 2, baseIdx + 3);
    };

    // South wall (v = 0)
    for (let c = 0; c < N; c += 1) addWallEdge(gridXYZ[0][c], gridXYZ[0][c + 1]);
    // East wall (u = N)
    for (let r = 0; r < N; r += 1) addWallEdge(gridXYZ[r][N], gridXYZ[r + 1][N]);
    // North wall (v = N, East to West)
    for (let c = N; c > 0; c -= 1) addWallEdge(gridXYZ[N][c], gridXYZ[N][c - 1]);
    // West wall (u = 0, North to South)
    for (let r = N; r > 0; r -= 1) addWallEdge(gridXYZ[r][0], gridXYZ[r - 1][0]);

    // Flat bottom plate at z=0 (normal is 0, 0, -1)
    for (let r = 0; r < N; r += 1) {
      for (let c = 0; c < N; c += 1) {
        const b00 = [gridXYZ[r][c][0], gridXYZ[r][c][1], 0];
        const b10 = [gridXYZ[r][c + 1][0], gridXYZ[r][c + 1][1], 0];
        const b11 = [gridXYZ[r + 1][c + 1][0], gridXYZ[r + 1][c + 1][1], 0];
        const b01 = [gridXYZ[r + 1][c][0], gridXYZ[r + 1][c][1], 0];

        const baseIdx = basePositions.length / 3;
        basePositions.push(...b00, ...b10, ...b11, ...b01);
        baseNormals.push(0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1);
        baseIndices.push(baseIdx, baseIdx + 2, baseIdx + 1, baseIdx, baseIdx + 3, baseIdx + 2);
      }
    }

    const baseGeom = new THREE.BufferGeometry();
    baseGeom.setAttribute('position', new THREE.Float32BufferAttribute(basePositions, 3));
    baseGeom.setAttribute('normal', new THREE.Float32BufferAttribute(baseNormals, 3));
    baseGeom.setIndex(baseIndices);

    const baseMat = new THREE.MeshStandardMaterial({
      color: palette.base,
      roughness: 0.65,
      metalness: 0.15,
    });

    const baseMesh = new THREE.Mesh(baseGeom, baseMat);
    baseMesh.name = 'baseMesh';
    baseMesh.receiveShadow = true;
    displayGroup.add(baseMesh);
    exportGroup.add(baseMesh.clone());
    totalTriangles += baseIndices.length / 3;
  }

  // 3. CONTINUOUS SMOOTH 3D TRACK RIBBON (Fixes broken blocks bug)
  const rawPath: Array<{ x: number; y: number; ele: number }> = [];
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    const u = ((p.lon - bbox.minLon) / Math.max(1e-6, bbox.maxLon - bbox.minLon)) * 2 - 1;
    const v = ((p.lat - bbox.minLat) / Math.max(1e-6, bbox.maxLat - bbox.minLat)) * 2 - 1;
    const [x, y] =
      opts.baseShape === 'ribbon'
        ? [u * halfW, v * halfH]
        : mapUvToShapeXY(u, v, opts.baseShape, halfW, halfH);
    rawPath.push({ x, y, ele: ptEles[i] });
  }

  // Filter out duplicate or near-identical successive points
  const cleanPath: Array<{ x: number; y: number; ele: number }> = [];
  for (let i = 0; i < rawPath.length; i += 1) {
    if (i === 0) {
      cleanPath.push(rawPath[0]);
    } else {
      const prev = cleanPath[cleanPath.length - 1];
      const cur = rawPath[i];
      if (Math.hypot(cur.x - prev.x, cur.y - prev.y) > 0.12) {
        cleanPath.push(cur);
      }
    }
  }

  const sampledNodes: Array<{ x: number; y: number; zSurf: number }> = [];
  const pathLen = cleanPath.length;
  if (pathLen >= 2) {
    for (let i = 0; i < pathLen; i += 1) {
      const pt = cleanPath[i];
      const zSurf =
        opts.baseShape === 'ribbon'
          ? eleToZ(pt.ele)
          : eleToZ(evalElevationAtXY(pt.x, pt.y));
      sampledNodes.push({ x: pt.x, y: pt.y, zSurf });
    }
  }

  if (sampledNodes.length >= 2) {
    const trackPositions: number[] = [];
    const trackNormals: number[] = [];
    const trackIndices: number[] = [];

    const halfWTrack = opts.trackWidthMm * 0.5;
    const trackExtrude = opts.trackHeightMm;

    interface NodeCrossSection {
      LTop: [number, number, number];
      RTop: [number, number, number];
      LBot: [number, number, number];
      RBot: [number, number, number];
    }

    const sections: NodeCrossSection[] = [];

    for (let i = 0; i < sampledNodes.length; i += 1) {
      const cur = sampledNodes[i];
      let tx = 0;
      let ty = 0;
      let miterScale = 1.0;

      if (i === 0) {
        const next = sampledNodes[1];
        const len = Math.hypot(next.x - cur.x, next.y - cur.y) || 1;
        tx = (next.x - cur.x) / len;
        ty = (next.y - cur.y) / len;
      } else if (i === sampledNodes.length - 1) {
        const prev = sampledNodes[i - 1];
        const len = Math.hypot(cur.x - prev.x, cur.y - prev.y) || 1;
        tx = (cur.x - prev.x) / len;
        ty = (cur.y - prev.y) / len;
      } else {
        const prev = sampledNodes[i - 1];
        const next = sampledNodes[i + 1];
        const d1x = cur.x - prev.x;
        const d1y = cur.y - prev.y;
        const l1 = Math.hypot(d1x, d1y) || 1;
        const v1x = d1x / l1;
        const v1y = d1y / l1;

        const d2x = next.x - cur.x;
        const d2y = next.y - cur.y;
        const l2 = Math.hypot(d2x, d2y) || 1;
        const v2x = d2x / l2;
        const v2y = d2y / l2;

        const tanX = v1x + v2x;
        const tanY = v1y + v2y;
        const tanLen = Math.hypot(tanX, tanY);

        if (tanLen > 0.05) {
          tx = tanX / tanLen;
          ty = tanY / tanLen;
          const cosHalf = v1x * tx + v1y * ty;
          miterScale = Math.min(1.8, 1 / Math.max(0.35, cosHalf));
        } else {
          tx = v1x;
          ty = v1y;
        }
      }

      // Perpendicular normal in XY
      const nx = -ty * halfWTrack * miterScale;
      const ny = tx * halfWTrack * miterScale;

      const zTop = cur.zSurf + trackExtrude;
      const zBot =
        opts.baseShape === 'ribbon' ? 0 : Math.max(0.2, cur.zSurf - 0.4);

      sections.push({
        LTop: [cur.x + nx, cur.y + ny, zTop],
        RTop: [cur.x - nx, cur.y - ny, zTop],
        LBot: [cur.x + nx, cur.y + ny, zBot],
        RBot: [cur.x - nx, cur.y - ny, zBot],
      });
    }

    // Connect sections continuously without gaps
    for (let i = 0; i < sections.length - 1; i += 1) {
      const s0 = sections[i];
      const s1 = sections[i + 1];

      const pushQuad = (
        p0: [number, number, number],
        p1: [number, number, number],
        p2: [number, number, number],
        p3: [number, number, number]
      ) => {
        const v0 = new THREE.Vector3(...p0);
        const v1 = new THREE.Vector3(...p1);
        const v2 = new THREE.Vector3(...p2);
        const n = new THREE.Vector3().subVectors(v1, v0).cross(new THREE.Vector3().subVectors(v2, v0)).normalize();

        const baseIdx = trackPositions.length / 3;
        trackPositions.push(...p0, ...p1, ...p2, ...p3);
        trackNormals.push(n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z);
        trackIndices.push(baseIdx, baseIdx + 1, baseIdx + 2, baseIdx, baseIdx + 2, baseIdx + 3);
      };

      // Top surface ribbon
      pushQuad(s0.LTop, s0.RTop, s1.RTop, s1.LTop);

      // Bottom surface ribbon
      pushQuad(s0.LBot, s1.LBot, s1.RBot, s0.RBot);

      // Left wall
      pushQuad(s0.LBot, s0.LTop, s1.LTop, s1.LBot);

      // Right wall
      pushQuad(s0.RTop, s0.RBot, s1.RBot, s1.RTop);
    }

    // Start Cap
    const sStart = sections[0];
    const pushCap = (
      p0: [number, number, number],
      p1: [number, number, number],
      p2: [number, number, number],
      p3: [number, number, number]
    ) => {
      const v0 = new THREE.Vector3(...p0);
      const v1 = new THREE.Vector3(...p1);
      const v2 = new THREE.Vector3(...p2);
      const n = new THREE.Vector3().subVectors(v1, v0).cross(new THREE.Vector3().subVectors(v2, v0)).normalize();

      const baseIdx = trackPositions.length / 3;
      trackPositions.push(...p0, ...p1, ...p2, ...p3);
      trackNormals.push(n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z);
      trackIndices.push(baseIdx, baseIdx + 1, baseIdx + 2, baseIdx, baseIdx + 2, baseIdx + 3);
    };

    pushCap(sStart.LBot, sStart.RBot, sStart.RTop, sStart.LTop);

    // End Cap
    const sEnd = sections[sections.length - 1];
    pushCap(sEnd.RBot, sEnd.LBot, sEnd.LTop, sEnd.RTop);

    const trackGeom = new THREE.BufferGeometry();
    trackGeom.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(trackPositions, 3)
    );
    trackGeom.setAttribute('normal', new THREE.Float32BufferAttribute(trackNormals, 3));
    trackGeom.setIndex(trackIndices);

    const trackMat = new THREE.MeshStandardMaterial({
      color: palette.track,
      roughness: 0.35,
      metalness: 0.2,
      emissive: palette.track,
      emissiveIntensity: 0.16,
    });

    const trackMesh = new THREE.Mesh(trackGeom, trackMat);
    trackMesh.name = 'trackMesh';
    trackMesh.castShadow = true;
    displayGroup.add(trackMesh);
    exportGroup.add(trackMesh.clone());
    totalTriangles += trackIndices.length / 3;
  }

  // 4. 3D TITLE PLAQUE & EMBOSSED TEXT (Fixes text inside model bug)
  const cleanTitle = opts.titleText.trim().toUpperCase().slice(0, 24);
  if (cleanTitle.length > 0 && opts.baseShape !== 'ribbon') {
    const charHeight = opts.titleSizeMm;
    const pixelSize = charHeight / 7;
    const charWidth = 5 * pixelSize;
    const charGap = 1.4 * pixelSize;
    const totalTextW = cleanTitle.length * (charWidth + charGap) - charGap;

    const plaqueW = Math.min(halfW * 1.9, Math.max(totalTextW + 12, 48));
    const plaqueH = charHeight + 6;

    // Plaque sits at the front (South edge: -halfH) firmly outside/in front of the model
    const plaqueY0 = -halfH - plaqueH + 1.0;
    const plaqueY1 = -halfH + 1.0;
    const plaqueZ0 = 0;
    const plaqueZ1 = opts.baseThicknessMm + 0.6;

    const plaquePositions: number[] = [];
    const plaqueNormals: number[] = [];
    const plaqueIndices: number[] = [];

    pushBoxToBuffers(
      plaquePositions,
      plaqueNormals,
      plaqueIndices,
      -plaqueW / 2,
      plaqueY0,
      plaqueZ0,
      plaqueW / 2,
      plaqueY1,
      plaqueZ1
    );

    const plaqueGeom = new THREE.BufferGeometry();
    plaqueGeom.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(plaquePositions, 3)
    );
    plaqueGeom.setAttribute(
      'normal',
      new THREE.Float32BufferAttribute(plaqueNormals, 3)
    );
    plaqueGeom.setIndex(plaqueIndices);

    const plaqueMat = new THREE.MeshStandardMaterial({
      color: palette.base.clone().multiplyScalar(0.75),
      roughness: 0.5,
      metalness: 0.2,
    });

    const plaqueMesh = new THREE.Mesh(plaqueGeom, plaqueMat);
    plaqueMesh.name = 'plaqueMesh';
    displayGroup.add(plaqueMesh);
    exportGroup.add(plaqueMesh.clone());
    totalTriangles += plaqueIndices.length / 3;

    // Embossed 3D Letter Glyphs standing PROUDLY on top of the plaque (Z = plaqueZ1 to plaqueZ1 + 1.6)
    const textPositions: number[] = [];
    const textNormals: number[] = [];
    const textIndices: number[] = [];

    const startX = -totalTextW / 2;
    const startY = plaqueY0 + (plaqueH - charHeight) / 2;
    const letterZ0 = plaqueZ1;
    const letterZ1 = plaqueZ1 + 1.5; // Raised 1.5mm above plaque face

    for (let cIdx = 0; cIdx < cleanTitle.length; cIdx += 1) {
      const ch = cleanTitle[cIdx];
      const glyph = FONT_5X7[ch];
      if (!glyph) continue;

      const charX = startX + cIdx * (charWidth + charGap);

      for (let r = 0; r < 7; r += 1) {
        const rowStr = glyph[6 - r];
        for (let col = 0; col < 5; col += 1) {
          if (rowStr[col] === '1') {
            const px0 = charX + col * pixelSize;
            const py0 = startY + r * pixelSize;
            const px1 = px0 + pixelSize * 0.94;
            const py1 = py0 + pixelSize * 0.94;

            pushBoxToBuffers(
              textPositions,
              textNormals,
              textIndices,
              px0,
              py0,
              letterZ0,
              px1,
              py1,
              letterZ1
            );
          }
        }
      }
    }

    if (textIndices.length > 0) {
      const textGeom = new THREE.BufferGeometry();
      textGeom.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(textPositions, 3)
      );
      textGeom.setAttribute(
        'normal',
        new THREE.Float32BufferAttribute(textNormals, 3)
      );
      textGeom.setIndex(textIndices);

      const textMat = new THREE.MeshStandardMaterial({
        color: palette.track,
        roughness: 0.3,
        metalness: 0.3,
        emissive: palette.track,
        emissiveIntensity: 0.12,
      });

      const textMesh = new THREE.Mesh(textGeom, textMat);
      textMesh.name = 'textMesh';
      displayGroup.add(textMesh);
      exportGroup.add(textMesh.clone());
      totalTriangles += textIndices.length / 3;
    }
  }

  return {
    displayGroup,
    exportGroup,
    stats: {
      triangleCount: totalTriangles,
      widthMm: Math.round(halfW * 2),
      lengthMm: Math.round(halfH * 2),
      heightMm: Math.round(opts.baseThicknessMm + maxReliefMm + opts.trackHeightMm),
    },
  };
}

/**
 * Export the combined 3D meshes as a watertight binary STL Blob for 3D printing
 */
export function exportSceneToBinaryStl(
  exportGroup: THREE.Group,
  _modelName = 'GPX_3D_Model'
): Blob {
  const exporter = new STLExporter();
  const stlData = exporter.parse(exportGroup, { binary: true });
  const buffer =
    stlData instanceof DataView
      ? stlData.buffer
      : new TextEncoder().encode(stlData as string).buffer;
  return new Blob([buffer], { type: 'application/octet-stream' });
}
