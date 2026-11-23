import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Gauge,
  Link2,
  MapPin,
  Plus,
  Scissors,
  Sliders,
  Sparkles,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import {
  GpxDocument,
  GpxTrack,
  TrackPoint,
  TrackStats,
  Waypoint,
} from '../types/gpx';
import {
  formatDistance,
  formatDuration,
  getGoogleStreetViewUrl,
  SpeedSpikeAnomaly,
  TimestampHealth,
  toLocalDateTimeInputValue,
} from '../utils/gpxParser';

interface SidebarProps {
  doc: GpxDocument;
  activeTrack: GpxTrack | undefined;
  stats: TrackStats;
  timestampHealth: TimestampHealth;
  selectedPointId: string | null;
  onSelectTrack: (trackId: string) => void;
  onSelectPoint: (pointId: string) => void;
  onFocusPoint: (pointId: string, metric?: 'elevation' | 'speed') => void;
  onHoverPoint: (pointId: string | null) => void;
  onUpdatePoint: (pointId: string, patch: Partial<TrackPoint>) => void;
  onDeletePoint: (pointId: string) => void;
  onTrimBefore: (pointId: string) => void;
  onTrimAfter: (pointId: string) => void;
  trimRangeStartId: string | null;
  trimRangeEndId: string | null;
  onSetTrimRangeStart: (pointId: string | null) => void;
  onSetTrimRangeEnd: (pointId: string | null) => void;
  onCutRange: (startId: string, endId: string) => void;
  onConnectRange: (startId: string, endId: string) => void;
  onJoinSegments: () => void;
  onKeepOnlyRange: (startId: string, endId: string) => void;
  onReverseTrack: () => void;
  onSmoothPoint: (pointId: string) => void;
  onFixSpeedSpikes: (maxSpeedKmh: number, mode: 'interpolate' | 'remove') => void;
  onApplyPointSpeeds: (speedTargets: Record<string, number>, label?: string) => void;
  detectedSpikes: SpeedSpikeAnomaly[];
  spikeJumpThresholdKmh: number;
  spikeMaxCapKmh: number;
  onChangeSpikeJumpThreshold: (val: number) => void;
  onChangeSpikeMaxCap: (val: number) => void;
  onJumpToMaxSpeed: () => void;
  onRepairTimestamps: () => void;
  onUpdateMetadata: (metaPatch: Partial<GpxDocument['metadata']>, trackPatch?: Partial<GpxTrack>) => void;
  onShiftTime: (offsetMs: number) => void;
  onSetStartTime: (newStartIso: string, fallbackSpeedKmh: number) => void;
  onUpdateWaypoint: (wptId: string, patch: Partial<Waypoint>) => void;
  onDeleteWaypoint: (wptId: string) => void;
  onAddMergeFile: () => void;
  onDeleteSegment: (segmentId: string) => void;
  archiveCount?: number;
  onBackToArchive?: () => void;
}

type SidebarTab = 'stats' | 'metadata' | 'points';

const PAGE_SIZE = 50;

