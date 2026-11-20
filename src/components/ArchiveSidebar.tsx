import React, { useEffect } from 'react';
import { Archive, Calendar, Edit3, ExternalLink, Image, RotateCcw, Trash2 } from 'lucide-react';
import { ArchiveActivity } from '../utils/stravaArchive';
import { formatDistance, formatDuration } from '../utils/gpxParser';

interface ArchiveSidebarProps {
  activities: ArchiveActivity[];
  filteredActivities: ArchiveActivity[];
  selectedActivityId: string | null;
  dateFrom: string;
  dateTo: string;
  typeFilter: string;
  speedMin: string;
  speedMax: string;
  availableTypes: string[];
  totalDistanceM: number;
  totalElevGainM: number;
  totalDurationSec: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  maxSpeedActivity?: ArchiveActivity | null;
  maxElevationM: number | null;
  maxEleActivity?: ArchiveActivity | null;
  maxHeartRate: number | null;
  maxPower: number | null;
  onChangeDateFrom: (val: string) => void;
  onChangeDateTo: (val: string) => void;
  onChangeTypeFilter: (val: string) => void;
  onChangeSpeedMin: (val: string) => void;
  onChangeSpeedMax: (val: string) => void;
  onResetFilters: () => void;
  onSelectActivity: (id: string) => void;
  onDeleteActivity: (id: string) => void;
  onOpenInEditor: (activity: ArchiveActivity) => void;
  onOpenShareCard: () => void;
}

