import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Font, type FontData } from 'three/examples/jsm/loaders/FontLoader.js';
import { TrackPoint } from '../types/gpx';
import helvetikerBold from '../assets/fonts/helvetiker_bold.typeface.json';

export type BaseShape3D = 'rectangle' | 'circle' | 'hexagon' | 'ribbon';
export type ColorTheme3D =
  | 'satellite'
  | 'topo'
  | 'alpine'
  | 'volcanic'
  | 'glacier'
  | 'pla'
  | 'custom';

export type TrackStyle3D = 'tube' | 'ribbon';
export type PlaquePosition3D = 'bottom' | 'top' | 'left' | 'right';

export interface Terrain3DOptions {
  baseShape: BaseShape3D;
  modelWidthMm: number; // map area width (X). Circle/hexagon: diameter
  modelHeightMm: number; // map area height (Y). Ignored for circle/hexagon
  gridSize: number; // e.g. 40..80
  zExaggeration: number; // 0.5 .. 3.5
  baseThicknessMm: number; // 3 .. 20
  trackWidthMm: number; // 1.0 .. 5.0
  trackHeightMm: number; // 0.8 .. 4.0
  trackStyle: TrackStyle3D; // 'tube' | 'ribbon'
  trackSmoothness: number; // 0.0 .. 1.0 (default 0.7)
  showMarkers: boolean;
  enablePlaqueTitle?: boolean;
  titleText: string;
  titleDateText?: string;
  titleDistanceText?: string;
  titleDurationText?: string;
  titleElevationText?: string;
  showPlaqueStats?: boolean;
  titleSizeMm: number; // 4 .. 12
  plaquePosition?: PlaquePosition3D;
  textRotationDeg?: number; // 0 .. 359, clockwise, rotates the plaque text block
  keychainEnabled?: boolean;
  keychainOuterDiameterMm?: number;
  keychainHoleDiameterMm?: number;
  keychainAngleDeg?: number; // 0/360 = top (north), clockwise
  keychainThicknessMm?: number;
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

/**
 * Padded lat/lon bounding box of the track. When targetAspect (ground width /
 * ground height) is given, the box is grown in one direction to match it so the
 * map fills a model of that aspect without distortion.
 */
export function computeTrackBoundingBox(
  points: TrackPoint[],
  targetAspect?: number,
  round = false
) {
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
  const box = {
    minLat: minLat - latPad,
    maxLat: maxLat + latPad,
    minLon: minLon - lonPad,
    maxLon: maxLon + lonPad,
  };
  if (targetAspect && targetAspect > 0 && Number.isFinite(targetAspect)) {
    const cosLat = Math.max(0.2, Math.cos((((box.minLat + box.maxLat) / 2) * Math.PI) / 180));
    const groundW = (box.maxLon - box.minLon) * cosLat;
    const groundH = box.maxLat - box.minLat;
    if (groundW / groundH < targetAspect) {
      const extra = (groundH * targetAspect) / cosLat - (box.maxLon - box.minLon);
      box.minLon -= extra / 2;
      box.maxLon += extra / 2;
    } else {
      const extra = groundW / targetAspect - groundH;
      box.minLat -= extra / 2;
      box.maxLat += extra / 2;
    }
  }
  if (round) {
    // Circle / hexagon bases only show the inscribed disc of the box: grow the
    // box until every track point sits inside it with some margin
    const cLat = (box.minLat + box.maxLat) / 2;
    const cLon = (box.minLon + box.maxLon) / 2;
    const hLat = (box.maxLat - box.minLat) / 2;
    const hLon = (box.maxLon - box.minLon) / 2;
    let maxR = 0;
    for (const p of points) {
      maxR = Math.max(maxR, Math.hypot((p.lon - cLon) / hLon, (p.lat - cLat) / hLat));
    }
    const limit = 0.78;
    if (maxR > limit) {
      const k = maxR / limit;
      box.minLat = cLat - hLat * k;
      box.maxLat = cLat + hLat * k;
      box.minLon = cLon - hLon * k;
      box.maxLon = cLon + hLon * k;
    }
  }
  return box;
}

/** Ground aspect (width / height) of the padded track bounding box */
export function computeTrackAspect(points: TrackPoint[]): number {
  if (points.length < 2) return 1;
  const b = computeTrackBoundingBox(points);
  const cosLat = Math.max(0.2, Math.cos((((b.minLat + b.maxLat) / 2) * Math.PI) / 180));
  return ((b.maxLon - b.minLon) * cosLat) / Math.max(1e-9, b.maxLat - b.minLat);
}

/**
 * Fetches stitched tile canvas for the track's bounding box
 */
async function fetchStitchedTileCanvas(
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number },
  urlBuilder: (z: number, x: number, y: number) => string,
  outSize = 512,
  smoothing = true
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
  const oCtx = outCanvas.getContext('2d', { willReadFrequently: !smoothing })!;
  // Encoded data tiles (Terrarium DEM) must not be interpolated: blending the
  // packed R/G/B channels of neighbouring pixels yields bogus elevations.
  oCtx.imageSmoothingEnabled = smoothing;
  oCtx.drawImage(stitchCanvas, cropX, cropY, cropW, cropH, 0, 0, outSize, outSize);
  return outCanvas;
}

/**
 * Fetches 3D terrain depth map (AWS Terrarium DEM) and satellite/topo textures
 */
