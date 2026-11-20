import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  EyeOff,
  Mountain,
  MoveVertical,
  RotateCcw,
  Sparkles,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { ComputedPointStats } from '../types/gpx';
import { formatDistance, getGradeColor } from '../utils/gpxParser';

interface ElevationChartProps {
  pointStats: ComputedPointStats[];
  selectedPointId: string | null;
  hoveredPointId: string | null;
  trimRangeIndices?: [number, number] | null;
  terrainElevations?: Record<string, number>;
  isFetchingTerrain?: boolean;
  onlyTerrain?: boolean;
  onToggleOnlyTerrain?: () => void;
  onFetchTerrain?: () => void;
  onApplyTerrain?: () => void;
  onSelectPoint: (pointId: string) => void;
  onHoverPoint: (pointId: string | null) => void;
  onAdjustPointValue?: (
    pointId: string,
    metric: 'elevation' | 'speed',
    newValue: number,
    smoothRadius: number
  ) => void;
}

const SMOOTH_RADIUS = 8;

function cosineWeight(offset: number, radius: number): number {
  if (radius <= 0) return offset === 0 ? 1 : 0;
  const abs = Math.abs(offset);
  if (abs > radius) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * abs) / (radius + 1)));
}

export const ElevationChart: React.FC<ElevationChartProps> = ({
  pointStats,
  selectedPointId,
  hoveredPointId,
  trimRangeIndices = null,
  terrainElevations,
  isFetchingTerrain = false,
  onlyTerrain = false,
  onToggleOnlyTerrain,
  onFetchTerrain,
  onApplyTerrain,
  onSelectPoint,
  onHoverPoint,
  onAdjustPointValue,
}) => {
  const [metric, setMetric] = useState<'elevation' | 'speed'>('elevation');
  const [dragMode, setDragMode] = useState<'none' | 'single' | 'smooth'>('none');
  // Normalized visible window [start, end] in [0, 1] of total distance
  const [viewRange, setViewRange] = useState<[number, number]>([0, 1]);
  const [isPanning, setIsPanning] = useState(false);
  const [dragPreview, setDragPreview] = useState<{
    index: number;
    pointId: string;
    newValue: number;
  } | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const panStateRef = useRef<{
    active: boolean;
    startX: number;
    startRange: [number, number];
    moved: boolean;
  }>({ active: false, startX: 0, startRange: [0, 1], moved: false });

  // Reset zoom when track length changes significantly (e.g. new file loaded)
  const totalTrackDist =
    pointStats.length > 1 ? pointStats[pointStats.length - 1].cumulativeDistanceM : 0;
  useEffect(() => {
    setViewRange([0, 1]);
  }, [totalTrackDist]);

  const width = 900;
  const height = 160;
  const padL = 48;
  const padR = 16;
  const padT = 12;
  const padB = 24;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const span = viewRange[1] - viewRange[0];
  const zoomLevel = span > 0 ? 1 / span : 1;
  const isZoomed = span < 0.999;

  const zoomBy = (factor: number, centerFrac = (viewRange[0] + viewRange[1]) / 2) => {
    setViewRange(([s, e]) => {
      const currSpan = e - s;
      const nextSpan = Math.max(0.02, Math.min(1, currSpan / factor));
      if (nextSpan >= 0.999) return [0, 1];
      const ratio = currSpan > 0 ? (centerFrac - s) / currSpan : 0.5;
      let nextS = centerFrac - ratio * nextSpan;
      let nextE = nextS + nextSpan;
      if (nextS < 0) {
        nextS = 0;
        nextE = nextSpan;
      }
      if (nextE > 1) {
        nextE = 1;
        nextS = 1 - nextSpan;
      }
      return [nextS, nextE];
    });
  };

  const panBy = (direction: -1 | 1) => {
    setViewRange(([s, e]) => {
      const currSpan = e - s;
      const step = currSpan * 0.25 * direction;
      let nextS = s + step;
      let nextE = e + step;
      if (nextS < 0) {
        nextS = 0;
        nextE = currSpan;
      }
      if (nextE > 1) {
        nextE = 1;
        nextS = 1 - currSpan;
      }
      return [nextS, nextE];
    });
  };

  const chartData = useMemo(() => {
    if (pointStats.length < 2) return null;

    const totalDist = pointStats[pointStats.length - 1].cumulativeDistanceM || 1;
    const minDist = viewRange[0] * totalDist;
    const maxDist = viewRange[1] * totalDist;
    const distSpan = Math.max(1e-6, maxDist - minDist);

    const allValues = pointStats.map((ps) =>
      metric === 'elevation' ? ps.point.ele ?? 0 : ps.speedKmh < 250 ? ps.speedKmh : 0
    );

    const hasTerrain =
      terrainElevations !== undefined &&
      pointStats.some((ps) => terrainElevations[ps.point.id] !== undefined);
    const hidePrimary = onlyTerrain && hasTerrain;

    // Compute Y bounds from visible points
    const visibleValues: number[] = [];
    const visibleTerrain: number[] = [];
    for (let i = 0; i < pointStats.length; i += 1) {
      const d = pointStats[i].cumulativeDistanceM;
      if (d >= minDist && d <= maxDist) {
        if (!hidePrimary) {
          visibleValues.push(allValues[i]);
        }
        if (hasTerrain && terrainElevations![pointStats[i].point.id] !== undefined) {
          const tEle = terrainElevations![pointStats[i].point.id];
          visibleTerrain.push(tEle);
          if (metric === 'elevation' || hidePrimary) {
            visibleValues.push(tEle);
          }
        }
      }
    }
    const ySource =
      visibleValues.length >= 2
        ? visibleValues
        : hidePrimary && visibleTerrain.length >= 2
        ? visibleTerrain
        : allValues;

    let minV = Math.min(...ySource);
    let maxV = Math.max(...ySource);
    if (maxV - minV < 1) {
      minV = Math.max(0, minV - 5);
      maxV = minV + 10;
    } else {
      const margin = (maxV - minV) * 0.1;
      minV = metric === 'speed' && !hidePrimary ? 0 : Math.floor(minV - margin);
      maxV = Math.ceil(maxV + margin);
    }

    const toX = (dist: number) => padL + ((dist - minDist) / distSpan) * plotW;
    const toY = (val: number) => padT + plotH - ((val - minV) / (maxV - minV)) * plotH;

    const linePoints = pointStats.map((ps, idx) => {
      const x = toX(ps.cumulativeDistanceM);
      const y = toY(allValues[idx]);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    const firstX = toX(pointStats[0].cumulativeDistanceM).toFixed(1);
    const lastX = toX(pointStats[pointStats.length - 1].cumulativeDistanceM).toFixed(1);
    const baseY = (padT + plotH).toFixed(1);

    let terrainPath: string | null = null;
    let terrainAreaPath: string | null = null;
    const terrainColoredSegments: Array<{ color: string; path: string }> = [];
    if (hasTerrain) {
      let toTerrainY = toY;
      if (metric === 'speed' && !hidePrimary) {
        const allT = pointStats
          .map((ps) => terrainElevations![ps.point.id])
          .filter((v): v is number => v !== undefined);
        const tSrc = visibleTerrain.length >= 2 ? visibleTerrain : allT;
        let tMin = Math.min(...tSrc);
        let tMax = Math.max(...tSrc);
        if (tMax - tMin < 1) {
          tMin -= 5;
          tMax += 5;
        } else {
          const tMargin = (tMax - tMin) * 0.1;
          tMin -= tMargin;
          tMax += tMargin;
        }
        toTerrainY = (val: number) => padT + plotH - ((val - tMin) / (tMax - tMin)) * plotH;
      }

      const tPts: string[] = [];
      let tFirstX: string | null = null;
      let tLastX: string | null = null;
      let prevCoord: { x: string; y: string; dist: number; ele: number } | null = null;
      let activeColor: string | null = null;
      let activeGroupPts: string[] = [];

      for (const ps of pointStats) {
        const tEle = terrainElevations![ps.point.id];
        if (tEle !== undefined) {
          const xStr = toX(ps.cumulativeDistanceM).toFixed(1);
          const yStr = toTerrainY(tEle).toFixed(1);
          if (!tFirstX) tFirstX = xStr;
          tLastX = xStr;
          tPts.push(`${xStr},${yStr}`);

          if (prevCoord) {
            const dDist = ps.cumulativeDistanceM - prevCoord.dist;
            const grade = dDist > 0.5 ? ((tEle - prevCoord.ele) / dDist) * 100 : 0;
            const color = getGradeColor(grade);
            if (color === activeColor) {
              activeGroupPts.push(`${xStr},${yStr}`);
            } else {
              if (activeColor && activeGroupPts.length >= 2) {
                terrainColoredSegments.push({
                  color: activeColor,
                  path: `M ${activeGroupPts.join(' L ')}`,
                });
              }
              activeColor = color;
              activeGroupPts = [`${prevCoord.x},${prevCoord.y}`, `${xStr},${yStr}`];
            }
          }
          prevCoord = { x: xStr, y: yStr, dist: ps.cumulativeDistanceM, ele: tEle };
        }
      }
      if (activeColor && activeGroupPts.length >= 2) {
        terrainColoredSegments.push({
          color: activeColor,
          path: `M ${activeGroupPts.join(' L ')}`,
        });
      }
      if (tPts.length >= 2 && tFirstX && tLastX) {
        terrainPath = `M ${tPts.join(' L ')}`;
        terrainAreaPath = `M ${tFirstX},${baseY} L ${tPts.join(' L ')} L ${tLastX},${baseY} Z`;
      }
    }

    const areaPath = `M ${firstX},${baseY} L ${linePoints.join(' L ')} L ${lastX},${baseY} Z`;
    const linePath = `M ${linePoints.join(' L ')}`;

    return {
      totalDist,
      minDist,
      maxDist,
      distSpan,
      minV,
      maxV,
      areaPath,
      linePath,
      terrainPath,
      terrainAreaPath,
      terrainColoredSegments,
      toX,
      toY,
      hidePrimary,
      values: allValues,
    };
  }, [pointStats, metric, onlyTerrain, viewRange, plotW, plotH, terrainElevations]);

  const getDistAtClientX = (clientX: number): number | null => {
    if (!svgRef.current || !chartData) return null;
    const rect = svgRef.current.getBoundingClientRect();
    const relX = ((clientX - rect.left) / rect.width) * width;
    const clampedX = Math.max(padL, Math.min(width - padR, relX));
    return chartData.minDist + ((clampedX - padL) / plotW) * chartData.distSpan;
  };

  const getValueAtClientY = (clientY: number): number | null => {
    if (!svgRef.current || !chartData) return null;
    const rect = svgRef.current.getBoundingClientRect();
    const relY = ((clientY - rect.top) / rect.height) * height;
    const clampedY = Math.max(padT, Math.min(padT + plotH, relY));
    const frac = 1 - (clampedY - padT) / plotH;
    const raw = chartData.minV + frac * (chartData.maxV - chartData.minV);
    return metric === 'speed' ? Math.max(0.5, raw) : raw;
  };

  const findNearestIndex = (targetDist: number): number => {
    let lo = 0;
    let hi = pointStats.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pointStats[mid].cumulativeDistanceM < targetDist) lo = mid + 1;
      else hi = mid;
    }
    if (
      lo > 0 &&
      Math.abs(pointStats[lo - 1].cumulativeDistanceM - targetDist) <
        Math.abs(pointStats[lo].cumulativeDistanceM - targetDist)
    ) {
      lo -= 1;
    }
    return lo;
  };

  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 0 || !chartData) return;

    if (dragMode !== 'none' && onAdjustPointValue) {
      const targetDist = getDistAtClientX(e.clientX);
      const val = getValueAtClientY(e.clientY);
      if (targetDist !== null && val !== null) {
        const idx = findNearestIndex(targetDist);
        const ptId = pointStats[idx].point.id;
        onSelectPoint(ptId);
        setDragPreview({ index: idx, pointId: ptId, newValue: val });
      }
      return;
    }

    if (!isZoomed) return;
    panStateRef.current = {
      active: true,
      startX: e.clientX,
      startRange: viewRange,
      moved: false,
    };
    setIsPanning(true);
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current || !chartData || pointStats.length === 0) return;

    if (dragPreview) {
      const val = getValueAtClientY(e.clientY);
      if (val !== null) {
        setDragPreview((prev) => (prev ? { ...prev, newValue: val } : null));
      }
      return;
    }

    if (panStateRef.current.active) {
      const dxPx = e.clientX - panStateRef.current.startX;
      if (Math.abs(dxPx) > 3) {
        panStateRef.current.moved = true;
      }
      const rect = svgRef.current.getBoundingClientRect();
      const plotPxWidth = (plotW / width) * rect.width;
      const [s0, e0] = panStateRef.current.startRange;
      const currSpan = e0 - s0;
      const deltaFrac = -(dxPx / Math.max(1, plotPxWidth)) * currSpan;
      let nextS = s0 + deltaFrac;
      let nextE = e0 + deltaFrac;
      if (nextS < 0) {
        nextS = 0;
        nextE = currSpan;
      }
      if (nextE > 1) {
        nextE = 1;
        nextS = 1 - currSpan;
      }
      setViewRange([nextS, nextE]);
      return;
    }

    const targetDist = getDistAtClientX(e.clientX);
    if (targetDist === null) return;
    const lo = findNearestIndex(targetDist);
    onHoverPoint(pointStats[lo].point.id);
  };

  const handleMouseUp = () => {
    if (dragPreview && onAdjustPointValue) {
      const radius = dragMode === 'smooth' ? SMOOTH_RADIUS : 0;
      onAdjustPointValue(dragPreview.pointId, metric, dragPreview.newValue, radius);
      setDragPreview(null);
      return;
    }

    const wasMoved = panStateRef.current.moved;
    panStateRef.current.active = false;
    setIsPanning(false);
    if (!wasMoved && hoveredPointId) {
      onSelectPoint(hoveredPointId);
    }
  };

  const handleWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    if (!chartData) return;
    e.preventDefault();
    const targetDist = getDistAtClientX(e.clientX);
    const centerFrac = targetDist !== null ? targetDist / chartData.totalDist : undefined;
    zoomBy(e.deltaY < 0 ? 1.35 : 1 / 1.35, centerFrac);
  };

  const activeHoverStat = useMemo(
    () => (hoveredPointId ? pointStats.find((p) => p.point.id === hoveredPointId) : undefined),
    [hoveredPointId, pointStats]
  );

  const activeSelectStat = useMemo(
    () => (selectedPointId ? pointStats.find((p) => p.point.id === selectedPointId) : undefined),
    [selectedPointId, pointStats]
  );

  const previewPath = useMemo(() => {
    if (!dragPreview || !chartData) return null;
    const radius = dragMode === 'smooth' ? SMOOTH_RADIUS : 0;
    const oldCenter = chartData.values[dragPreview.index] ?? 0;
    const delta = dragPreview.newValue - oldCenter;
    const startIdx = Math.max(0, dragPreview.index - radius - 1);
    const endIdx = Math.min(pointStats.length - 1, dragPreview.index + radius + 1);
    const pts: string[] = [];
    for (let i = startIdx; i <= endIdx; i += 1) {
      const w = cosineWeight(i - dragPreview.index, radius);
      const val =
        metric === 'speed'
          ? Math.max(0.5, chartData.values[i] + delta * w)
          : chartData.values[i] + delta * w;
      pts.push(
        `${chartData.toX(pointStats[i].cumulativeDistanceM).toFixed(1)},${chartData.toY(val).toFixed(1)}`
      );
    }
    return pts.length >= 2 ? `M ${pts.join(' L ')}` : null;
  }, [dragPreview, chartData, dragMode, metric, pointStats]);

  if (pointStats.length < 2 || !chartData) {
    return (
      <div className="chart-empty">
        Add at least 2 trackpoints to view the Elevation &amp; Speed profile.
      </div>
    );
  }

  const unit = metric === 'elevation' || chartData.hidePrimary ? 'm' : 'km/h';
  const strokeColor = metric === 'elevation' ? '#38bdf8' : '#ef4444';
  const fillColor = metric === 'elevation' ? 'rgba(56, 189, 248, 0.22)' : 'rgba(239, 68, 68, 0.20)';

  const yTicks = [chartData.minV, (chartData.minV + chartData.maxV) / 2, chartData.maxV];
  const xTicks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="chart-container">
      <div className="chart-header">
        <div className="chart-header-left">
          <div className="chart-tabs">
            <button
              className={`chart-tab ${metric === 'elevation' ? 'active' : ''}`}
              onClick={() => setMetric('elevation')}
            >
              Elevation (m)
            </button>
            <button
              className={`chart-tab ${metric === 'speed' ? 'active' : ''}`}
              onClick={() => setMetric('speed')}
            >
              Speed (km/h)
            </button>
          </div>

          <div className="chart-zoom-controls">
            <button
              className={`chart-tool-btn ${dragMode === 'single' ? 'active' : ''}`}
              onClick={() => setDragMode((m) => (m === 'single' ? 'none' : 'single'))}
              title="Drag a single point up/down on the chart"
            >
              <MoveVertical size={12} />
              <span>Single</span>
            </button>
            <button
              className={`chart-tool-btn ${dragMode === 'smooth' ? 'active' : ''}`}
              onClick={() => setDragMode((m) => (m === 'smooth' ? 'none' : 'smooth'))}
              title="Drag a point up/down and smoothly pull nearby points with it"
            >
              <Sparkles size={12} />
              <span>Smooth</span>
            </button>
          </div>

          {onFetchTerrain && (
            <div className="chart-zoom-controls">
              <button
                className={`chart-tool-btn ${chartData.terrainPath ? 'active' : ''}`}
                onClick={onFetchTerrain}
                disabled={isFetchingTerrain}
                title="Fetch real terrain elevation (DEM) from the path coordinates"
              >
                <Mountain size={12} />
                <span>{isFetchingTerrain ? 'Fetching...' : 'Terrain DEM'}</span>
              </button>
              {chartData.terrainPath && onToggleOnlyTerrain && (
                <button
                  className={`chart-tool-btn ${onlyTerrain ? 'active' : ''}`}
                  onClick={onToggleOnlyTerrain}
                  title="Hide device elevation, speed, and map points to show only actual terrain elevation and grade"
                >
                  <EyeOff size={12} />
                  <span>Only Terrain</span>
                </button>
              )}
              {chartData.terrainPath && onApplyTerrain && (
                <button
                  className="chart-tool-btn"
                  onClick={onApplyTerrain}
                  title="Overwrite GPX elevation (<ele>) with fetched terrain elevation"
                >
                  <Check size={12} />
                  <span>Apply to GPX</span>
                </button>
              )}
            </div>
          )}

          <div className="chart-zoom-controls">
            <button
              className="chart-tool-btn"
              onClick={() => zoomBy(1.5)}
              title="Zoom In"
            >
              <ZoomIn size={13} />
            </button>
            <button
              className="chart-tool-btn"
              onClick={() => zoomBy(1 / 1.5)}
              disabled={!isZoomed}
              title="Zoom Out"
            >
              <ZoomOut size={13} />
            </button>
            {isZoomed && (
              <>
                <button
                  className="chart-tool-btn"
                  onClick={() => panBy(-1)}
                  disabled={viewRange[0] <= 0.0001}
                  title="Pan Left"
                >
                  <ChevronLeft size={13} />
                </button>
                <button
                  className="chart-tool-btn"
                  onClick={() => panBy(1)}
                  disabled={viewRange[1] >= 0.9999}
                  title="Pan Right"
                >
                  <ChevronRight size={13} />
                </button>
                <button
                  className="chart-tool-btn"
                  onClick={() => setViewRange([0, 1])}
                  title="Reset Zoom"
                >
                  <RotateCcw size={12} />
                  <span>{zoomLevel.toFixed(1)}x</span>
                </button>
              </>
            )}
          </div>
        </div>

        {dragPreview ? (
          <div className="chart-readout" style={{ color: '#4ade80' }}>
            <span>
              Dragging #{dragPreview.index + 1} ({dragMode === 'smooth' ? `Smooth ±${SMOOTH_RADIUS}` : 'Single'}):{' '}
              <strong>
                {dragPreview.newValue.toFixed(1)} {unit}
              </strong>
            </span>
          </div>
        ) : activeHoverStat ? (
          <div className="chart-readout">
            <span>Dist: <strong>{formatDistance(activeHoverStat.cumulativeDistanceM)}</strong></span>
            {activeHoverStat.point.ele !== undefined && (
              <span>Ele: <strong>{activeHoverStat.point.ele.toFixed(1)} m</strong></span>
            )}
            {terrainElevations?.[activeHoverStat.point.id] !== undefined && (
              <span style={{ color: '#4ade80' }}>
                Terrain: <strong>{terrainElevations[activeHoverStat.point.id].toFixed(1)} m</strong>
              </span>
            )}
            <span>Speed: <strong>{activeHoverStat.speedKmh.toFixed(1)} km/h</strong></span>
            <span>Grade: <strong>{activeHoverStat.gradePct.toFixed(1)}%</strong></span>
          </div>
        ) : (
          <div className="chart-readout muted">
            {dragMode !== 'none'
              ? `Drag any point up/down (${dragMode === 'smooth' ? 'neighbors follow smoothly' : 'single point'})`
              : isZoomed
              ? 'Drag to pan, scroll or click to inspect'
              : 'Hover, scroll to zoom, or click profile'}
          </div>
        )}
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className={`chart-svg ${
          dragMode !== 'none' ? 'ns-drag' : isZoomed ? (isPanning ? 'panning' : 'zoomed') : ''
        }`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          panStateRef.current.active = false;
          setIsPanning(false);
          setDragPreview(null);
          onHoverPoint(null);
        }}
        onWheel={handleWheel}
      >
        <defs>
          <clipPath id="chart-plot-clip">
            <rect x={padL} y={padT} width={plotW} height={plotH} />
          </clipPath>
        </defs>

        {/* Horizontal grid lines & Y labels */}
        {yTicks.map((val, idx) => {
          const y = chartData.toY(val);
          return (
            <g key={idx}>
              <line
                x1={padL}
                y1={y}
                x2={width - padR}
                y2={y}
                stroke="#334155"
                strokeDasharray="3 3"
                strokeWidth="1"
              />
              <text x={padL - 6} y={y + 3} textAnchor="end" fill="#94a3b8" fontSize="10">
                {Math.round(val)}
                {idx === 2 ? ` ${unit}` : ''}
              </text>
            </g>
          );
        })}

        {/* X labels */}
        {xTicks.map((frac, idx) => {
          const dist = chartData.minDist + chartData.distSpan * frac;
          const x = padL + plotW * frac;
          return (
            <text key={idx} x={x} y={height - 6} textAnchor="middle" fill="#94a3b8" fontSize="10">
              {formatDistance(dist)}
            </text>
          );
        })}

        {/* Clipped Plot Area */}
        <g clipPath="url(#chart-plot-clip)">
          {trimRangeIndices && pointStats[trimRangeIndices[0]] && pointStats[trimRangeIndices[1]] && (
            <rect
              x={chartData.toX(pointStats[trimRangeIndices[0]].cumulativeDistanceM)}
              y={padT}
              width={Math.max(
                2,
                chartData.toX(pointStats[trimRangeIndices[1]].cumulativeDistanceM) -
                  chartData.toX(pointStats[trimRangeIndices[0]].cumulativeDistanceM)
              )}
              height={plotH}
              fill="rgba(244, 63, 94, 0.22)"
              stroke="#f43f5e"
              strokeWidth="1"
              strokeDasharray="3 2"
            />
          )}
          {!chartData.hidePrimary && metric === 'speed' && chartData.terrainColoredSegments.length > 0 && (
            <g opacity="0.7">
              {chartData.terrainAreaPath && (
                <path d={chartData.terrainAreaPath} fill="rgba(34, 197, 94, 0.10)" />
              )}
              {chartData.terrainColoredSegments.map((seg, i) => (
                <path
                  key={i}
                  d={seg.path}
                  fill="none"
                  stroke={seg.color}
                  strokeWidth="1.8"
                />
              ))}
            </g>
          )}
          {!chartData.hidePrimary && (
            <>
              <path d={chartData.areaPath} fill={fillColor} />
              <path d={chartData.linePath} fill="none" stroke={strokeColor} strokeWidth="2" />
            </>
          )}
          {(metric === 'elevation' || chartData.hidePrimary) &&
            chartData.terrainColoredSegments.map((seg, i) => (
              <path
                key={i}
                d={seg.path}
                fill="none"
                stroke={seg.color}
                strokeWidth="2.4"
              />
            ))}

          {/* Selected point marker */}
          {activeSelectStat && (
            <g>
              <line
                x1={chartData.toX(activeSelectStat.cumulativeDistanceM)}
                y1={padT}
                x2={chartData.toX(activeSelectStat.cumulativeDistanceM)}
                y2={padT + plotH}
                stroke="#3b82f6"
                strokeWidth="1.5"
              />
              <circle
                cx={chartData.toX(activeSelectStat.cumulativeDistanceM)}
                cy={chartData.toY(chartData.values[activeSelectStat.index])}
                r="4.5"
                fill="#3b82f6"
                stroke="#ffffff"
                strokeWidth="1.5"
              />
            </g>
          )}

          {/* Live Drag Preview */}
          {dragPreview && (
            <g>
              {previewPath && (
                <path
                  d={previewPath}
                  fill="none"
                  stroke="#4ade80"
                  strokeWidth="2.5"
                  strokeDasharray="4 3"
                />
              )}
              <circle
                cx={chartData.toX(pointStats[dragPreview.index].cumulativeDistanceM)}
                cy={chartData.toY(dragPreview.newValue)}
                r="5.5"
                fill="#4ade80"
                stroke="#ffffff"
                strokeWidth="1.5"
              />
            </g>
          )}

          {/* Hovered point marker */}
          {activeHoverStat && (
            <g>
              <line
                x1={chartData.toX(activeHoverStat.cumulativeDistanceM)}
                y1={padT}
                x2={chartData.toX(activeHoverStat.cumulativeDistanceM)}
                y2={padT + plotH}
                stroke="#eab308"
                strokeWidth="1"
                strokeDasharray="3 2"
              />
              <circle
                cx={chartData.toX(activeHoverStat.cumulativeDistanceM)}
                cy={chartData.toY(chartData.values[activeHoverStat.index])}
                r="4"
                fill="#eab308"
                stroke="#ffffff"
                strokeWidth="1.5"
              />
            </g>
          )}
        </g>
      </svg>
    </div>
  );
};