export const ArchiveSidebar: React.FC<ArchiveSidebarProps> = ({
  activities,
  filteredActivities,
  selectedActivityId,
  dateFrom,
  dateTo,
  typeFilter,
  speedMin,
  speedMax,
  availableTypes,
  totalDistanceM,
  totalElevGainM,
  totalDurationSec,
  avgSpeedKmh,
  maxSpeedKmh,
  maxSpeedActivity,
  maxElevationM,
  maxEleActivity,
  maxHeartRate,
  maxPower,
  onChangeDateFrom,
  onChangeDateTo,
  onChangeTypeFilter,
  onChangeSpeedMin,
  onChangeSpeedMax,
  onResetFilters,
  onSelectActivity,
  onDeleteActivity,
  onOpenInEditor,
  onOpenShareCard,
}) => {
  useEffect(() => {
    if (!selectedActivityId) return;
    const el = document.getElementById(`archive-item-${selectedActivityId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [selectedActivityId]);

  return (
    <aside className="sidebar">
      <div className="sidebar-content">
        <div className="tab-pane">
          <div className="panel-section">
            <div className="points-header">
              <span className="section-title">
                <Archive size={13} style={{ verticalAlign: 'middle', marginRight: 5 }} />
                Strava Archive ({activities.length})
              </span>
              <button className="btn-secondary-sm" onClick={onResetFilters} title="Reset filters">
                <RotateCcw size={12} /> All
              </button>
            </div>

            <div className="form-grid-2">
              <label className="field">
                <span>
                  <Calendar size={11} style={{ verticalAlign: 'middle', marginRight: 3 }} />
                  From Date
                </span>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => onChangeDateFrom(e.target.value)}
                />
              </label>
              <label className="field">
                <span>
                  <Calendar size={11} style={{ verticalAlign: 'middle', marginRight: 3 }} />
                  To Date
                </span>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => onChangeDateTo(e.target.value)}
                />
              </label>
            </div>

            <div className="form-grid-2">
              <label className="field">
                <span>Min Speed (km/h)</span>
                <input
                  type="number"
                  min="0"
                  max="250"
                  placeholder="Any"
                  value={speedMin}
                  onChange={(e) => onChangeSpeedMin(e.target.value)}
                />
              </label>
              <label className="field">
                <span>Max Speed (km/h)</span>
                <input
                  type="number"
                  min="0"
                  max="250"
                  placeholder="Any"
                  value={speedMax}
                  onChange={(e) => onChangeSpeedMax(e.target.value)}
                />
              </label>
            </div>

            <label className="field">
              <span>Activity Type</span>
              <select value={typeFilter} onChange={(e) => onChangeTypeFilter(e.target.value)}>
                <option value="ALL">All Types ({activities.length})</option>
                {availableTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="stats-grid">
            <div className="stat-card">
              <span className="stat-label">Activities</span>
              <span className="stat-value">{filteredActivities.length}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Distance</span>
              <span className="stat-value">{formatDistance(totalDistanceM)}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Elev Gain</span>
              <span className="stat-value">+{Math.round(totalElevGainM).toLocaleString()} m</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Total Time</span>
              <span className="stat-value">{formatDuration(totalDurationSec)}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Ave. Speed</span>
              <span className="stat-value">{avgSpeedKmh.toFixed(1)} km/h</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Max HR / Power</span>
              <span className="stat-value">
                {maxHeartRate !== null ? `${Math.round(maxHeartRate)} bpm` : '—'} /{' '}
                {maxPower !== null ? `${Math.round(maxPower)} W` : '—'}
              </span>
            </div>
            <div
              className="stat-card"
              style={maxSpeedActivity ? { cursor: 'pointer' } : undefined}
              onClick={() => maxSpeedActivity && onSelectActivity(maxSpeedActivity.id)}
              title={
                maxSpeedActivity
                  ? `Click to highlight "${maxSpeedActivity.name}" on map`
                  : undefined
              }
            >
              <span className="stat-label">Max Speed</span>
              <span className="stat-value">{maxSpeedKmh.toFixed(1)} km/h</span>
              {maxSpeedActivity && (
                <span className="merged-file-meta" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {maxSpeedActivity.name}
                </span>
              )}
            </div>
            <div
              className="stat-card"
              style={maxEleActivity ? { cursor: 'pointer' } : undefined}
              onClick={() => maxEleActivity && onSelectActivity(maxEleActivity.id)}
              title={
                maxEleActivity
                  ? `Click to highlight "${maxEleActivity.name}" on map`
                  : undefined
              }
            >
              <span className="stat-label">Max Elevation</span>
              <span className="stat-value">
                {maxElevationM !== null ? `${Math.round(maxElevationM).toLocaleString()} m` : '—'}
              </span>
              {maxEleActivity && (
                <span className="merged-file-meta" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {maxEleActivity.name}
                </span>
              )}
            </div>
          </div>

          <button
            className="btn-primary-full"
            onClick={onOpenShareCard}
            disabled={filteredActivities.length === 0}
          >
            <Image size={16} />
            <span>Export Summary Card (JPG)</span>
          </button>

          <div className="panel-section">
            <div className="section-title">
              Activities in Range ({filteredActivities.length})
            </div>
            <div className="archive-list">
              {filteredActivities.map((act) => {
                const isSelected = act.id === selectedActivityId;
                return (
                  <div
                    key={act.id}
                    id={`archive-item-${act.id}`}
                    className={`archive-item ${isSelected ? 'selected' : ''}`}
                    onClick={() => onSelectActivity(act.id)}
                  >
                    <div className="archive-item-main">
                      <span className="archive-item-title">{act.name}</span>
                      <span className="archive-item-meta">
                        {act.dateIso ? new Date(act.dateIso).toLocaleDateString() : 'No date'} •{' '}
                        {formatDistance(act.distanceM)} • {act.type}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                      {act.stravaId && (
                        <button
                          className="btn-secondary-sm"
                          style={{ color: '#fc4c02', borderColor: 'rgba(252, 76, 2, 0.45)' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            window.open(
                              `https://www.strava.com/activities/${encodeURIComponent(act.stravaId!)}`,
                              '_blank',
                              'noopener,noreferrer'
                            );
                          }}
                          title="Open this activity on Strava"
                        >
                          <ExternalLink size={12} />
                        </button>
                      )}
                      {act.rawGpxText && (
                        <button
                          className="btn-secondary-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenInEditor(act);
                          }}
                          title="Open this GPX in the Editor"
                        >
                          <Edit3 size={12} />
                        </button>
                      )}
                      <button
                        className="icon-btn-danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteActivity(act.id);
                        }}
                        title="Remove activity from archive"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
              {filteredActivities.length === 0 && (
                <div className="empty-hint">No activities match the selected date range.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
};