export async function fetchMap3DTerrainAndTextures(
  points: TrackPoint[],
  targetAspect?: number,
  round = false
): Promise<Map3DBundle> {
  const bbox = computeTrackBoundingBox(points, targetAspect, round);

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
      gridDim,
      false
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

// Plaque typography: real vector font (Helvetiker Bold, MgOpen license, see
// src/assets/fonts/LICENSE-helvetiker.txt). Glyph outlines come with correct
// winding and holes, so ExtrudeGeometry produces clean, closed solids.
let plaqueFont: Font | null = null;
let plaqueFontCapRatio = 0.72;

function getPlaqueFont(): Font {
  if (!plaqueFont) {
    plaqueFont = new Font(helvetikerBold as unknown as FontData);
    // Measure the cap height of 'H' at size 1 so charHeight maps to capital height
    const hShapes = plaqueFont.generateShapes('H', 1);
    let maxY = 0;
    for (const s of hShapes) {
      for (const pt of s.getPoints()) if (pt.y > maxY) maxY = pt.y;
    }
    if (maxY > 0) plaqueFontCapRatio = maxY;
  }
  return plaqueFont;
}

// Strip accents (É -> E) and replace characters the font cannot draw
function sanitizePlaqueText(text: string, font: Font): string {
  const glyphs = font.data.glyphs;
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split('')
    .map((ch) => (ch === ' ' || ch === '\n' || glyphs[ch] ? ch : ''))
    .join('');
}

/**
 * Builds extruded 3D text geometry for the plaque. Each line is centered
 * horizontally, shrunk to fit maxAllowedWidth, and its capital height is
 * vertically centered on line.centerY. The text is sunk slightly into the
 * plaque so it fuses with the base when sliced.
 */
function buildTextGeometry(
  lines: Array<{ text: string; charHeight: number; centerY: number }>,
  maxAllowedWidth: number,
  baseZ: number,
  embossHeight = 1.2
): THREE.BufferGeometry | null {
  const font = getPlaqueFont();
  const sinkDepth = 0.2;
  const allGeoms: THREE.BufferGeometry[] = [];

  for (const line of lines) {
    const text = sanitizePlaqueText(line.text, font);
    if (!text.trim()) continue;

    const emSize = line.charHeight / plaqueFontCapRatio;
    const shapes = font.generateShapes(text, emSize);
    if (shapes.length === 0) continue;

    const geom = new THREE.ExtrudeGeometry(shapes, {
      depth: embossHeight + sinkDepth,
      bevelEnabled: false,
      curveSegments: 6,
    });
    geom.computeBoundingBox();
    const bb = geom.boundingBox!;
    const lineW = bb.max.x - bb.min.x;

    const fit = lineW > maxAllowedWidth && maxAllowedWidth > 15 ? maxAllowedWidth / lineW : 1;
    const capH = line.charHeight * fit;

    geom.translate(-(bb.min.x + bb.max.x) / 2, 0, 0);
    if (fit !== 1) geom.scale(fit, fit, 1);
    geom.translate(0, line.centerY - capH / 2, baseZ - sinkDepth);
    allGeoms.push(geom);
  }

  if (allGeoms.length === 0) return null;
  const merged =
    allGeoms.length === 1 ? allGeoms[0] : BufferGeometryUtils.mergeGeometries(allGeoms);
  if (merged !== allGeoms[0]) allGeoms.forEach((g) => g.dispose());
  return merged;
}

function clampNum(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Ground aspect (width / height) the map area must have for these options */
export function getTargetAspect(
  opts: Pick<Terrain3DOptions, 'baseShape' | 'modelWidthMm' | 'modelHeightMm'>
): number {
  if (opts.baseShape === 'circle' || opts.baseShape === 'hexagon') return 1;
  const w = clampNum(opts.modelWidthMm || 110, 30, 300);
  const h = clampNum(opts.modelHeightMm || 110, 30, 300);
  return w / h;
}

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
    : computeTrackBoundingBox(
        points,
        getTargetAspect(opts),
        opts.baseShape === 'circle' || opts.baseShape === 'hexagon'
      );

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

  const isRound = opts.baseShape === 'circle' || opts.baseShape === 'hexagon';
  const modelW = clampNum(opts.modelWidthMm || 110, 30, 300);
  const modelH = isRound ? modelW : clampNum(opts.modelHeightMm || 110, 30, 300);
  const halfW = modelW / 2;
  const halfH = modelH / 2;

  const eleSpan = Math.max(10, maxEle - minEle);
  const maxReliefMm = 26 * opts.zExaggeration;
  const baseZ = opts.baseThicknessMm;
  const eleToZ = (ele: number) =>
    baseZ + Math.max(0, ((ele - minEle) / eleSpan) * maxReliefMm);

  const hasPlaque =
    opts.baseShape !== 'ribbon' &&
    opts.enablePlaqueTitle !== false &&
    Boolean(opts.titleText.trim() || opts.showPlaqueStats);

  // Plaque layout. Geometry is built in a local frame where the plaque hangs
  // below the bottom edge (y < -edgeDist), then rotated into place.
  const plaquePos: PlaquePosition3D = opts.plaquePosition ?? 'bottom';
  const plaqueOnSide = plaquePos === 'left' || plaquePos === 'right';
  const edgeHalfLen = plaqueOnSide ? halfH : halfW; // half length of the attached edge
  const edgeDist = plaqueOnSide ? halfW : halfH; // centre -> attached edge
  const plaqueRotation =
    plaquePos === 'right' ? Math.PI / 2 : plaquePos === 'top' ? Math.PI : plaquePos === 'left' ? -Math.PI / 2 : 0;
  const plaqueH = opts.showPlaqueStats
    ? Math.max(22, opts.titleSizeMm * 2.8)
    : Math.max(13, opts.titleSizeMm * 1.8);
  const plaqueW = Math.min(edgeHalfLen * 1.85, Math.max(56, edgeHalfLen * 1.5));
  const toGlobalXY = (x: number, y: number): [number, number] => {
    const cr = Math.cos(plaqueRotation);
    const sr = Math.sin(plaqueRotation);
    return [x * cr - y * sr, x * sr + y * cr];
  };

  // 2D footprint of the model (mm), used to attach the keychain ring
  const footprintPolys: Array<Array<[number, number]>> = [];
  let footprintPath: { pts: Array<[number, number]>; halfWidth: number } | null = null;

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

  // Lowest printed terrain height near (x, y), read from the actual terrain
  // mesh nodes. Set once the terrain grid exists; null for the bare ribbon base.
  let terrainFloorAt: ((x: number, y: number) => number) | null = null;

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

    {
      // Bin the grid nodes so a point's surrounding mesh nodes can be found quickly
      const cell = (2 * Math.max(halfW, halfH)) / N;
      const radius = cell * 2;
      const bins = new Map<string, number[]>();
      for (let r = 0; r <= N; r += 1) {
        for (let c = 0; c <= N; c += 1) {
          const [x, y, z] = gridXYZ[r][c];
          const k = `${Math.floor(x / radius)},${Math.floor(y / radius)}`;
          let b = bins.get(k);
          if (!b) bins.set(k, (b = []));
          b.push(x, y, z);
        }
      }
      terrainFloorAt = (x: number, y: number) => {
        const bx = Math.floor(x / radius);
        const by = Math.floor(y / radius);
        let zMin = Infinity;
        for (let i = -1; i <= 1; i += 1) {
          for (let j = -1; j <= 1; j += 1) {
            const b = bins.get(`${bx + i},${by + j}`);
            if (!b) continue;
            for (let k = 0; k < b.length; k += 3) {
              const dx = b[k] - x;
              const dy = b[k + 1] - y;
              if (dx * dx + dy * dy <= radius * radius && b[k + 2] < zMin) zMin = b[k + 2];
            }
          }
        }
        return zMin === Infinity ? eleToZ(evalElevationAtXY(x, y)) : zMin;
      };
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

    const outline: Array<[number, number]> = [];
    for (let c = 0; c < N; c += 1) outline.push([gridXYZ[0][c][0], gridXYZ[0][c][1]]);
    for (let r = 0; r < N; r += 1) outline.push([gridXYZ[r][N][0], gridXYZ[r][N][1]]);
    for (let c = N; c > 0; c -= 1) outline.push([gridXYZ[N][c][0], gridXYZ[N][c][1]]);
    for (let r = N; r > 0; r -= 1) outline.push([gridXYZ[r][0][0], gridXYZ[r][0][1]]);
    footprintPolys.push(outline);

    if (hasPlaque) {
      // 2b. SOLID EMBOSSED PLAQUE & CONNECTING BRIDGE (ONE CONTINUOUS MODEL)
      // Solidly joins the base (Circle, Hexagon, or Rectangle) with the bottom plaque
      // using a full-depth bridge so there is ZERO gap or separation.
      const plaquePositions: number[] = [];
      const plaqueNormals: number[] = [];
      const plaqueIndices: number[] = [];

      const halfPlaqueW = plaqueW / 2;

      const plaqueYBot = -edgeDist - plaqueH;
      const plaqueYTop = -edgeDist;
      const plaqueZ0 = 0;
      const plaqueZ1 = baseZ;

      // 1. Plaque body platform at the bottom (South)
      pushBoxToBuffers(
        plaquePositions,
        plaqueNormals,
        plaqueIndices,
        -halfPlaqueW,
        plaqueYBot,
        plaqueZ0,
        halfPlaqueW,
        plaqueYTop,
        plaqueZ1
      );

      // 2. Solid connecting bridge: fills the gap between base bottom and plaque
      // For Circle/Hexagon, extends well into the base (up to y = -halfH * 0.60)
      // to guarantee a continuous solid connection with ZERO gap or separation.
      const bridgeYTop = opts.baseShape === 'rectangle' ? -edgeDist + 1.5 : -edgeDist * 0.6;
      const bridgeYBot = -edgeDist - 1.0; // overlap into plaque
      const bridgeW = Math.min(plaqueW, edgeHalfLen * 1.45);
      const halfBridgeW = bridgeW / 2;

      pushBoxToBuffers(
        plaquePositions,
        plaqueNormals,
        plaqueIndices,
        -halfBridgeW,
        bridgeYBot,
        plaqueZ0,
        halfBridgeW,
        bridgeYTop,
        plaqueZ1
      );

      const plaqueGeom = new THREE.BufferGeometry();
      plaqueGeom.setAttribute('position', new THREE.Float32BufferAttribute(plaquePositions, 3));
      plaqueGeom.setAttribute('normal', new THREE.Float32BufferAttribute(plaqueNormals, 3));
      plaqueGeom.setIndex(plaqueIndices);
      if (plaqueRotation !== 0) plaqueGeom.rotateZ(plaqueRotation);

      const rectPoly = (x0: number, y0: number, x1: number, y1: number) =>
        [toGlobalXY(x0, y0), toGlobalXY(x1, y0), toGlobalXY(x1, y1), toGlobalXY(x0, y1)];
      footprintPolys.push(rectPoly(-halfPlaqueW, plaqueYBot, halfPlaqueW, plaqueYTop));
      footprintPolys.push(rectPoly(-halfBridgeW, bridgeYBot, halfBridgeW, bridgeYTop));

      const plaqueMesh = new THREE.Mesh(plaqueGeom, baseMat);
      plaqueMesh.name = 'plaqueMesh';
      plaqueMesh.receiveShadow = true;
      displayGroup.add(plaqueMesh);
      exportGroup.add(plaqueMesh.clone());
      totalTriangles += plaqueIndices.length / 3;
    }
  }

  // 3. SILKY SMOOTH, TWIST-FREE 3D TRACK
  // Completely eliminates creases, self-intersections, and origami facets.
  const rawPath: Array<{ x: number; y: number; ele: number }> = [];
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    const u = ((p.lon - bbox.minLon) / Math.max(1e-6, bbox.maxLon - bbox.minLon)) * 2 - 1;
    const v = ((p.lat - bbox.minLat) / Math.max(1e-6, bbox.maxLat - bbox.minLat)) * 2 - 1;
    // Same linear lat/lon -> mm mapping the terrain uses, so the track lines up
    // with the terrain relief and texture on every base shape
    rawPath.push({ x: u * halfW, y: v * halfH, ele: ptEles[i] });
  }

  // Filter duplicate or micro-distance points relative to track thickness
  const minPtDist = Math.max(0.18, opts.trackWidthMm * 0.12);
  const filteredPath: Array<{ x: number; y: number; ele: number }> = [];
  for (let i = 0; i < rawPath.length; i += 1) {
    if (i === 0) {
      filteredPath.push(rawPath[0]);
    } else {
      const prev = filteredPath[filteredPath.length - 1];
      const cur = rawPath[i];
      if (Math.hypot(cur.x - prev.x, cur.y - prev.y) >= minPtDist) {
        filteredPath.push(cur);
      }
    }
  }

  if (filteredPath.length >= 2) {
    // Curvature-aware multi-pass smoothing on XY & elevation
    // The number of passes scales with track width so that the path radius of curvature
    // always stays strictly larger than the track thickness, eliminating accordion crumpling.
    const smoothness = Math.max(0, Math.min(1, opts.trackSmoothness ?? 0.7));
    const smoothPasses = Math.max(2, Math.round(2 + smoothness * 4 + opts.trackWidthMm * 0.75));
    const smoothAlpha = 0.35 + smoothness * 0.25;

    let pathXY = filteredPath.map((p) => ({ ...p }));
    for (let pass = 0; pass < smoothPasses; pass += 1) {
      const nextPath = pathXY.map((p) => ({ ...p }));
      for (let i = 1; i < pathXY.length - 1; i += 1) {
        const prev = pathXY[i - 1];
        const cur = pathXY[i];
        const next = pathXY[i + 1];
        nextPath[i].x = cur.x * (1 - smoothAlpha) + ((prev.x + next.x) * 0.5) * smoothAlpha;
        nextPath[i].y = cur.y * (1 - smoothAlpha) + ((prev.y + next.y) * 0.5) * smoothAlpha;
        nextPath[i].ele = cur.ele * (1 - smoothAlpha) + ((prev.ele + next.ele) * 0.5) * smoothAlpha;
      }
      pathXY = nextPath;
    }

    // Cumulative arc length
    const cumDist: number[] = [0];
    for (let i = 1; i < pathXY.length; i += 1) {
      const prev = pathXY[i - 1];
      const cur = pathXY[i];
      cumDist.push(cumDist[i - 1] + Math.hypot(cur.x - prev.x, cur.y - prev.y));
    }
    const totalPathLen = cumDist[cumDist.length - 1];

    if (totalPathLen > 0.2) {
      // Equidistant resampling: step size scaled with track width to prevent ring overlap
      const sampleStep = Math.max(0.75, Math.min(2.5, opts.trackWidthMm * 0.65));
      const numSegments = Math.max(36, Math.min(500, Math.round(totalPathLen / sampleStep)));

      const sampledPts: Array<{ x: number; y: number; ele: number }> = [];
      let curIdx = 0;
      for (let i = 0; i <= numSegments; i += 1) {
        const targetD = (i / numSegments) * totalPathLen;
        while (curIdx < cumDist.length - 2 && cumDist[curIdx + 1] < targetD) {
          curIdx += 1;
        }
        const d0 = cumDist[curIdx];
        const d1 = cumDist[curIdx + 1];
        const segmentLen = d1 - d0;
        const t = segmentLen > 1e-6 ? (targetD - d0) / segmentLen : 0;
        const p0 = pathXY[curIdx];
        const p1 = pathXY[curIdx + 1];

        sampledPts.push({
          x: p0.x + (p1.x - p0.x) * t,
          y: p0.y + (p1.y - p0.y) * t,
          ele: p0.ele + (p1.ele - p0.ele) * t,
        });
      }

      // Sample terrain surface elevation and apply moving-average Z smoothing
      const rawZ: number[] = [];
      for (let i = 0; i <= numSegments; i += 1) {
        const p = sampledPts[i];
        const surfEle =
          opts.baseShape === 'ribbon'
            ? p.ele
            : evalElevationAtXY(p.x, p.y);
        rawZ.push(eleToZ(surfEle));
      }

      const smoothedZ: number[] = [];
      for (let i = 0; i <= numSegments; i += 1) {
        if (i === 0 || i === numSegments) {
          smoothedZ.push(rawZ[i]);
        } else {
          smoothedZ.push(rawZ[i - 1] * 0.25 + rawZ[i] * 0.5 + rawZ[i + 1] * 0.25);
        }
      }

      // Track bottom edge: below the lowest terrain mesh node around the point,
      // so the track fuses into the terrain and never rests on or above it
      const trackSink = 0.5;
      const edgeBottomZ = (x: number, y: number, zSurf: number) => {
        if (!terrainFloorAt) return 0;
        return Math.max(0.2, Math.min(zSurf, terrainFloorAt(x, y)) - trackSink);
      };

      let trackGeom: THREE.BufferGeometry;

      if (opts.trackStyle === 'ribbon') {
        // --- SMOOTH BEVELED RIBBON (Twist-Free Orthonormal Framing) ---
        const halfWidth = opts.trackWidthMm * 0.5;
        const extrudeH = opts.trackHeightMm;

        const ribbonPositions: number[] = [];
        const ribbonNormals: number[] = [];
        const ribbonIndices: number[] = [];

        interface RibbonCrossSection {
          LTop: [number, number, number];
          RTop: [number, number, number];
          LBot: [number, number, number];
          RBot: [number, number, number];
        }

        const sections: RibbonCrossSection[] = [];

        for (let i = 0; i <= numSegments; i += 1) {
          const cur = sampledPts[i];
          const zSurf = smoothedZ[i];

          let tx = 0;
          let ty = 0;
          if (i === 0) {
            const next = sampledPts[1];
            const l = Math.hypot(next.x - cur.x, next.y - cur.y) || 1;
            tx = (next.x - cur.x) / l;
            ty = (next.y - cur.y) / l;
          } else if (i === numSegments) {
            const prev = sampledPts[numSegments - 1];
            const l = Math.hypot(cur.x - prev.x, cur.y - prev.y) || 1;
            tx = (cur.x - prev.x) / l;
            ty = (cur.y - prev.y) / l;
          } else {
            const prev = sampledPts[i - 1];
            const next = sampledPts[i + 1];
            const l = Math.hypot(next.x - prev.x, next.y - prev.y) || 1;
            tx = (next.x - prev.x) / l;
            ty = (next.y - prev.y) / l;
          }

          const nx = -ty * halfWidth;
          const ny = tx * halfWidth;

          const zTop = zSurf + extrudeH;
          const zBotL = edgeBottomZ(cur.x + nx, cur.y + ny, zSurf);
          const zBotR = edgeBottomZ(cur.x - nx, cur.y - ny, zSurf);

          let LTop: [number, number, number] = [cur.x + nx, cur.y + ny, zTop];
          let RTop: [number, number, number] = [cur.x - nx, cur.y - ny, zTop];
          let LBot: [number, number, number] = [cur.x + nx, cur.y + ny, zBotL];
          let RBot: [number, number, number] = [cur.x - nx, cur.y - ny, zBotR];

          // Anti-inversion guard: prevents inner edge from folding backwards at sharp bends
          if (sections.length > 0) {
            const prev = sections[sections.length - 1];
            const pPrev = sampledPts[i - 1];
            const segDx = cur.x - pPrev.x;
            const segDy = cur.y - pPrev.y;
            const segL = Math.hypot(segDx, segDy) || 1e-5;
            const fwdX = segDx / segL;
            const fwdY = segDy / segL;

            const dL = (LTop[0] - prev.LTop[0]) * fwdX + (LTop[1] - prev.LTop[1]) * fwdY;
            if (dL < segL * 0.15) {
              const push = segL * 0.15 - dL;
              LTop = [LTop[0] + fwdX * push, LTop[1] + fwdY * push, zTop];
              LBot = [LBot[0] + fwdX * push, LBot[1] + fwdY * push, zBotL];
            }

            const dR = (RTop[0] - prev.RTop[0]) * fwdX + (RTop[1] - prev.RTop[1]) * fwdY;
            if (dR < segL * 0.15) {
              const push = segL * 0.15 - dR;
              RTop = [RTop[0] + fwdX * push, RTop[1] + fwdY * push, zTop];
              RBot = [RBot[0] + fwdX * push, RBot[1] + fwdY * push, zBotR];
            }
          }

          sections.push({ LTop, RTop, LBot, RBot });
        }

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
            const n = new THREE.Vector3()
              .subVectors(v1, v0)
              .cross(new THREE.Vector3().subVectors(v2, v0))
              .normalize();

            const baseIdx = ribbonPositions.length / 3;
            ribbonPositions.push(...p0, ...p1, ...p2, ...p3);
            ribbonNormals.push(n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z);
            ribbonIndices.push(baseIdx, baseIdx + 1, baseIdx + 2, baseIdx, baseIdx + 2, baseIdx + 3);
          };

          // Top
          pushQuad(s0.LTop, s0.RTop, s1.RTop, s1.LTop);
          // Bottom
          pushQuad(s0.LBot, s1.LBot, s1.RBot, s0.RBot);
          // Left
          pushQuad(s0.LBot, s0.LTop, s1.LTop, s1.LBot);
          // Right
          pushQuad(s0.RTop, s0.RBot, s1.RBot, s1.RTop);
        }

        const pushCap = (
          p0: [number, number, number],
          p1: [number, number, number],
          p2: [number, number, number],
          p3: [number, number, number]
        ) => {
          const v0 = new THREE.Vector3(...p0);
          const v1 = new THREE.Vector3(...p1);
          const v2 = new THREE.Vector3(...p2);
          const n = new THREE.Vector3()
            .subVectors(v1, v0)
            .cross(new THREE.Vector3().subVectors(v2, v0))
            .normalize();

          const baseIdx = ribbonPositions.length / 3;
          ribbonPositions.push(...p0, ...p1, ...p2, ...p3);
          ribbonNormals.push(n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z);
          ribbonIndices.push(baseIdx, baseIdx + 1, baseIdx + 2, baseIdx, baseIdx + 2, baseIdx + 3);
        };

        const sStart = sections[0];
        pushCap(sStart.LBot, sStart.RBot, sStart.RTop, sStart.LTop);
        const sEnd = sections[sections.length - 1];
        pushCap(sEnd.RBot, sEnd.LBot, sEnd.LTop, sEnd.RTop);

        trackGeom = new THREE.BufferGeometry();
        trackGeom.setAttribute('position', new THREE.Float32BufferAttribute(ribbonPositions, 3));
        trackGeom.setAttribute('normal', new THREE.Float32BufferAttribute(ribbonNormals, 3));
        trackGeom.setIndex(ribbonIndices);
        trackGeom.computeVertexNormals();
      } else {
        // --- GROUNDED ROUNDED-TOP TRACK ---
        // Cross-section: flat bottom sunk into the terrain, vertical walls and a
        // half-round (elliptical when low) top. It sits on the surface, so nothing
        // overhangs when printed. Z stays up, so the extrusion cannot twist.
        const halfWidth = Math.max(0.5, opts.trackWidthMm * 0.5);
        const trackH = opts.trackHeightMm;
        const capRy = Math.min(halfWidth, trackH);
        const wallTop = trackH - capRy;
        const arcSteps = 12;

        // Profile: right-bottom, arc over the top from right to left, left-bottom.
        // o = lateral offset (+ = left of travel), dz = height above the surface.
        const profile: Array<{ o: number; dz: number; bottom: boolean }> = [
          { o: -halfWidth, dz: 0, bottom: true },
        ];
        for (let k = 0; k <= arcSteps; k += 1) {
          const a = (k / arcSteps) * Math.PI;
          profile.push({
            o: -halfWidth * Math.cos(a),
            dz: wallTop + capRy * Math.sin(a),
            bottom: false,
          });
        }
        profile.push({ o: halfWidth, dz: 0, bottom: true });
        const P = profile.length;

        const tubePositions: number[] = [];
        const tubeIndices: number[] = [];
        const capCenters: Array<[number, number, number]> = [];

        for (let i = 0; i <= numSegments; i += 1) {
          const cur = sampledPts[i];
          const prev = sampledPts[Math.max(0, i - 1)];
          const next = sampledPts[Math.min(numSegments, i + 1)];
          const l = Math.hypot(next.x - prev.x, next.y - prev.y) || 1;
          const tx = (next.x - prev.x) / l;
          const ty = (next.y - prev.y) / l;
          const nx = -ty;
          const ny = tx;
          const zSurf = smoothedZ[i];

          // Bottom of each side follows the terrain under that side
          const zBotR = edgeBottomZ(cur.x - nx * halfWidth, cur.y - ny * halfWidth, zSurf);
          const zBotL = edgeBottomZ(cur.x + nx * halfWidth, cur.y + ny * halfWidth, zSurf);

          let fwdX = 0;
          let fwdY = 0;
          let segL = 0;
          if (i > 0) {
            const segDx = cur.x - prev.x;
            const segDy = cur.y - prev.y;
            segL = Math.hypot(segDx, segDy) || 1e-5;
            fwdX = segDx / segL;
            fwdY = segDy / segL;
          }

          let cx = 0;
          let cy = 0;
          let cz = 0;
          for (let j = 0; j < P; j += 1) {
            const pr = profile[j];
            let vx = cur.x + nx * pr.o;
            let vy = cur.y + ny * pr.o;
            const vz = pr.bottom ? (pr.o < 0 ? zBotR : zBotL) : zSurf + pr.dz;

            // Anti-inversion guard: keeps the inner side of tight bends from folding back
            if (i > 0) {
              const pi = ((i - 1) * P + j) * 3;
              const d = (vx - tubePositions[pi]) * fwdX + (vy - tubePositions[pi + 1]) * fwdY;
              if (d < segL * 0.15) {
                const push = segL * 0.15 - d;
                vx += fwdX * push;
                vy += fwdY * push;
              }
            }
            tubePositions.push(vx, vy, vz);
            cx += vx;
            cy += vy;
            cz += vz;
          }
          if (i === 0 || i === numSegments) capCenters.push([cx / P, cy / P, cz / P]);
        }

        // Side walls: outward winding (profile runs counter-clockwise seen from behind)
        for (let i = 0; i < numSegments; i += 1) {
          const a = i * P;
          const b = (i + 1) * P;
          for (let j = 0; j < P; j += 1) {
            const j1 = (j + 1) % P;
            tubeIndices.push(a + j, b + j, a + j1);
            tubeIndices.push(a + j1, b + j, b + j1);
          }
        }

        // End caps (fan from the profile centroid)
        const startC = tubePositions.length / 3;
        tubePositions.push(...capCenters[0]);
        for (let j = 0; j < P; j += 1) tubeIndices.push(startC, j, (j + 1) % P);
        const endC = tubePositions.length / 3;
        tubePositions.push(...capCenters[1]);
        const endBase = numSegments * P;
        for (let j = 0; j < P; j += 1) tubeIndices.push(endC, endBase + ((j + 1) % P), endBase + j);

        trackGeom = new THREE.BufferGeometry();
        trackGeom.setAttribute('position', new THREE.Float32BufferAttribute(tubePositions, 3));
        trackGeom.setIndex(tubeIndices);
        trackGeom.computeVertexNormals();
      }
      const trackMat = new THREE.MeshStandardMaterial({
        color: palette.track,
        roughness: 0.32,
        metalness: 0.22,
        emissive: palette.track,
        emissiveIntensity: 0.18,
        side: THREE.DoubleSide,
      });

      const trackMesh = new THREE.Mesh(trackGeom, trackMat);
      trackMesh.name = 'trackMesh';
      trackMesh.castShadow = true;
      displayGroup.add(trackMesh);
      exportGroup.add(trackMesh.clone());
      totalTriangles += trackGeom.index!.count / 3;

      footprintPath = {
        pts: sampledPts.map((p) => [p.x, p.y] as [number, number]),
        halfWidth: opts.trackWidthMm * 0.5,
      };

      // 4. Start & Finish markers: low domes centred on the track, standing on
      // the terrain (flat sunk base, vertical wall, rounded top). No overhang.
      if (opts.showMarkers) {
        const markerRadius = Math.max(1.4, opts.trackWidthMm * 0.85);
        const domeRise = opts.trackHeightMm + 0.6; // a little prouder than the track

        const buildMarker = (idx: number, color: string, emissive: string) => {
          const pt = sampledPts[idx];
          const zSurf = smoothedZ[idx];
          let zBottom = 0;
          if (terrainFloorAt) {
            zBottom = Math.min(zSurf, terrainFloorAt(pt.x, pt.y));
            for (let k = 0; k < 8; k += 1) {
              const a = (k / 8) * Math.PI * 2;
              const x = pt.x + Math.cos(a) * markerRadius;
              const y = pt.y + Math.sin(a) * markerRadius;
              zBottom = Math.min(zBottom, terrainFloorAt(x, y));
            }
            zBottom = Math.max(0.2, zBottom - 0.5);
          }

          // Lathe profile in (radius, z); revolved around Y then turned Z-up
          const prof: THREE.Vector2[] = [new THREE.Vector2(0, zBottom)];
          prof.push(new THREE.Vector2(markerRadius, zBottom));
          prof.push(new THREE.Vector2(markerRadius, zSurf));
          const steps = 8;
          for (let k = 1; k <= steps; k += 1) {
            const a = (k / steps) * (Math.PI / 2);
            prof.push(
              new THREE.Vector2(
                k === steps ? 0 : markerRadius * Math.cos(a),
                zSurf + domeRise * Math.sin(a)
              )
            );
          }
          const geom = new THREE.LatheGeometry(prof, 20);
          geom.rotateX(Math.PI / 2);
          geom.translate(pt.x, pt.y, 0);

          const mat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(color),
            roughness: 0.3,
            metalness: 0.2,
            emissive: new THREE.Color(emissive),
            emissiveIntensity: 0.2,
          });
          const mesh = new THREE.Mesh(geom, mat);
          mesh.castShadow = true;
          displayGroup.add(mesh);
          exportGroup.add(mesh.clone());
          totalTriangles += geom.index ? geom.index.count / 3 : geom.getAttribute('position').count / 3;
        };

        buildMarker(0, '#22c55e', '#15803d');
        buildMarker(numSegments, '#ef4444', '#b91c1c');
      }
    }
  }
  // 4. EMBOSSED 3D TITLE & STATS ON THE INTEGRATED PLAQUE PLATFORM
  // Solid continuous vector strokes sitting directly on the connected front plaque
  const cleanTitle = opts.titleText.trim().toUpperCase().slice(0, 26);
  const dateStr = (opts.titleDateText || '').trim().toUpperCase().slice(0, 16);
  const distStr = (opts.titleDistanceText || '').trim().toUpperCase().slice(0, 12);
  const durStr = (opts.titleDurationText || '').trim().toUpperCase().slice(0, 12);
  const eleStr = (opts.titleElevationText || '').trim().toUpperCase().slice(0, 10);

  const linesToRender: Array<{ text: string; charHeight: number; centerY: number }> = [];

  const plaqueYTop = -edgeDist;

  if (
    hasPlaque &&
    (cleanTitle.length > 0 || (opts.showPlaqueStats && (dateStr || distStr || eleStr)))
  ) {
    if (opts.showPlaqueStats) {
      // Line 1: Main Title
      const h1 = Math.max(3.8, Math.min(6.2, opts.titleSizeMm));
      // Line 2: Date • Distance
      const line2Parts = [dateStr, distStr].filter(Boolean);
      const line2 = line2Parts.join('  •  ');
      const h2 = Math.max(2.6, h1 * 0.62);
      // Line 3: Duration • Max Altitude
      const line3Parts = [durStr, eleStr ? `MAX ALT ${eleStr}` : ''].filter(Boolean);
      const line3 = line3Parts.join('  •  ');
      const h3 = Math.max(2.6, h1 * 0.62);

      const y1 = plaqueYTop - plaqueH * 0.26;
      const y2 = plaqueYTop - plaqueH * 0.56;
      const y3 = plaqueYTop - plaqueH * 0.82;

      if (cleanTitle) linesToRender.push({ text: cleanTitle, charHeight: h1, centerY: y1 });
      if (line2) linesToRender.push({ text: line2, charHeight: h2, centerY: y2 });
      if (line3) linesToRender.push({ text: line3, charHeight: h3, centerY: y3 });
    } else if (cleanTitle.length > 0) {
      // Single Title Line centered on the plaque
      const h1 = Math.max(4.5, Math.min(8.0, opts.titleSizeMm));
      const centerY = plaqueYTop - plaqueH * 0.50;
      linesToRender.push({ text: cleanTitle, charHeight: h1, centerY });
    }
  }

  const maxAllowedW = plaqueW - 8;

  if (linesToRender.length > 0) {
    const textGeom = buildTextGeometry(linesToRender, maxAllowedW, baseZ, 1.2);
    const textRotDeg = (((opts.textRotationDeg ?? 0) % 360) + 360) % 360;
    if (textGeom && textRotDeg !== 0) {
      // Rotate the text block around the plaque centre (clockwise as seen from
      // above), then shrink it if the rotated block no longer fits the plaque
      const cy = plaqueYTop - plaqueH / 2;
      textGeom.translate(0, -cy, 0);
      textGeom.rotateZ((-textRotDeg * Math.PI) / 180);
      textGeom.computeBoundingBox();
      const bb = textGeom.boundingBox!;
      const fit = Math.min(
        1,
        maxAllowedW / Math.max(1e-6, bb.max.x - bb.min.x),
        (plaqueH - 3) / Math.max(1e-6, bb.max.y - bb.min.y)
      );
      if (fit < 1) textGeom.scale(fit, fit, 1);
      textGeom.translate(0, cy, 0);
    }
    if (textGeom) {
      if (plaquePos === 'top') {
        // Keep the text upright for a viewer in front: move it to the top plaque unrotated
        textGeom.translate(0, 2 * edgeDist + plaqueH, 0);
      } else if (plaqueRotation !== 0) {
        // Side plaques: text runs along the edge, letters' tops facing the map
        textGeom.rotateZ(plaqueRotation);
      }
      const textMat = new THREE.MeshStandardMaterial({
        color: palette.track,
        roughness: 0.3,
        metalness: 0.25,
        emissive: palette.track,
        emissiveIntensity: 0.15,
      });

      const textMesh = new THREE.Mesh(textGeom, textMat);
      textMesh.name = 'textMesh';
      textMesh.castShadow = true;
      displayGroup.add(textMesh);
      exportGroup.add(textMesh.clone());
      totalTriangles += textGeom.index
        ? textGeom.index.count / 3
        : textGeom.getAttribute('position').count / 3;
    }
  }

  // 5. KEYCHAIN RING: flat ring on the print bed, pushed out along the chosen
  // compass angle until its hole clears the model, so only the band overlaps it
  if (opts.keychainEnabled && (footprintPolys.length > 0 || footprintPath)) {
    const outerR = clampNum((opts.keychainOuterDiameterMm ?? 14) / 2, 3, 20);
    const innerR = clampNum((opts.keychainHoleDiameterMm ?? 6) / 2, 1, outerR - 1.2);
    const thickness = clampNum(opts.keychainThicknessMm ?? 3, 1, 15);
    const clearance = 0.6;
    const angleRad = ((opts.keychainAngleDeg ?? 360) * Math.PI) / 180;
    const dirX = Math.sin(angleRad);
    const dirY = Math.cos(angleRad);

    const distToFootprint = (x: number, y: number): number => {
      let best = Infinity;
      for (const poly of footprintPolys) {
        if (pointInPolygon(x, y, poly)) return 0;
        for (let k = 0; k < poly.length; k += 1) {
          const a = poly[k];
          const b = poly[(k + 1) % poly.length];
          best = Math.min(best, distToSegment(x, y, a[0], a[1], b[0], b[1]));
        }
      }
      if (footprintPath) {
        const pts = footprintPath.pts;
        for (let k = 0; k < pts.length - 1; k += 1) {
          const d =
            distToSegment(x, y, pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]) -
            footprintPath.halfWidth;
          best = Math.min(best, Math.max(0, d));
        }
      }
      return best;
    };

    // Ray origin: model centre, or for a bare track the track point furthest along the ray
    let ox = 0;
    let oy = 0;
    if (footprintPolys.length === 0 && footprintPath) {
      let bestDot = -Infinity;
      for (const [x, y] of footprintPath.pts) {
        const d = x * dirX + y * dirY;
        if (d > bestDot) {
          bestDot = d;
          ox = x;
          oy = y;
        }
      }
    }

    const required = innerR + clearance;
    const step = 0.25;
    let t = Math.max(halfW, halfH) * 2 + (hasPlaque ? plaqueH : 0) + outerR + 10;
    while (t > 0 && distToFootprint(ox + dirX * (t - step), oy + dirY * (t - step)) >= required) {
      t -= step;
    }
    const ringX = ox + dirX * t;
    const ringY = oy + dirY * t;

    const ringShape = new THREE.Shape();
    ringShape.absarc(0, 0, outerR, 0, Math.PI * 2, false);
    const ringHole = new THREE.Path();
    ringHole.absarc(0, 0, innerR, 0, Math.PI * 2, true);
    ringShape.holes.push(ringHole);
    const ringGeom = new THREE.ExtrudeGeometry(ringShape, {
      depth: thickness,
      bevelEnabled: false,
      curveSegments: 32,
    });
    ringGeom.translate(ringX, ringY, 0);

    const ringMat = new THREE.MeshStandardMaterial({
      color: opts.baseShape === 'ribbon' ? palette.track : palette.base,
      roughness: 0.65,
      metalness: 0.15,
    });
    const ringMesh = new THREE.Mesh(ringGeom, ringMat);
    ringMesh.name = 'keychainRing';
    ringMesh.castShadow = true;
    ringMesh.receiveShadow = true;
    displayGroup.add(ringMesh);
    exportGroup.add(ringMesh.clone());
    totalTriangles += ringGeom.getAttribute('position').count / 3;
  }

  // Measure the real printed extents (base, plaque, track, ring)
  const extents = new THREE.Box3().setFromObject(exportGroup);
  const size = extents.isEmpty() ? new THREE.Vector3() : extents.getSize(new THREE.Vector3());

  return {
    displayGroup,
    exportGroup,
    stats: {
      triangleCount: Math.round(totalTriangles),
      widthMm: Math.round(size.x),
      lengthMm: Math.round(size.y),
      heightMm: Math.round(size.z),
    },
  };
}

function pointInPolygon(x: number, y: number, poly: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
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