export const Sidebar: React.FC<SidebarProps> = ({
  doc,
  activeTrack,
  stats,
  timestampHealth,
  selectedPointId,
  onSelectTrack,
  onSelectPoint,
  onFocusPoint,
  onHoverPoint,
  onUpdatePoint,
  onDeletePoint,
  onTrimBefore,
  onTrimAfter,
  trimRangeStartId,
  trimRangeEndId,
  onSetTrimRangeStart,
  onSetTrimRangeEnd,
  onCutRange,
  onConnectRange,
  onJoinSegments,
  onKeepOnlyRange,
  onReverseTrack,
  onSmoothPoint,
  onFixSpeedSpikes,
  onApplyPointSpeeds,
  detectedSpikes,
  spikeJumpThresholdKmh,
  spikeMaxCapKmh,
  onChangeSpikeJumpThreshold,
  onChangeSpikeMaxCap,
  onJumpToMaxSpeed,
  onRepairTimestamps,
  onUpdateMetadata,
  onShiftTime,
  onSetStartTime,
  onUpdateWaypoint,
  onDeleteWaypoint,
  onAddMergeFile,
  onDeleteSegment,
  archiveCount = 0,
  onBackToArchive,
}) => {
  const [tab, setTab] = useState<SidebarTab>('stats');
  const [page, setPage] = useState(0);
  const [startDateInput, setStartDateInput] = useState('');
  const [fallbackSpeed, setFallbackSpeed] = useState(12);
  const [customShiftMin, setCustomShiftMin] = useState(60);

  useEffect(() => {
    setStartDateInput(toLocalDateTimeInputValue(stats.startTime));
  }, [stats.startTime]);

  const selectedStat = stats.pointStats.find((ps) => ps.point.id === selectedPointId);
  const selectedSpike = detectedSpikes.find((sp) => sp.pointId === selectedPointId);
  const prevNeighborStat =
    selectedStat && selectedStat.index > 1 ? stats.pointStats[selectedStat.index - 1] : undefined;
  const nextNeighborStat =
    selectedStat && selectedStat.index < stats.pointStats.length - 1
      ? stats.pointStats[selectedStat.index + 1]
      : undefined;

  // Auto-jump page when a point is selected on the map/chart
  useEffect(() => {
    if (selectedStat) {
      const targetPage = Math.floor(selectedStat.index / PAGE_SIZE);
      setPage(targetPage);
    }
  }, [selectedStat?.index]);

  const totalPages = Math.max(1, Math.ceil(stats.pointStats.length / PAGE_SIZE));
  const pagedPoints = stats.pointStats.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const handleApplyStartTime = () => {
    if (!startDateInput) return;
    const parsed = new Date(startDateInput);
    if (!Number.isNaN(parsed.getTime())) {
      onSetStartTime(parsed.toISOString(), fallbackSpeed);
    }
  };

  return (
    <aside className="sidebar">
      {archiveCount > 0 && onBackToArchive && (
        <div
          style={{
            padding: '8px 12px',
            borderBottom: '1px solid var(--border)',
            background: 'rgba(249, 115, 22, 0.1)',
          }}
        >
          <button
            className="btn-secondary-full"
            style={{ borderColor: 'var(--accent)', color: '#fdba74' }}
            onClick={onBackToArchive}
          >
            <ChevronLeft size={15} />
            <span>Back to Strava Archive ({archiveCount})</span>
          </button>
        </div>
      )}

      {/* Track Selector if multiple tracks */}
      {doc.tracks.length > 1 && (
        <div className="sidebar-track-selector">
          <label>Active Track</label>
          <select
            value={activeTrack?.id || ''}
            onChange={(e) => onSelectTrack(e.target.value)}
          >
            {doc.tracks.map((t, i) => (
              <option key={t.id} value={t.id}>
                {t.name || `Track ${i + 1}`}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Tabs */}
      <div className="sidebar-tabs">
        <button
          className={`sidebar-tab ${tab === 'stats' ? 'active' : ''}`}
          onClick={() => setTab('stats')}
        >
          <TrendingUp size={15} />
          <span>Analyze</span>
        </button>
        <button
          className={`sidebar-tab ${tab === 'metadata' ? 'active' : ''}`}
          onClick={() => setTab('metadata')}
        >
          <CalendarClock size={15} />
          <span>Data &amp; Date</span>
        </button>
        <button
          className={`sidebar-tab ${tab === 'points' ? 'active' : ''}`}
          onClick={() => setTab('points')}
        >
          <Sliders size={15} />
          <span>Points ({stats.totalPoints})</span>
        </button>
      </div>

      <div className="sidebar-content">
        {tab === 'stats' && (
          <div className="tab-pane">
            <div className="stats-grid">
              <div className="stat-card">
                <span className="stat-label">Distance</span>
                <span className="stat-value">{formatDistance(stats.totalDistanceM)}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Total Time</span>
                <span className="stat-value">{formatDuration(stats.totalDurationSec)}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Moving Time</span>
                <span className="stat-value">{formatDuration(stats.movingDurationSec)}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Avg Speed</span>
                <span className="stat-value">{stats.avgSpeedKmh.toFixed(1)} km/h</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Max Speed</span>
                <span className="stat-value">{stats.maxSpeedKmh.toFixed(1)} km/h</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Points</span>
                <span className="stat-value">{stats.totalPoints}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Elev Gain / Loss</span>
                <span className="stat-value">
                  +{Math.round(stats.elevationGainM)}m / -{Math.round(stats.elevationLossM)}m
                </span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Min / Max Ele</span>
                <span className="stat-value">
                  {stats.minElevationM !== null ? `${Math.round(stats.minElevationM)}m` : '—'} /{' '}
                  {stats.maxElevationM !== null ? `${Math.round(stats.maxElevationM)}m` : '—'}
                </span>
              </div>
            </div>

            {/* Selected Point Inspector */}
            <div className="panel-section">
              <div className="section-title">Selected Trackpoint</div>
              {selectedStat ? (
                <div className="selected-point-card">
                  <div className="point-meta-row">
                    <span>Point #{selectedStat.index + 1}</span>
                    <span>Dist: {formatDistance(selectedStat.cumulativeDistanceM)}</span>
                  </div>
                  <div className="form-grid-2">
                    <label className="field">
                      <span>Latitude</span>
                      <input
                        type="number"
                        step="0.00001"
                        value={Number(selectedStat.point.lat.toFixed(6))}
                        onChange={(e) =>
                          onUpdatePoint(selectedStat.point.id, {
                            lat: parseFloat(e.target.value) || 0,
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Longitude</span>
                      <input
                        type="number"
                        step="0.00001"
                        value={Number(selectedStat.point.lon.toFixed(6))}
                        onChange={(e) =>
                          onUpdatePoint(selectedStat.point.id, {
                            lon: parseFloat(e.target.value) || 0,
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Elevation (m)</span>
                      <input
                        type="number"
                        step="0.5"
                        value={selectedStat.point.ele ?? ''}
                        placeholder="None"
                        onChange={(e) =>
                          onUpdatePoint(selectedStat.point.id, {
                            ele: e.target.value === '' ? undefined : parseFloat(e.target.value),
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Speed</span>
                      <input type="text" readOnly value={`${selectedStat.speedKmh.toFixed(1)} km/h`} />
                    </label>
                  </div>

                  {/* Nearest Neighbor Speed Comparison & One-Click Copy */}
                  {selectedStat.index > 0 && (prevNeighborStat || nextNeighborStat || selectedSpike) && (
                    <div
                      className="info-box"
                      style={
                        selectedSpike
                          ? { borderColor: 'rgba(248, 113, 113, 0.55)', background: 'rgba(239, 68, 68, 0.08)' }
                          : undefined
                      }
                    >
                      {selectedSpike && (
                        <div style={{ color: '#fca5a5', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5 }}>
                          <AlertTriangle size={13} />
                          <span>
                            Detected Spike (+{selectedSpike.jumpKmh.toFixed(1)} km/h above nearest)
                          </span>
                        </div>
                      )}
                      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                        <span>
                          Prev:{' '}
                          <strong style={{ color: '#93c5fd' }}>
                            {selectedSpike?.prevSpeedKmh !== undefined && selectedSpike?.prevSpeedKmh !== null
                              ? `${selectedSpike.prevSpeedKmh.toFixed(1)} km/h`
                              : prevNeighborStat
                              ? `${prevNeighborStat.speedKmh.toFixed(1)} km/h`
                              : '—'}
                          </strong>
                        </span>
                        <span>
                          Next:{' '}
                          <strong style={{ color: '#93c5fd' }}>
                            {selectedSpike?.nextSpeedKmh !== undefined && selectedSpike?.nextSpeedKmh !== null
                              ? `${selectedSpike.nextSpeedKmh.toFixed(1)} km/h`
                              : nextNeighborStat
                              ? `${nextNeighborStat.speedKmh.toFixed(1)} km/h`
                              : '—'}
                          </strong>
                        </span>
                      </div>
                      <div className="action-row" style={{ marginTop: 2 }}>
                        {(selectedSpike?.prevSpeedKmh ?? prevNeighborStat?.speedKmh) !== undefined && (
                          <button
                            className="btn-secondary-sm"
                            onClick={() => {
                              const target =
                                selectedSpike?.prevSpeedKmh ?? prevNeighborStat!.speedKmh;
                              onApplyPointSpeeds(
                                { [selectedStat.point.id]: target },
                                `Copied previous point speed (${target.toFixed(1)} km/h)`
                              );
                            }}
                            title="Match this point's speed to the nearest previous clean point"
                          >
                            <Copy size={12} /> Copy Prev (
                            {(selectedSpike?.prevSpeedKmh ?? prevNeighborStat!.speedKmh).toFixed(1)})
                          </button>
                        )}
                        {(selectedSpike?.nextSpeedKmh ?? nextNeighborStat?.speedKmh) !== undefined && (
                          <button
                            className="btn-secondary-sm"
                            onClick={() => {
                              const target =
                                selectedSpike?.nextSpeedKmh ?? nextNeighborStat!.speedKmh;
                              onApplyPointSpeeds(
                                { [selectedStat.point.id]: target },
                                `Copied next point speed (${target.toFixed(1)} km/h)`
                              );
                            }}
                            title="Match this point's speed to the nearest next clean point"
                          >
                            <Copy size={12} /> Copy Next (
                            {(selectedSpike?.nextSpeedKmh ?? nextNeighborStat!.speedKmh).toFixed(1)})
                          </button>
                        )}
                        {(selectedSpike || (prevNeighborStat && nextNeighborStat)) && (
                          <button
                            className="btn-secondary-sm"
                            style={{ borderColor: '#22c55e', color: '#86efac' }}
                            onClick={() => {
                              const avg = selectedSpike
                                ? selectedSpike.avgNeighborSpeedKmh
                                : (prevNeighborStat!.speedKmh + nextNeighborStat!.speedKmh) / 2;
                              onApplyPointSpeeds(
                                { [selectedStat.point.id]: avg },
                                `Matched nearest neighbor average speed (${avg.toFixed(1)} km/h)`
                              );
                            }}
                            title="Match this point's speed to the average of its nearest clean neighbors"
                          >
                            <Sparkles size={12} /> Copy Nearest Avg (
                            {(selectedSpike
                              ? selectedSpike.avgNeighborSpeedKmh
                              : (prevNeighborStat!.speedKmh + nextNeighborStat!.speedKmh) / 2
                            ).toFixed(1)}
                            )
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                  <label className="field">
                    <span>Timestamp (Local)</span>
                    <input
                      type="datetime-local"
                      step="1"
                      value={toLocalDateTimeInputValue(selectedStat.point.time)}
                      onChange={(e) => {
                        const d = new Date(e.target.value);
                        if (!Number.isNaN(d.getTime())) {
                          onUpdatePoint(selectedStat.point.id, { time: d.toISOString() });
                        }
                      }}
                    />
                  </label>

                  <div className="action-row">
                    <button
                      className="btn-secondary-sm"
                      onClick={() => onSmoothPoint(selectedStat.point.id)}
                      title="Interpolate lat/lon/ele/time smoothly between previous and next point"
                    >
                      <Sparkles size={14} /> Smooth
                    </button>
                    <button
                      className="btn-danger-sm"
                      onClick={() => onDeletePoint(selectedStat.point.id)}
                      title="Delete this point"
                    >
                      <Trash2 size={14} /> Delete
                    </button>
                    <button
                      className="btn-secondary-sm"
                      onClick={() => onTrimBefore(selectedStat.point.id)}
                      title="Make this point the new Start (deletes all points before it)"
                    >
                      <Scissors size={14} /> Set as Start
                    </button>
                    <button
                      className="btn-secondary-sm"
                      onClick={() => onTrimAfter(selectedStat.point.id)}
                      title="Make this point the new End (deletes all points after it)"
                    >
                      <Scissors size={14} /> Set as End
                    </button>
                    <button
                      className="btn-secondary-sm"
                      style={
                        trimRangeStartId === selectedStat.point.id
                          ? { borderColor: '#f43f5e', color: '#fda4af' }
                          : undefined
                      }
                      onClick={() => onSetTrimRangeStart(selectedStat.point.id)}
                      title="Mark this point as Start of portion (A)"
                    >
                      Mark A
                    </button>
                    <button
                      className="btn-secondary-sm"
                      style={
                        trimRangeEndId === selectedStat.point.id
                          ? { borderColor: '#f43f5e', color: '#fda4af' }
                          : undefined
                      }
                      onClick={() => onSetTrimRangeEnd(selectedStat.point.id)}
                      title="Mark this point as End of portion (B)"
                    >
                      Mark B
                    </button>
                    {activeTrack && (
                      <button
                        className="btn-secondary-sm"
                        onClick={() => {
                          const pts = activeTrack.segments.flatMap((s) => s.points);
                          const url = getGoogleStreetViewUrl(pts, selectedStat.point.id);
                          if (url) window.open(url, '_blank', 'noopener,noreferrer');
                        }}
                        title="Open Google Maps 360° Street View facing your direction of travel"
                      >
                        <ExternalLink size={14} /> 360° View
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="empty-hint">
                  Click any point on the map, chart, or Points tab to inspect and edit it.
                </div>
              )}
            </div>

            {/* Trim / Cut / Connect Portion */}
            <div className="panel-section">
              <div className="points-header">
                <span className="section-title">Connect / Cut Portion</span>
                {(trimRangeStartId || trimRangeEndId) && (
                  <button
                    className="btn-secondary-sm"
                    onClick={() => {
                      onSetTrimRangeStart(null);
                      onSetTrimRangeEnd(null);
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
              <div className="info-box">
                <div>
                  <strong>Point A:</strong>{' '}
                  {trimRangeStartId
                    ? `#${
                        stats.pointStats.findIndex((p) => p.point.id === trimRangeStartId) + 1
                      }`
                    : 'Not set (select a point & click Mark A)'}
                </div>
                <div>
                  <strong>Point B:</strong>{' '}
                  {trimRangeEndId
                    ? `#${
                        stats.pointStats.findIndex((p) => p.point.id === trimRangeEndId) + 1
                      }`
                    : 'Not set (select a point & click Mark B)'}
                </div>
              </div>
              <div className="action-row">
                <button
                  className="btn-secondary-sm"
                  style={
                    trimRangeStartId && trimRangeEndId
                      ? { borderColor: '#06b6d4', color: '#22d3ee' }
                      : undefined
                  }
                  disabled={!trimRangeStartId || !trimRangeEndId}
                  onClick={() =>
                    trimRangeStartId &&
                    trimRangeEndId &&
                    onConnectRange(trimRangeStartId, trimRangeEndId)
                  }
                  title="Keep clean Point A and Point B, remove any jumping points between them, and connect A directly to B without a gap"
                >
                  <Link2 size={13} /> Connect (A→B)
                </button>
                <button
                  className="btn-danger-sm"
                  disabled={!trimRangeStartId || !trimRangeEndId}
                  onClick={() =>
                    trimRangeStartId &&
                    trimRangeEndId &&
                    onCutRange(trimRangeStartId, trimRangeEndId)
                  }
                  title="Cut out points A through B"
                >
                  <Scissors size={13} /> Cut Portion (A→B)
                </button>
                <button
                  className="btn-secondary-sm"
                  disabled={!trimRangeStartId || !trimRangeEndId}
                  onClick={() =>
                    trimRangeStartId &&
                    trimRangeEndId &&
                    onKeepOnlyRange(trimRangeStartId, trimRangeEndId)
                  }
                  title="Keep only points between A and B (trims before A and after B)"
                >
                  <Scissors size={13} /> Keep Only (A→B)
                </button>
              </div>
              {activeTrack && activeTrack.segments.filter((s) => s.points.length > 0).length > 1 && (
                <button
                  className="btn-secondary-full"
                  style={{ borderColor: '#38bdf8', color: '#7dd3fc', marginTop: 2 }}
                  onClick={onJoinSegments}
                  title="Stitch all separate track segments together to close any empty gaps"
                >
                  <Link2 size={14} />
                  <span>
                    Connect All Segment Gaps (
                    {activeTrack.segments.filter((s) => s.points.length > 0).length - 1})
                  </span>
                </button>
              )}
            </div>

            {/* Track-wide & Speed Spike Analyzer Tools */}
            <div className="panel-section">
              <div className="points-header">
                <span className="section-title">Speed Spike Analyzer</span>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: detectedSpikes.length > 0 ? '#fca5a5' : '#4ade80',
                  }}
                >
                  {detectedSpikes.length} spike{detectedSpikes.length === 1 ? '' : 's'}
                </span>
              </div>

              <div className="form-grid-2">
                <label className="field" title="Flag points jumping by at least this many km/h above their nearest surrounding points">
                  <span>Jump vs Nearest (+km/h)</span>
                  <input
                    type="number"
                    min="2"
                    max="150"
                    step="1"
                    value={spikeJumpThresholdKmh}
                    onChange={(e) =>
                      onChangeSpikeJumpThreshold(Math.max(2, parseFloat(e.target.value) || 10))
                    }
                  />
                </label>
                <label className="field" title="Also flag any point exceeding this absolute speed cap">
                  <span>Max Speed Cap (km/h)</span>
                  <input
                    type="number"
                    min="5"
                    max="250"
                    step="1"
                    value={spikeMaxCapKmh}
                    onChange={(e) => {
                      const v = Math.max(5, parseFloat(e.target.value) || 45);
                      onChangeSpikeMaxCap(v);
                    }}
                  />
                </label>
              </div>

              {detectedSpikes.length > 0 ? (
                <>
                  <div className="action-row">
                    <button
                      className="btn-primary-full"
                      style={{ background: '#0ea5e9' }}
                      onClick={() => {
                        const targets: Record<string, number> = {};
                        for (const sp of detectedSpikes) {
                          targets[sp.pointId] = sp.avgNeighborSpeedKmh;
                        }
                        onApplyPointSpeeds(
                          targets,
                          `Matched all ${detectedSpikes.length} speed spikes to nearest neighbor speeds`
                        );
                      }}
                      title="Set all detected spike points to match the interpolated speed of their nearest clean neighbors"
                    >
                      <Copy size={14} />
                      <span>Copy Nearest Speed to All ({detectedSpikes.length})</span>
                    </button>
                  </div>

                  <div className="action-row">
                    <button
                      className="btn-secondary-sm"
                      onClick={() => {
                        const targets: Record<string, number> = {};
                        for (const sp of detectedSpikes) {
                          targets[sp.pointId] = sp.prevSpeedKmh ?? sp.nearestSpeedKmh;
                        }
                        onApplyPointSpeeds(
                          targets,
                          `Copied previous neighbor speed to ${detectedSpikes.length} spikes`
                        );
                      }}
                      title="Copy each spike's nearest previous clean neighbor speed"
                    >
                      <Copy size={12} /> All Copy Prev
                    </button>
                    <button
                      className="btn-secondary-sm"
                      onClick={() => {
                        const targets: Record<string, number> = {};
                        for (const sp of detectedSpikes) {
                          targets[sp.pointId] = sp.nextSpeedKmh ?? sp.nearestSpeedKmh;
                        }
                        onApplyPointSpeeds(
                          targets,
                          `Copied next neighbor speed to ${detectedSpikes.length} spikes`
                        );
                      }}
                      title="Copy each spike's nearest next clean neighbor speed"
                    >
                      <Copy size={12} /> All Copy Next
                    </button>
                    <button
                      className="btn-secondary-sm"
                      onClick={() => onFixSpeedSpikes(spikeMaxCapKmh, 'interpolate')}
                      title="Smooth coordinates & timestamps for points exceeding max cap"
                    >
                      <Sparkles size={12} /> Smooth Coords
                    </button>
                    <button
                      className="btn-danger-sm"
                      onClick={() => onFixSpeedSpikes(spikeMaxCapKmh, 'remove')}
                      title="Delete points exceeding max cap"
                    >
                      <Trash2 size={12} /> Remove
                    </button>
                  </div>

                  <div
                    className="points-table-wrap"
                    style={{ maxHeight: 210 }}
                  >
                    <table className="points-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Spike</th>
                          <th>Nearest Clean</th>
                          <th style={{ textAlign: 'right' }}>Fix</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detectedSpikes.map((sp) => {
                          const isSel = sp.pointId === selectedPointId;
                          return (
                            <tr
                              key={sp.pointId}
                              className={isSel ? 'selected' : ''}
                              onClick={() => onFocusPoint(sp.pointId, 'speed')}
                              onMouseEnter={() => onHoverPoint(sp.pointId)}
                              onMouseLeave={() => onHoverPoint(null)}
                              title={`Click to zoom Map & Speed Graph to Point #${sp.index + 1} (${formatDistance(
                                sp.cumulativeDistanceM
                              )})`}
                            >
                              <td>#{sp.index + 1}</td>
                              <td style={{ color: '#f87171', fontWeight: 700 }}>
                                {sp.speedKmh.toFixed(1)}
                              </td>
                              <td style={{ color: '#4ade80' }} title={`Prev: ${sp.prevSpeedKmh?.toFixed(1) ?? '—'} km/h • Next: ${sp.nextSpeedKmh?.toFixed(1) ?? '—'} km/h`}>
                                {sp.avgNeighborSpeedKmh.toFixed(1)} km/h
                              </td>
                              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                                <button
                                  className="btn-secondary-sm"
                                  style={{ padding: '2px 6px', fontSize: 10.5, borderColor: '#0ea5e9', color: '#7dd3fc' }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onApplyPointSpeeds(
                                      { [sp.pointId]: sp.avgNeighborSpeedKmh },
                                      `Point #${sp.index + 1} matched to nearest speed (${sp.avgNeighborSpeedKmh.toFixed(1)} km/h)`
                                    );
                                  }}
                                  title={`Set Point #${sp.index + 1} speed to ${sp.avgNeighborSpeedKmh.toFixed(1)} km/h`}
                                >
                                  Copy Nearest
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className="info-box" style={{ color: '#86efac', borderColor: 'rgba(34,197,94,0.3)' }}>
                  No speed spikes detected (+{spikeJumpThresholdKmh} km/h jump or &gt;{spikeMaxCapKmh} km/h). Lower the thresholds above to catch smaller fluctuations.
                </div>
              )}

              <button className="btn-secondary-full" onClick={onJumpToMaxSpeed}>
                <Gauge size={15} />
                <span>Jump to Max Speed Point ({stats.maxSpeedKmh.toFixed(1)} km/h)</span>
              </button>

              <button className="btn-secondary-full" onClick={onReverseTrack}>
                <ArrowLeftRight size={15} />
                <span>Reverse Track Direction</span>
              </button>
            </div>

            {/* Merged GPX Files List */}
            {activeTrack && (
              <div className="panel-section">
                <div className="points-header">
                  <span className="section-title">
                    Merged GPX Files ({activeTrack.segments.filter((s) => s.points.length > 0).length})
                  </span>
                  <button
                    className="btn-secondary-sm"
                    onClick={onAddMergeFile}
                    title="Add another .gpx file to merge"
                  >
                    <Plus size={13} /> Add GPX
                  </button>
                </div>

                <div className="wpt-list">
                  {activeTrack.segments.map((seg, idx) => (
                    <div key={seg.id} className="merged-file-row">
                      <div className="merged-file-info">
                        <span className="merged-file-name">
                          {seg.name || `Segment ${idx + 1}`}
                        </span>
                        <span className="merged-file-meta">{seg.points.length} pts</span>
                      </div>
                      <button
                        className="icon-btn-danger"
                        onClick={() => onDeleteSegment(seg.id)}
                        title="Remove this GPX file from track"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'metadata' && (
          <div className="tab-pane">
            <div className="panel-section">
              <div className="section-title">Track &amp; GPX Metadata</div>
              <label className="field">
                <span>Track Name</span>
                <input
                  type="text"
                  value={activeTrack?.name ?? ''}
                  onChange={(e) =>
                    onUpdateMetadata({ name: e.target.value }, { name: e.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>Activity Type</span>
                <input
                  type="text"
                  placeholder="e.g., running, cycling, hiking"
                  value={activeTrack?.type ?? ''}
                  onChange={(e) => onUpdateMetadata({}, { type: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Description</span>
                <textarea
                  rows={3}
                  value={activeTrack?.desc ?? doc.metadata.desc ?? ''}
                  onChange={(e) =>
                    onUpdateMetadata({ desc: e.target.value }, { desc: e.target.value })
                  }
                />
              </label>
              <div className="form-grid-2">
                <label className="field">
                  <span>Author</span>
                  <input
                    type="text"
                    value={doc.metadata.authorName ?? ''}
                    onChange={(e) => onUpdateMetadata({ authorName: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>Creator</span>
                  <input
                    type="text"
                    value={doc.metadata.creator ?? ''}
                    onChange={(e) => onUpdateMetadata({ creator: e.target.value })}
                  />
                </label>
              </div>
            </div>

            <div className="panel-section">
              <div className="section-title">Date &amp; Time Editor</div>
              <div className="info-box">
                <div>
                  <strong>Start:</strong>{' '}
                  {stats.startTime ? new Date(stats.startTime).toLocaleString() : 'No timestamps'}
                </div>
                <div>
                  <strong>End:</strong>{' '}
                  {stats.endTime ? new Date(stats.endTime).toLocaleString() : 'No timestamps'}
                </div>
              </div>

              <label className="field">
                <span>Set New Start Date &amp; Time</span>
                <input
                  type="datetime-local"
                  step="1"
                  value={startDateInput}
                  onChange={(e) => setStartDateInput(e.target.value)}
                />
              </label>
              {!stats.startTime && (
                <label className="field">
                  <span>Assumed Speed (km/h) for new timestamps</span>
                  <input
                    type="number"
                    min="1"
                    max="200"
                    value={fallbackSpeed}
                    onChange={(e) => setFallbackSpeed(parseFloat(e.target.value) || 12)}
                  />
                </label>
              )}
              <button className="btn-primary-full" onClick={handleApplyStartTime}>
                Apply New Start Date/Time
              </button>

              {stats.startTime && (
                <div className="shift-controls">
                  <span className="shift-label">Quick Time Shift</span>
                  <div className="shift-btn-row">
                    <button className="btn-secondary-sm" onClick={() => onShiftTime(-3600 * 1000)}>
                      -1 hr
                    </button>
                    <button className="btn-secondary-sm" onClick={() => onShiftTime(-900 * 1000)}>
                      -15m
                    </button>
                    <button className="btn-secondary-sm" onClick={() => onShiftTime(900 * 1000)}>
                      +15m
                    </button>
                    <button className="btn-secondary-sm" onClick={() => onShiftTime(3600 * 1000)}>
                      +1 hr
                    </button>
                  </div>
                  <div className="custom-shift-row">
                    <input
                      type="number"
                      value={customShiftMin}
                      onChange={(e) => setCustomShiftMin(parseFloat(e.target.value) || 0)}
                    />
                    <span>min</span>
                    <button
                      className="btn-secondary-sm"
                      onClick={() => onShiftTime(customShiftMin * 60 * 1000)}
                    >
                      Shift
                    </button>
                  </div>
                </div>
              )}

              <div className="shift-controls">
                <span className="shift-label">Strava Time Validation</span>
                {timestampHealth.hasIssues ? (
                  <div className="info-box" style={{ borderColor: '#f59e0b', color: '#fcd34d' }}>
                    <div>
                      Found time issues: {timestampHealth.missingCount} missing,{' '}
                      {timestampHealth.duplicateCount} duplicate,{' '}
                      {timestampHealth.outOfOrderCount} out-of-order.
                    </div>
                  </div>
                ) : (
                  <div className="info-box">
                    <div>Timestamps are monotonic. Click below to normalize to whole-second UTC if needed.</div>
                  </div>
                )}
                <button className="btn-secondary-full" onClick={onRepairTimestamps}>
                  Repair / Normalize Time Data (Strava)
                </button>
              </div>
            </div>
          </div>
        )}

        {tab === 'points' && (
          <div className="tab-pane">
            {/* Waypoints section */}
            {doc.waypoints.length > 0 && (
              <div className="panel-section">
                <div className="section-title">Waypoints ({doc.waypoints.length})</div>
                <div className="wpt-list">
                  {doc.waypoints.map((wpt) => (
                    <div key={wpt.id} className="wpt-item">
                      <MapPin size={14} className="wpt-icon" />
                      <input
                        type="text"
                        value={wpt.name ?? ''}
                        placeholder="Waypoint name"
                        onChange={(e) => onUpdateWaypoint(wpt.id, { name: e.target.value })}
                      />
                      <button
                        className="icon-btn-danger"
                        onClick={() => onDeleteWaypoint(wpt.id)}
                        title="Delete waypoint"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="panel-section">
              <div className="points-header">
                <span className="section-title">Trackpoints</span>
                <div className="pagination">
                  <button
                    disabled={page === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <span>
                    {page + 1} / {totalPages}
                  </span>
                  <button
                    disabled={page >= totalPages - 1}
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>

              <div className="points-table-wrap">
                <table className="points-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Lat / Lon</th>
                      <th>Ele</th>
                      <th>Dist</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedPoints.map((ps) => {
                      const isSelected = ps.point.id === selectedPointId;
                      return (
                        <tr
                          key={ps.point.id}
                          className={isSelected ? 'selected' : ''}
                          onClick={() => onSelectPoint(ps.point.id)}
                          onMouseEnter={() => onHoverPoint(ps.point.id)}
                          onMouseLeave={() => onHoverPoint(null)}
                        >
                          <td>{ps.index + 1}</td>
                          <td className="mono">
                            {ps.point.lat.toFixed(5)}, {ps.point.lon.toFixed(5)}
                          </td>
                          <td>{ps.point.ele !== undefined ? `${ps.point.ele.toFixed(0)}m` : '—'}</td>
                          <td>{formatDistance(ps.cumulativeDistanceM)}</td>
                          <td>
                            <button
                              className="icon-btn-danger"
                              onClick={(e) => {
                                e.stopPropagation();
                                onDeletePoint(ps.point.id);
                              }}
                              title="Delete point"
                            >
                              <Trash2 size={13} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};

