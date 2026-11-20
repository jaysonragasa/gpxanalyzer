import React, { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react';
import {
  Archive,
  Box,
  Compass,
  Download,
  FilePlus2,
  FolderOpen,
  GitMerge,
  Redo2,
  Undo2,
} from 'lucide-react';
import {
  GpxDocument,
  GpxTrack,
  MapEditMode,
  MapLayerType,
  TrackPoint,
  Waypoint,
} from './types/gpx';
import {
  adjustTrackElevation,
  adjustTrackSpeed,
  analyzeTimestampHealth,
  computeTrackStats,
  createSampleGpx,
  fixSpeedSpikes,
  haversineDistanceM,
  mergeGpxDocuments,
  nextId,
  parseGpx,
  repairTrackTimestamps,
  serializeGpx,
  setTrackStartTime,
  shiftDocumentTime,
  smoothTrackPoint,
  toStravaIso,
} from './utils/gpxParser';
import { MapEditor } from './components/MapEditor';
import { ElevationChart } from './components/ElevationChart';
import { Sidebar } from './components/Sidebar';
import { ArchiveMap } from './components/ArchiveMap';
import { ArchiveSidebar } from './components/ArchiveSidebar';
import { ShareCardModal } from './components/ShareCardModal';
// three.js is large; load the 3D studio only when it is opened
const GpxTo3DModal = lazy(() =>
  import('./components/GpxTo3DModal').then((m) => ({ default: m.GpxTo3DModal }))
);
import { fetchTerrainElevations } from './utils/elevationApi';
import {
  ArchiveActivity,
  ArchiveProgress,
  parseStravaArchiveZip,
} from './utils/stravaArchive';

const MAX_HISTORY = 40;

export function App() {
  const [doc, setDoc] = useState<GpxDocument>(() => createSampleGpx());
  const [history, setHistory] = useState<GpxDocument[]>([]);
  const [future, setFuture] = useState<GpxDocument[]>([]);
  const [activeTrackId, setActiveTrackId] = useState<string | null>(null);
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
  const [hoveredPointId, setHoveredPointId] = useState<string | null>(null);
  const [trimRangeStartId, setTrimRangeStartId] = useState<string | null>(null);
  const [trimRangeEndId, setTrimRangeEndId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<MapEditMode>('select');
  const [mapLayer, setMapLayer] = useState<MapLayerType>('osm');
  const [fitTrigger, setFitTrigger] = useState<number>(1);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [chartHeight, setChartHeight] = useState<number>(200);
  const [terrainElevations, setTerrainElevations] = useState<Record<string, number>>({});
  const [isFetchingTerrain, setIsFetchingTerrain] = useState(false);
  const [onlyTerrain, setOnlyTerrain] = useState(false);

  // Strava Archive ZIP state
  const [viewMode, setViewMode] = useState<'editor' | 'archive'>('editor');
  const [archiveActivities, setArchiveActivities] = useState<ArchiveActivity[]>([]);
  const [archiveProgress, setArchiveProgress] = useState<ArchiveProgress | null>(null);
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [typeFilter, setTypeFilter] = useState('ALL');
  const [speedMin, setSpeedMin] = useState('25');
  const [speedMax, setSpeedMax] = useState('49');
  const [showShareCard, setShowShareCard] = useState(false);
  const [show3DModal, setShow3DModal] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mergeInputRef = useRef<HTMLInputElement | null>(null);
  const zipInputRef = useRef<HTMLInputElement | null>(null);

  const handleChartResizeStart = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = chartHeight;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = startY - moveEvent.clientY;
      const nextHeight = Math.max(120, Math.min(520, startHeight + deltaY));
      setChartHeight(nextHeight);
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const activeTrack = useMemo(() => {
    if (doc.tracks.length === 0) return undefined;
    return doc.tracks.find((t) => t.id === activeTrackId) || doc.tracks[0];
  }, [doc.tracks, activeTrackId]);

  // Stable reference so the 3D modal does not rebuild its scene on every App render
  const activeTrackPoints = useMemo(
    () => (activeTrack ? activeTrack.segments.flatMap((s) => s.points) : []),
    [activeTrack]
  );

  const stats = useMemo(() => computeTrackStats(activeTrack), [activeTrack]);
  const timestampHealth = useMemo(() => analyzeTimestampHealth(activeTrack), [activeTrack]);

  const showToast = useCallback((msg: string) => {
    setStatusMessage(msg);
    setTimeout(() => {
      setStatusMessage((curr) => (curr === msg ? null : curr));
    }, 3000);
  }, []);

  const commitDoc = useCallback((updater: (prev: GpxDocument) => GpxDocument) => {
    setDoc((prev) => {
      const next = updater(prev);
      setHistory((h) => [...h.slice(-(MAX_HISTORY - 1)), prev]);
      setFuture([]);
      return next;
    });
  }, []);

  const handleUndo = () => {
    if (history.length === 0) return;
    const previous = history[history.length - 1];
    setFuture((f) => [doc, ...f]);
    setHistory((h) => h.slice(0, -1));
    setDoc(previous);
  };

  const handleRedo = () => {
    if (future.length === 0) return;
    const next = future[0];
    setHistory((h) => [...h, doc]);
    setFuture((f) => f.slice(1));
    setDoc(next);
  };

  const loadGpxText = useCallback(
    (text: string, fileName?: string) => {
      try {
        const parsed = parseGpx(text);
        if (parsed.tracks.length === 0) {
          parsed.tracks.push({
            id: nextId('trk'),
            name: fileName?.replace(/\.gpx$/i, '') || 'New Track',
            segments: [{ id: nextId('seg'), name: fileName || 'Track 1', points: [] }],
          });
        } else {
          parsed.tracks = parsed.tracks.map((t) => ({
            ...t,
            segments: t.segments.map((s, idx) => ({
              ...s,
              name: s.name || (t.segments.length === 1 ? fileName || t.name : `${fileName || t.name} #${idx + 1}`),
            })),
          }));
        }
        setDoc(parsed);
        setHistory([]);
        setFuture([]);
        setActiveTrackId(parsed.tracks[0].id);
        setSelectedPointId(null);
        setTerrainElevations({});
        setFitTrigger((n) => n + 1);
        showToast(`Loaded ${fileName || 'GPX file'}`);
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to parse GPX file.');
      }
    },
    [showToast]
  );

  const handleImportZipFile = useCallback(
    async (file: File) => {
      try {
        setArchiveProgress({ current: 0, total: 1, label: 'Opening ZIP archive...' });
        const parsed = await parseStravaArchiveZip(file, setArchiveProgress);
        setArchiveActivities(parsed);
        setSelectedActivityId(null);
        setDateFrom('');
        setDateTo('');
        setTypeFilter('ALL');
        setSpeedMin('25');
        setSpeedMax('49');
        setViewMode('archive');
        showToast(`Loaded ${parsed.length} activities from Strava archive`);
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to parse Strava ZIP archive.');
      } finally {
        setArchiveProgress(null);
      }
    },
    [showToast]
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.name.toLowerCase().endsWith('.zip')) {
      void handleImportZipFile(file);
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setViewMode('editor');
        loadGpxText(reader.result, file.name);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleZipInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    void handleImportZipFile(file);
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingFile(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (file.name.toLowerCase().endsWith('.zip')) {
      void handleImportZipFile(file);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setViewMode('editor');
        loadGpxText(reader.result, file.name);
      }
    };
    reader.readAsText(file);
  };

  const handleExportGpx = () => {
    const xml = serializeGpx(doc);
    const blob = new Blob([xml], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const baseName = (activeTrack?.name || doc.metadata.name || 'track')
      .replace(/[^a-z0-9_\-\s]/gi, '')
      .trim()
      .replace(/\s+/g, '_');
    a.href = url;
    a.download = `${baseName || 'track'}.gpx`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Exported GPX file');
  };

  const handleMergeFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        try {
          const incoming = parseGpx(reader.result);
          let addedPts = 0;
          commitDoc((prev) => {
            const res = mergeGpxDocuments(prev, incoming, activeTrack?.id, file.name);
            addedPts = res.addedPoints;
            return res.doc;
          });
          setFitTrigger((n) => n + 1);
          showToast(`Merged ${addedPts} points from ${file.name}`);
        } catch (err) {
          alert(err instanceof Error ? err.message : 'Failed to parse GPX file to merge.');
        }
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleLoadSample = () => {
    const sample = createSampleGpx();
    setDoc(sample);
    setHistory([]);
    setFuture([]);
    setActiveTrackId(sample.tracks[0].id);
    setSelectedPointId(null);
    setFitTrigger((n) => n + 1);
    showToast('Loaded sample GPX track');
  };

  const handleNewEmptyTrack = () => {
    const emptyDoc: GpxDocument = {
      metadata: {
        name: 'New Custom Track',
        time: new Date().toISOString(),
        creator: 'GPX Analyzer & Editor',
      },
      waypoints: [],
      tracks: [
        {
          id: nextId('trk'),
          name: 'New Custom Track',
          segments: [{ id: nextId('seg'), points: [] }],
        },
      ],
    };
    setDoc(emptyDoc);
    setHistory([]);
    setFuture([]);
    setActiveTrackId(emptyDoc.tracks[0].id);
    setSelectedPointId(null);
    setEditMode('add');
    showToast('Created blank track — click map to add points');
  };

  // Point editing handlers
  const handleMovePoint = useCallback(
    (pointId: string, lat: number, lon: number) => {
      commitDoc((prev) => ({
        ...prev,
        tracks: prev.tracks.map((trk) => ({
          ...trk,
          segments: trk.segments.map((seg) => ({
            ...seg,
            points: seg.points.map((pt) => (pt.id === pointId ? { ...pt, lat, lon } : pt)),
          })),
        })),
      }));
    },
    [commitDoc]
  );

  const handleUpdatePoint = useCallback(
    (pointId: string, patch: Partial<TrackPoint>) => {
      commitDoc((prev) => ({
        ...prev,
        tracks: prev.tracks.map((trk) => ({
          ...trk,
          segments: trk.segments.map((seg) => ({
            ...seg,
            points: seg.points.map((pt) => (pt.id === pointId ? { ...pt, ...patch } : pt)),
          })),
        })),
      }));
    },
    [commitDoc]
  );

  const handleDeletePoint = useCallback(
    (pointId: string) => {
      commitDoc((prev) => ({
        ...prev,
        tracks: prev.tracks.map((trk) => ({
          ...trk,
          segments: trk.segments.map((seg) => ({
            ...seg,
            points: seg.points.filter((pt) => pt.id !== pointId),
          })),
        })),
      }));
      if (selectedPointId === pointId) setSelectedPointId(null);
    },
    [commitDoc, selectedPointId]
  );

  const handleAddPoint = useCallback(
    (lat: number, lon: number) => {
      const targetId = activeTrack?.id || doc.tracks[0]?.id;
      if (!targetId) return;

      const newPt: TrackPoint = {
        id: nextId('pt'),
        lat,
        lon,
        time: new Date().toISOString(),
      };

      commitDoc((prev) => ({
        ...prev,
        tracks: prev.tracks.map((trk) => {
          if (trk.id !== targetId) return trk;
          const segments = trk.segments.length > 0 ? trk.segments : [{ id: nextId('seg'), points: [] }];

          // Insert after selectedPointId if present in this track
          let inserted = false;
          const updatedSegments = segments.map((seg) => {
            if (!selectedPointId || inserted) return seg;
            const idx = seg.points.findIndex((p) => p.id === selectedPointId);
            if (idx !== -1) {
              inserted = true;
              const prevPt = seg.points[idx];
              const nextPt = seg.points[idx + 1];
              let ptTime = prevPt.time;
              if (prevPt.time && nextPt?.time) {
                const t1 = Date.parse(prevPt.time);
                const t2 = Date.parse(nextPt.time);
                if (!Number.isNaN(t1) && !Number.isNaN(t2) && t2 > t1) {
                  ptTime = toStravaIso(t1 + (t2 - t1) / 2);
                }
              } else if (prevPt.time) {
                const t1 = Date.parse(prevPt.time);
                if (!Number.isNaN(t1)) {
                  const dist = haversineDistanceM(prevPt.lat, prevPt.lon, lat, lon);
                  ptTime = toStravaIso(t1 + Math.max(1000, Math.round((dist / 4) * 1000)));
                }
              }
              const ptWithEle: TrackPoint = {
                ...newPt,
                ele: prevPt.ele,
                time: ptTime,
              };
              const nextPts = [...seg.points];
              nextPts.splice(idx + 1, 0, ptWithEle);
              return { ...seg, points: nextPts };
            }
            return seg;
          });

          if (!inserted) {
            const lastIdx = updatedSegments.length - 1;
            const lastSeg = updatedSegments[lastIdx];
            const lastPt = lastSeg.points[lastSeg.points.length - 1];
            let ptTime = newPt.time;
            if (lastPt?.time) {
              const t1 = Date.parse(lastPt.time);
              if (!Number.isNaN(t1)) {
                const dist = haversineDistanceM(lastPt.lat, lastPt.lon, lat, lon);
                ptTime = toStravaIso(t1 + Math.max(1000, Math.round((dist / 4) * 1000)));
              }
            }
            updatedSegments[lastIdx] = {
              ...lastSeg,
              points: [...lastSeg.points, { ...newPt, ele: lastPt?.ele, time: ptTime }],
            };
          }

          return { ...trk, segments: updatedSegments };
        }),
      }));

      setSelectedPointId(newPt.id);
    },
    [activeTrack?.id, doc.tracks, selectedPointId, commitDoc]
  );

  const handleAddWaypoint = useCallback(
    (lat: number, lon: number) => {
      const newWpt: Waypoint = {
        id: nextId('wpt'),
        lat,
        lon,
        name: `Waypoint ${doc.waypoints.length + 1}`,
        time: new Date().toISOString(),
      };
      commitDoc((prev) => ({
        ...prev,
        waypoints: [...prev.waypoints, newWpt],
      }));
      setEditMode('select');
      showToast(`Added ${newWpt.name}`);
    },
    [doc.waypoints.length, commitDoc, showToast]
  );

  const handleTrimBefore = useCallback(
    (pointId: string) => {
      if (!activeTrack) return;
      commitDoc((prev) => {
        const nextTracks = prev.tracks.map((trk) => {
          if (trk.id !== activeTrack.id) return trk;
          const allPts = trk.segments.flatMap((s) => s.points);
          const idx = allPts.findIndex((p) => p.id === pointId);
          if (idx <= 0) return trk;
          return {
            ...trk,
            segments: [{ id: nextId('seg'), name: trk.name, points: allPts.slice(idx) }],
          };
        });
        const newStart = nextTracks
          .find((t) => t.id === activeTrack.id)
          ?.segments[0]?.points[0]?.time;
        return {
          ...prev,
          metadata: newStart ? { ...prev.metadata, time: newStart } : prev.metadata,
          tracks: nextTracks,
        };
      });
      setTrimRangeStartId(null);
      setTrimRangeEndId(null);
      showToast('Set selected point as new Start');
    },
    [activeTrack, commitDoc, showToast]
  );

  const handleTrimAfter = useCallback(
    (pointId: string) => {
      if (!activeTrack) return;
      commitDoc((prev) => ({
        ...prev,
        tracks: prev.tracks.map((trk) => {
          if (trk.id !== activeTrack.id) return trk;
          const allPts = trk.segments.flatMap((s) => s.points);
          const idx = allPts.findIndex((p) => p.id === pointId);
          if (idx === -1 || idx >= allPts.length - 1) return trk;
          return {
            ...trk,
            segments: [{ id: nextId('seg'), name: trk.name, points: allPts.slice(0, idx + 1) }],
          };
        }),
      }));
      setTrimRangeStartId(null);
      setTrimRangeEndId(null);
      showToast('Set selected point as new End');
    },
    [activeTrack, commitDoc, showToast]
  );

  const handleCutRange = useCallback(
    (startId: string, endId: string) => {
      if (!activeTrack) return;
      let removedCount = 0;
      commitDoc((prev) => {
        const nextTracks = prev.tracks.map((trk) => {
          if (trk.id !== activeTrack.id) return trk;
          const allPts = trk.segments.flatMap((s) => s.points);
          const i1 = allPts.findIndex((p) => p.id === startId);
          const i2 = allPts.findIndex((p) => p.id === endId);
          if (i1 === -1 || i2 === -1) return trk;
          const lo = Math.min(i1, i2);
          const hi = Math.max(i1, i2);
          if (hi - lo + 1 >= allPts.length) return trk;
          removedCount = hi - lo + 1;
          const before = allPts.slice(0, lo);
          const after = allPts.slice(hi + 1);
          const segs = [];
          if (before.length > 0) {
            segs.push({ id: nextId('seg'), name: `${trk.name} (Part 1)`, points: before });
          }
          if (after.length > 0) {
            segs.push({
              id: nextId('seg'),
              name: before.length > 0 ? `${trk.name} (Part 2)` : trk.name,
              points: after,
            });
          }
          return { ...trk, segments: segs };
        });
        const newStart = nextTracks
          .find((t) => t.id === activeTrack.id)
          ?.segments[0]?.points[0]?.time;
        return {
          ...prev,
          metadata: newStart ? { ...prev.metadata, time: newStart } : prev.metadata,
          tracks: nextTracks,
        };
      });
      setTrimRangeStartId(null);
      setTrimRangeEndId(null);
      setSelectedPointId(null);
      if (removedCount > 0) {
        showToast(`Cut ${removedCount} points from track`);
      }
    },
    [activeTrack, commitDoc, showToast]
  );

  const handleKeepOnlyRange = useCallback(
    (startId: string, endId: string) => {
      if (!activeTrack) return;
      let keptCount = 0;
      commitDoc((prev) => {
        const nextTracks = prev.tracks.map((trk) => {
          if (trk.id !== activeTrack.id) return trk;
          const allPts = trk.segments.flatMap((s) => s.points);
          const i1 = allPts.findIndex((p) => p.id === startId);
          const i2 = allPts.findIndex((p) => p.id === endId);
          if (i1 === -1 || i2 === -1) return trk;
          const lo = Math.min(i1, i2);
          const hi = Math.max(i1, i2);
          const kept = allPts.slice(lo, hi + 1);
          keptCount = kept.length;
          return {
            ...trk,
            segments: [{ id: nextId('seg'), name: trk.name, points: kept }],
          };
        });
        const newStart = nextTracks
          .find((t) => t.id === activeTrack.id)
          ?.segments[0]?.points[0]?.time;
        return {
          ...prev,
          metadata: newStart ? { ...prev.metadata, time: newStart } : prev.metadata,
          tracks: nextTracks,
        };
      });
      setTrimRangeStartId(null);
      setTrimRangeEndId(null);
      showToast(`Kept ${keptCount} points in selected range`);
    },
    [activeTrack, commitDoc, showToast]
  );

  const handleReverseTrack = useCallback(() => {
    if (!activeTrack) return;
    commitDoc((prev) => ({
      ...prev,
      tracks: prev.tracks.map((trk) => {
        if (trk.id !== activeTrack.id) return trk;
        const allPts = trk.segments.flatMap((s) => s.points).reverse();
        return {
          ...trk,
          segments: [{ id: nextId('seg'), points: allPts }],
        };
      }),
    }));
    showToast('Reversed track direction');
  }, [activeTrack, commitDoc, showToast]);

  const handleSmoothPoint = useCallback(
    (pointId: string) => {
      if (!activeTrack) return;
      commitDoc((prev) => smoothTrackPoint(prev, activeTrack.id, pointId));
      showToast('Smoothed point between neighbors');
    },
    [activeTrack, commitDoc, showToast]
  );

  const handleFixSpeedSpikes = useCallback(
    (maxSpeedKmh: number, mode: 'interpolate' | 'remove') => {
      if (!activeTrack) return;
      let count = 0;
      commitDoc((prev) => {
        const res = fixSpeedSpikes(prev, activeTrack.id, maxSpeedKmh, mode);
        count = res.fixedCount;
        return res.doc;
      });
      showToast(
        count > 0
          ? `${mode === 'remove' ? 'Removed' : 'Smoothed'} ${count} speed spike point${count > 1 ? 's' : ''}`
          : `No points exceeded ${maxSpeedKmh} km/h`
      );
    },
    [activeTrack, commitDoc, showToast]
  );

  const handleJumpToMaxSpeed = useCallback(() => {
    if (stats.pointStats.length < 2) return;
    let best = stats.pointStats[0];
    for (const ps of stats.pointStats) {
      if (ps.speedKmh > best.speedKmh) best = ps;
    }
    setSelectedPointId(best.point.id);
    showToast(`Selected max speed point (${best.speedKmh.toFixed(1)} km/h)`);
  }, [stats.pointStats, showToast]);

  const handleRepairTimestamps = useCallback(() => {
    const targetId = activeTrack?.id || doc.tracks[0]?.id;
    if (!targetId) return;
    let count = 0;
    commitDoc((prev) => {
      const res = repairTrackTimestamps(prev, targetId);
      count = res.repairedCount;
      return res.doc;
    });
    showToast(
      count > 0
        ? `Repaired ${count} timestamp${count > 1 ? 's' : ''} for Strava compatibility`
        : 'All timestamps normalized & Strava-ready'
    );
  }, [activeTrack?.id, doc.tracks, commitDoc, showToast]);

  const handleUpdateMetadata = useCallback(
    (metaPatch: Partial<GpxDocument['metadata']>, trackPatch?: Partial<GpxTrack>) => {
      commitDoc((prev) => ({
        ...prev,
        metadata: { ...prev.metadata, ...metaPatch },
        tracks: trackPatch
          ? prev.tracks.map((t) =>
            t.id === (activeTrack?.id || prev.tracks[0]?.id) ? { ...t, ...trackPatch } : t
          )
          : prev.tracks,
      }));
    },
    [activeTrack?.id, commitDoc]
  );

  const handleShiftTime = useCallback(
    (offsetMs: number) => {
      commitDoc((prev) => shiftDocumentTime(prev, offsetMs));
      showToast(`Shifted timestamps by ${Math.round(offsetMs / 60000)} min`);
    },
    [commitDoc, showToast]
  );

  const handleSetStartTime = useCallback(
    (newStartIso: string, fallbackSpeedKmh: number) => {
      const targetId = activeTrack?.id || doc.tracks[0]?.id;
      if (!targetId) return;
      commitDoc((prev) => setTrackStartTime(prev, targetId, newStartIso, fallbackSpeedKmh));
      showToast('Updated track start date/time');
    },
    [activeTrack?.id, doc.tracks, commitDoc, showToast]
  );

  const handleUpdateWaypoint = useCallback(
    (wptId: string, patch: Partial<Waypoint>) => {
      commitDoc((prev) => ({
        ...prev,
        waypoints: prev.waypoints.map((w) => (w.id === wptId ? { ...w, ...patch } : w)),
      }));
    },
    [commitDoc]
  );

  const handleDeleteWaypoint = useCallback(
    (wptId: string) => {
      commitDoc((prev) => ({
        ...prev,
        waypoints: prev.waypoints.filter((w) => w.id !== wptId),
      }));
    },
    [commitDoc]
  );

  const handleDeleteSegment = useCallback(
    (segmentId: string) => {
      if (!activeTrack) return;
      commitDoc((prev) => ({
        ...prev,
        waypoints: prev.waypoints.filter((w) => w.sourceId !== segmentId),
        tracks: prev.tracks.map((trk) => {
          if (trk.id !== activeTrack.id) return trk;
          const remaining = trk.segments.filter((s) => s.id !== segmentId);
          return {
            ...trk,
            segments:
              remaining.length > 0
                ? remaining
                : [{ id: nextId('seg'), name: 'Empty Track', points: [] }],
          };
        }),
      }));
      setSelectedPointId(null);
      showToast('Removed GPX segment');
    },
    [activeTrack, commitDoc, showToast]
  );

  const handleAdjustChartValue = useCallback(
    (
      pointId: string,
      metric: 'elevation' | 'speed',
      newValue: number,
      smoothRadius: number
    ) => {
      if (!activeTrack) return;
      commitDoc((prev) =>
        metric === 'elevation'
          ? adjustTrackElevation(prev, activeTrack.id, pointId, newValue, smoothRadius)
          : adjustTrackSpeed(prev, activeTrack.id, pointId, newValue, smoothRadius)
      );
      showToast(
        `Adjusted ${metric} (${smoothRadius > 0 ? `smooth ±${smoothRadius}` : 'single'})`
      );
    },
    [activeTrack, commitDoc, showToast]
  );

  const handleFetchTerrain = useCallback(async () => {
    if (!activeTrack) return;
    const allPts = activeTrack.segments.flatMap((s) => s.points);
    if (allPts.length === 0) return;
    setIsFetchingTerrain(true);
    try {
      const map = await fetchTerrainElevations(allPts);
      setTerrainElevations(map);
      showToast('Loaded terrain elevation (DEM) overlay on chart');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to fetch terrain elevation.');
    } finally {
      setIsFetchingTerrain(false);
    }
  }, [activeTrack, showToast]);

  const handleApplyTerrain = useCallback(() => {
    if (!activeTrack || Object.keys(terrainElevations).length === 0) return;
    commitDoc((prev) => ({
      ...prev,
      tracks: prev.tracks.map((trk) => {
        if (trk.id !== activeTrack.id) return trk;
        return {
          ...trk,
          segments: trk.segments.map((seg) => ({
            ...seg,
            points: seg.points.map((pt) =>
              terrainElevations[pt.id] !== undefined
                ? { ...pt, ele: terrainElevations[pt.id] }
                : pt
            ),
          })),
        };
      }),
    }));
    showToast('Applied terrain elevation to GPX trackpoints');
  }, [activeTrack, terrainElevations, commitDoc, showToast]);

  const availableArchiveTypes = useMemo(() => {
    const set = new Set<string>();
    for (const act of archiveActivities) set.add(act.type);
    return Array.from(set).sort();
  }, [archiveActivities]);

  const filteredArchiveActivities = useMemo(() => {
    const fromMs = dateFrom ? Date.parse(`${dateFrom}T00:00:00`) : null;
    const toMs = dateTo ? Date.parse(`${dateTo}T23:59:59.999`) : null;
    const minSpd = speedMin.trim() !== '' ? parseFloat(speedMin) : null;
    const maxSpd = speedMax.trim() !== '' ? parseFloat(speedMax) : null;

    return archiveActivities.filter((act) => {
      if (typeFilter !== 'ALL' && act.type !== typeFilter) return false;
      if (minSpd !== null && !Number.isNaN(minSpd) && act.maxSpeedKmh < minSpd) return false;
      if (maxSpd !== null && !Number.isNaN(maxSpd) && act.maxSpeedKmh > maxSpd) return false;
      if (fromMs !== null || toMs !== null) {
        if (!act.dateIso) return false;
        const ms = Date.parse(act.dateIso);
        if (Number.isNaN(ms)) return false;
        if (fromMs !== null && ms < fromMs) return false;
        if (toMs !== null && ms > toMs) return false;
      }
      return true;
    });
  }, [archiveActivities, dateFrom, dateTo, typeFilter, speedMin, speedMax]);

  const archiveSummary = useMemo(() => {
    let totalDistanceM = 0;
    let totalElevGainM = 0;
    let totalDurationSec = 0;
    let maxSpeedKmh = 0;
    let maxSpeedActivity: ArchiveActivity | null = null;
    let maxElevationM: number | null = null;
    let maxEleActivity: ArchiveActivity | null = null;
    let maxHeartRate: number | null = null;
    let maxPower: number | null = null;

    for (const act of filteredArchiveActivities) {
      totalDistanceM += act.distanceM;
      totalElevGainM += act.elevGainM;
      totalDurationSec += act.durationSec;
      if (act.maxSpeedKmh > maxSpeedKmh) {
        maxSpeedKmh = act.maxSpeedKmh;
        maxSpeedActivity = act;
      }
      if (act.maxElevationM !== null) {
        if (maxElevationM === null || act.maxElevationM > maxElevationM) {
          maxElevationM = act.maxElevationM;
          maxEleActivity = act;
        }
      }
      if (act.maxHeartRate !== null) {
        if (maxHeartRate === null || act.maxHeartRate > maxHeartRate) {
          maxHeartRate = act.maxHeartRate;
        }
      }
      if (act.maxPower !== null) {
        if (maxPower === null || act.maxPower > maxPower) {
          maxPower = act.maxPower;
        }
      }
    }

    const avgSpeedKmh =
      totalDurationSec > 0 ? (totalDistanceM / totalDurationSec) * 3.6 : 0;

    const dateRangeLabel =
      dateFrom || dateTo
        ? `${dateFrom || 'Start'} → ${dateTo || 'Now'}`
        : 'All Time';

    return {
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
      dateRangeLabel,
    };
  }, [filteredArchiveActivities, dateFrom, dateTo]);

  const trimRangeIndices = useMemo<[number, number] | null>(() => {
    if (!trimRangeStartId || !trimRangeEndId) return null;
    const i1 = stats.pointStats.findIndex((ps) => ps.point.id === trimRangeStartId);
    const i2 = stats.pointStats.findIndex((ps) => ps.point.id === trimRangeEndId);
    if (i1 === -1 || i2 === -1) return null;
    return [Math.min(i1, i2), Math.max(i1, i2)];
  }, [stats.pointStats, trimRangeStartId, trimRangeEndId]);

  return (
    <div
      className="app-shell"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDraggingFile(true);
      }}
      onDragLeave={() => setIsDraggingFile(false)}
      onDrop={handleDrop}
    >
      {/* Top Navbar */}
      <header className="topbar">
        <div className="brand">
          <Compass size={22} className="brand-icon" />
          <div>
            <h1>GPX Analyzer &amp; Editor</h1>
            <span className="track-subtitle">
              {viewMode === 'archive'
                ? `Strava Archive • ${filteredArchiveActivities.length} activities`
                : activeTrack?.name || doc.metadata.name || 'Untitled Track'}
            </span>
          </div>
        </div>

        <div className="topbar-actions">
          <input
            ref={fileInputRef}
            type="file"
            accept=".gpx,.zip,application/gpx+xml,application/zip,text/xml"
            onChange={handleFileChange}
            hidden
          />
          <input
            ref={mergeInputRef}
            type="file"
            accept=".gpx,application/gpx+xml,text/xml"
            onChange={handleMergeFileChange}
            hidden
          />
          <input
            ref={zipInputRef}
            type="file"
            accept=".zip,application/zip"
            onChange={handleZipInputChange}
            hidden
          />
          <button className="btn-ghost" onClick={() => fileInputRef.current?.click()}>
            <FolderOpen size={16} />
            <span>Import GPX</span>
          </button>
          <button
            className="btn-ghost"
            onClick={() => zipInputRef.current?.click()}
            title="Import a Strava Account Export .zip archive"
          >
            <Archive size={16} />
            <span>Strava ZIP</span>
          </button>
          {archiveActivities.length > 0 && (
            <button
              className="btn-ghost"
              style={
                viewMode === 'archive'
                  ? { borderColor: '#f97316', color: '#fdba74' }
                  : undefined
              }
              onClick={() => setViewMode((m) => (m === 'archive' ? 'editor' : 'archive'))}
            >
              <span>{viewMode === 'archive' ? 'GPX Editor' : 'Archive View'}</span>
            </button>
          )}
          <button
            className="btn-ghost"
            onClick={() => mergeInputRef.current?.click()}
            title="Merge another .gpx file into the active track"
          >
            <GitMerge size={16} />
            <span>Merge GPX</span>
          </button>
          <button className="btn-ghost" onClick={handleNewEmptyTrack}>
            <FilePlus2 size={16} />
            <span>New Track</span>
          </button>
          <button className="btn-ghost" onClick={handleLoadSample}>
            <span>Sample</span>
          </button>
          <button
            className="btn-ghost"
            style={{ borderColor: '#38bdf8', color: '#7dd3fc' }}
            onClick={() => setShow3DModal(true)}
            disabled={stats.totalPoints < 2}
            title="Open GPX to 3D Mountain &amp; STL Export Studio"
          >
            <Box size={16} />
            <span>GPX to 3D</span>
          </button>

          <div className="divider-v" />

          <button
            className="btn-icon"
            onClick={handleUndo}
            disabled={history.length === 0}
            title="Undo"
          >
            <Undo2 size={16} />
          </button>
          <button
            className="btn-icon"
            onClick={handleRedo}
            disabled={future.length === 0}
            title="Redo"
          >
            <Redo2 size={16} />
          </button>

          <div className="divider-v" />

          <button className="btn-primary" onClick={handleExportGpx}>
            <Download size={16} />
            <span>Export GPX</span>
          </button>
        </div>
      </header>

      {/* Main Workspace */}
      {viewMode === 'archive' ? (
        <div className="workspace">
          <ArchiveSidebar
            activities={archiveActivities}
            filteredActivities={filteredArchiveActivities}
            selectedActivityId={selectedActivityId}
            dateFrom={dateFrom}
            dateTo={dateTo}
            typeFilter={typeFilter}
            speedMin={speedMin}
            speedMax={speedMax}
            availableTypes={availableArchiveTypes}
            totalDistanceM={archiveSummary.totalDistanceM}
            totalElevGainM={archiveSummary.totalElevGainM}
            totalDurationSec={archiveSummary.totalDurationSec}
            avgSpeedKmh={archiveSummary.avgSpeedKmh}
            maxSpeedKmh={archiveSummary.maxSpeedKmh}
            maxSpeedActivity={archiveSummary.maxSpeedActivity}
            maxElevationM={archiveSummary.maxElevationM}
            maxEleActivity={archiveSummary.maxEleActivity}
            maxHeartRate={archiveSummary.maxHeartRate}
            maxPower={archiveSummary.maxPower}
            onChangeDateFrom={setDateFrom}
            onChangeDateTo={setDateTo}
            onChangeTypeFilter={setTypeFilter}
            onChangeSpeedMin={setSpeedMin}
            onChangeSpeedMax={setSpeedMax}
            onResetFilters={() => {
              setDateFrom('');
              setDateTo('');
              setTypeFilter('ALL');
              setSpeedMin('');
              setSpeedMax('');
            }}
            onSelectActivity={setSelectedActivityId}
            onDeleteActivity={(id) => {
              setArchiveActivities((prev) => prev.filter((a) => a.id !== id));
              if (selectedActivityId === id) setSelectedActivityId(null);
              showToast('Removed activity from archive');
            }}
            onOpenInEditor={(act) => {
              if (act.rawGpxText) {
                setViewMode('editor');
                loadGpxText(act.rawGpxText, `${act.name}.gpx`);
              }
            }}
            onOpenShareCard={() => setShowShareCard(true)}
          />
          <main className="main-panel">
            <div className="map-section">
              <ArchiveMap
                activities={filteredArchiveActivities}
                selectedActivityId={selectedActivityId}
                mapLayer={mapLayer}
                onSelectActivity={setSelectedActivityId}
                onChangeLayer={setMapLayer}
              />
            </div>
          </main>
        </div>
      ) : (
        <div className="workspace">
        <Sidebar
          doc={doc}
          activeTrack={activeTrack}
          stats={stats}
          timestampHealth={timestampHealth}
          selectedPointId={selectedPointId}
          onSelectTrack={(id) => {
            setActiveTrackId(id);
            setSelectedPointId(null);
            setFitTrigger((n) => n + 1);
          }}
          onSelectPoint={setSelectedPointId}
          onHoverPoint={setHoveredPointId}
          onUpdatePoint={handleUpdatePoint}
          onDeletePoint={handleDeletePoint}
          onTrimBefore={handleTrimBefore}
          onTrimAfter={handleTrimAfter}
          trimRangeStartId={trimRangeStartId}
          trimRangeEndId={trimRangeEndId}
          onSetTrimRangeStart={setTrimRangeStartId}
          onSetTrimRangeEnd={setTrimRangeEndId}
          onCutRange={handleCutRange}
          onKeepOnlyRange={handleKeepOnlyRange}
          onReverseTrack={handleReverseTrack}
          onSmoothPoint={handleSmoothPoint}
          onFixSpeedSpikes={handleFixSpeedSpikes}
          onJumpToMaxSpeed={handleJumpToMaxSpeed}
          onRepairTimestamps={handleRepairTimestamps}
          onUpdateMetadata={handleUpdateMetadata}
          onShiftTime={handleShiftTime}
          onSetStartTime={handleSetStartTime}
          onUpdateWaypoint={handleUpdateWaypoint}
          onDeleteWaypoint={handleDeleteWaypoint}
          onAddMergeFile={() => mergeInputRef.current?.click()}
          onDeleteSegment={handleDeleteSegment}
          archiveCount={archiveActivities.length}
          onBackToArchive={() => setViewMode('archive')}
        />

        <main className="main-panel">
          <div className="map-section">
            <MapEditor
              track={activeTrack}
              waypoints={doc.waypoints}
              selectedPointId={selectedPointId}
              hoveredPointId={hoveredPointId}
              trimRangeIndices={trimRangeIndices}
              terrainElevations={terrainElevations}
              onlyTerrain={onlyTerrain}
              editMode={editMode}
              mapLayer={mapLayer}
              onSelectPoint={setSelectedPointId}
              onHoverPoint={setHoveredPointId}
              onMovePoint={handleMovePoint}
              onAddPoint={handleAddPoint}
              onAddWaypoint={handleAddWaypoint}
              onChangeEditMode={setEditMode}
              onChangeLayer={setMapLayer}
              fitTrigger={fitTrigger}
            />
          </div>

          <div className="chart-section" style={{ height: `${chartHeight}px` }}>
            <div
              className="chart-resize-bar"
              onMouseDown={handleChartResizeStart}
              title="Drag to resize chart height"
            >
              <div className="chart-resize-gripper" />
            </div>
            <ElevationChart
              pointStats={stats.pointStats}
              selectedPointId={selectedPointId}
              hoveredPointId={hoveredPointId}
              trimRangeIndices={trimRangeIndices}
              terrainElevations={terrainElevations}
              isFetchingTerrain={isFetchingTerrain}
              onlyTerrain={onlyTerrain}
              onToggleOnlyTerrain={() => setOnlyTerrain((v) => !v)}
              onFetchTerrain={handleFetchTerrain}
              onApplyTerrain={handleApplyTerrain}
              onSelectPoint={setSelectedPointId}
              onHoverPoint={setHoveredPointId}
              onAdjustPointValue={handleAdjustChartValue}
            />
          </div>
        </main>
      </div>
      )}

      {/* Strava ZIP Progress Modal */}
      {archiveProgress && (
        <div className="modal-backdrop">
          <div className="progress-modal">
            <h3>Importing Strava Archive</h3>
            <p className="progress-label">{archiveProgress.label}</p>
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{
                  width: `${Math.round(
                    (archiveProgress.current / Math.max(1, archiveProgress.total)) * 100
                  )}%`,
                }}
              />
            </div>
            <div className="progress-pct">
              {Math.round(
                (archiveProgress.current / Math.max(1, archiveProgress.total)) * 100
              )}
              %
            </div>
          </div>
        </div>
      )}

      {/* Share Card JPG Modal */}
      {showShareCard && (
        <ShareCardModal
          activities={filteredArchiveActivities}
          dateRangeLabel={archiveSummary.dateRangeLabel}
          totalDistanceM={archiveSummary.totalDistanceM}
          totalElevGainM={archiveSummary.totalElevGainM}
          totalDurationSec={archiveSummary.totalDurationSec}
          avgSpeedKmh={archiveSummary.avgSpeedKmh}
          maxSpeedKmh={archiveSummary.maxSpeedKmh}
          maxElevationM={archiveSummary.maxElevationM}
          maxHeartRate={archiveSummary.maxHeartRate}
          maxPower={archiveSummary.maxPower}
          onClose={() => setShowShareCard(false)}
        />
      )}

      {/* GPX to 3D Terrain & STL Studio Modal */}
      {show3DModal && activeTrack && (
        <Suspense fallback={<div className="toast">Loading 3D studio...</div>}>
          <GpxTo3DModal
            trackName={activeTrack.name || doc.metadata.name || 'GPX Track'}
            points={activeTrackPoints}
            terrainElevations={terrainElevations}
            onClose={() => setShow3DModal(false)}
          />
        </Suspense>
      )}

      {/* Toast Notification */}
      {statusMessage && <div className="toast">{statusMessage}</div>}

      {/* Drag & Drop Overlay */}
      {isDraggingFile && (
        <div className="drop-overlay">
          <div className="drop-box">Drop your .gpx or Strava .zip file here to import</div>
        </div>
      )}
    </div>
  );
}

export default App;

