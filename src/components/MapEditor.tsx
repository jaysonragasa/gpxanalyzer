import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { GpxTrack, MapEditMode, MapLayerType, TrackPoint, Waypoint } from '../types/gpx';
import { getGoogleStreetViewUrl, getGradeColor, haversineDistanceM } from '../utils/gpxParser';
import { OffRoadAnomaly } from '../utils/roadAnalysis';
import { ExternalLink, Link2, LocateFixed, MapPin, MousePointer, PlusCircle } from 'lucide-react';

interface MapEditorProps {
  track: GpxTrack | undefined;
  waypoints: Waypoint[];
  selectedPointId: string | null;
  hoveredPointId: string | null;
  focusPointRequest?: { pointId: string; metric?: 'elevation' | 'speed'; seq: number } | null;
  trimRangeIndices?: [number, number] | null;
  offRoadAnomalies?: OffRoadAnomaly[];
  onFixOffRoadAnomaly?: (anomaly: OffRoadAnomaly, mode: 'road' | 'neighbors') => void;
  terrainElevations?: Record<string, number>;
  onlyTerrain?: boolean;
  editMode: MapEditMode;
  mapLayer: MapLayerType;
  dragSmoothRadius: number;
  onChangeDragSmoothRadius: (radius: number) => void;
  onSelectPoint: (pointId: string) => void;
  onHoverPoint: (pointId: string | null) => void;
  onMovePoint: (pointId: string, lat: number, lon: number, smoothRadius?: number) => void;
  onDeletePoint: (pointId: string) => void;
  onConnectPoints: (pointAId: string, pointBId: string) => void;
  onAddPoint: (lat: number, lon: number) => void;
  onAddWaypoint: (lat: number, lon: number) => void;
  onChangeEditMode: (mode: MapEditMode) => void;
  onChangeLayer: (layer: MapLayerType) => void;
  fitTrigger: number;
}

const TILE_LAYERS: Record<MapLayerType, { url: string; attribution: string; maxZoom: number }> = {
  osm: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  },
  topo: {
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap, SRTM | &copy; OpenTopoMap',
    maxZoom: 17,
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    maxZoom: 19,
  },
};

function cosineFalloff(offset: number, radius: number): number {
  if (radius <= 0) return offset === 0 ? 1 : 0;
  const abs = Math.abs(offset);
  if (abs > radius) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * abs) / (radius + 1)));
}

export const MapEditor: React.FC<MapEditorProps> = ({
  track,
  waypoints,
  selectedPointId,
  hoveredPointId,
  focusPointRequest = null,
  trimRangeIndices = null,
  offRoadAnomalies = [],
  onFixOffRoadAnomaly,
  terrainElevations,
  onlyTerrain = false,
  editMode,
  mapLayer,
  dragSmoothRadius,
  onChangeDragSmoothRadius,
  onSelectPoint,
  onHoverPoint,
  onMovePoint,
  onDeletePoint,
  onConnectPoints,
  onAddPoint,
  onAddWaypoint,
  onChangeEditMode,
  onChangeLayer,
  fitTrigger,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const trackLayerGroupRef = useRef<L.LayerGroup | null>(null);
  const markersLayerGroupRef = useRef<L.LayerGroup | null>(null);
  const previewLayerGroupRef = useRef<L.LayerGroup | null>(null);
  const hoverMarkerRef = useRef<L.Marker | null>(null);

  const [connectStartId, setConnectStartId] = useState<string | null>(null);
  const [viewRevision, setViewRevision] = useState<number>(0);

  // Reset connect anchor when leaving connect mode or switching tracks
  useEffect(() => {
    if (editMode !== 'connect') {
      setConnectStartId(null);
    }
  }, [editMode, track?.id]);

  // Allow Escape key to cancel current connect anchor
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && connectStartId) {
        setConnectStartId(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [connectStartId]);

  const handlePointClick = (pointId: string) => {
    if (callbacksRef.current.editMode === 'connect') {
      const startId = connectStartIdRef.current;
      if (!startId) {
        setConnectStartId(pointId);
        callbacksRef.current.onSelectPoint(pointId);
      } else if (startId === pointId) {
        setConnectStartId(null);
      } else {
        callbacksRef.current.onConnectPoints(startId, pointId);
        setConnectStartId(null);
        callbacksRef.current.onSelectPoint(pointId);
      }
      return;
    }
    callbacksRef.current.onSelectPoint(pointId);
  };

  const connectStartIdRef = useRef<string | null>(null);
  connectStartIdRef.current = connectStartId;

  // Keep latest callbacks in refs so Leaflet event listeners never go stale
  const callbacksRef = useRef({
    editMode,
    dragSmoothRadius,
    onSelectPoint,
    onHoverPoint,
    onMovePoint,
    onDeletePoint,
    onConnectPoints,
    onFixOffRoadAnomaly,
    onAddPoint,
    onAddWaypoint,
    handlePointClick,
  });
  callbacksRef.current = {
    editMode,
    dragSmoothRadius,
    onSelectPoint,
    onHoverPoint,
    onMovePoint,
    onDeletePoint,
    onConnectPoints,
    onFixOffRoadAnomaly,
    onAddPoint,
    onAddWaypoint,
    handlePointClick,
  };
  const lastHoveredIdRef = useRef<string | null>(null);

  const trackRef = useRef(track);
  trackRef.current = track;

  // Initialize Leaflet map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: [16.4151, 120.5973],
      zoom: 15,
      zoomControl: true,
    });

    const tile = L.tileLayer(TILE_LAYERS.osm.url, {
      attribution: TILE_LAYERS.osm.attribution,
      maxZoom: TILE_LAYERS.osm.maxZoom,
    }).addTo(map);

    const trackGroup = L.layerGroup().addTo(map);
    const previewGroup = L.layerGroup().addTo(map);
    const markersGroup = L.layerGroup().addTo(map);

    map.on('moveend zoomend', () => {
      setViewRevision((r) => r + 1);
    });

    map.on('click', (e: L.LeafletMouseEvent) => {
      const {
        editMode: mode,
        onAddPoint: addPt,
        onAddWaypoint: addWpt,
        handlePointClick: clickPt,
      } = callbacksRef.current;

      if (mode === 'add') {
        addPt(e.latlng.lat, e.latlng.lng);
        return;
      }
      if (mode === 'waypoint') {
        addWpt(e.latlng.lat, e.latlng.lng);
        return;
      }

      // In select or connect mode, find nearest trackpoint within reasonable pixel threshold
      const currentTrack = trackRef.current;
      if (!currentTrack) return;
      const points = currentTrack.segments.flatMap((s) => s.points);
      if (points.length === 0) return;

      const clickPx = map.latLngToContainerPoint(e.latlng);
      let closestId: string | null = null;
      let minDistPx = 28; // 28px click tolerance

      for (const pt of points) {
        const ptPx = map.latLngToContainerPoint([pt.lat, pt.lon]);
        const d = clickPx.distanceTo(ptPx);
        if (d < minDistPx) {
          minDistPx = d;
          closestId = pt.id;
        }
      }

      if (closestId) {
        clickPt(closestId);
      }
    });

    map.on('mousemove', (e: L.LeafletMouseEvent) => {
      const currentTrack = trackRef.current;
      if (!currentTrack) {
        if (lastHoveredIdRef.current !== null) {
          lastHoveredIdRef.current = null;
          callbacksRef.current.onHoverPoint(null);
        }
        return;
      }

      const points = currentTrack.segments.flatMap((s) => s.points);
      if (points.length === 0) return;

      const mousePx = map.latLngToContainerPoint(e.latlng);
      let closestId: string | null = null;
      let minDistPx = 22;

      for (const pt of points) {
        const ptPx = map.latLngToContainerPoint([pt.lat, pt.lon]);
        const d = mousePx.distanceTo(ptPx);
        if (d < minDistPx) {
          minDistPx = d;
          closestId = pt.id;
        }
      }

      if (closestId !== lastHoveredIdRef.current) {
        lastHoveredIdRef.current = closestId;
        callbacksRef.current.onHoverPoint(closestId);
      }
    });

    map.on('mouseout', () => {
      if (lastHoveredIdRef.current !== null) {
        lastHoveredIdRef.current = null;
        callbacksRef.current.onHoverPoint(null);
      }
    });

    mapRef.current = map;
    tileLayerRef.current = tile;
    trackLayerGroupRef.current = trackGroup;
    previewLayerGroupRef.current = previewGroup;
    markersLayerGroupRef.current = markersGroup;

    const resizeObserver = new ResizeObserver(() => {
      map.invalidateSize();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Update tile layer when mapLayer changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (tileLayerRef.current) {
      map.removeLayer(tileLayerRef.current);
    }
    const cfg = TILE_LAYERS[mapLayer];
    tileLayerRef.current = L.tileLayer(cfg.url, {
      attribution: cfg.attribution,
      maxZoom: cfg.maxZoom,
    }).addTo(map);
    tileLayerRef.current.bringToBack();
  }, [mapLayer]);

  // Update cursor style based on editMode
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.style.cursor =
      editMode === 'add' || editMode === 'waypoint' || editMode === 'connect'
        ? 'crosshair'
        : '';
  }, [editMode]);

  // Render track polylines, gap bridges, start/end markers, waypoints, and draggable vertex handles
  useEffect(() => {
    const map = mapRef.current;
    const trackGroup = trackLayerGroupRef.current;
    const markersGroup = markersLayerGroupRef.current;
    const previewGroup = previewLayerGroupRef.current;
    if (!map || !trackGroup || !markersGroup || !previewGroup) return;

    trackGroup.clearLayers();
    markersGroup.clearLayers();
    previewGroup.clearLayers();

    if (track) {
      const allPoints: TrackPoint[] = [];
      const segmentEndpointIds = new Set<string>();
      const nonEmptySegments = track.segments.filter((s) => s.points.length > 0);

      for (const seg of nonEmptySegments) {
        allPoints.push(...seg.points);
        segmentEndpointIds.add(seg.points[0].id);
        segmentEndpointIds.add(seg.points[seg.points.length - 1].id);

        const latlngs: L.LatLngExpression[] = seg.points.map((p) => [p.lat, p.lon]);

        // Outer glow / casing
        L.polyline(latlngs, {
          color: '#0f172a',
          weight: 7,
          opacity: 0.5,
        }).addTo(trackGroup);

        // Main track line (multi-colored by grade % when elevation data exists)
        const getEle = (pt: TrackPoint) =>
          terrainElevations?.[pt.id] !== undefined ? terrainElevations[pt.id] : pt.ele;
        const hasAnyEle = seg.points.some((p) => getEle(p) !== undefined);

        if (hasAnyEle && seg.points.length >= 2) {
          let activeColor: string | null = null;
          let activePts: L.LatLngExpression[] = [];

          for (let i = 1; i < seg.points.length; i += 1) {
            const prev = seg.points[i - 1];
            const curr = seg.points[i];
            const e1 = getEle(prev);
            const e2 = getEle(curr);
            let color = '#22c55e';
            if (e1 !== undefined && e2 !== undefined) {
              const dist = haversineDistanceM(prev.lat, prev.lon, curr.lat, curr.lon);
              const grade = dist > 0.5 ? ((e2 - e1) / dist) * 100 : 0;
              color = getGradeColor(grade);
            }
            if (color === activeColor) {
              activePts.push([curr.lat, curr.lon]);
            } else {
              if (activeColor && activePts.length >= 2) {
                L.polyline(activePts, {
                  color: activeColor,
                  weight: 4,
                  opacity: 0.95,
                }).addTo(trackGroup);
              }
              activeColor = color;
              activePts = [
                [prev.lat, prev.lon],
                [curr.lat, curr.lon],
              ];
            }
          }
          if (activeColor && activePts.length >= 2) {
            L.polyline(activePts, {
              color: activeColor,
              weight: 4,
              opacity: 0.95,
            }).addTo(trackGroup);
          }
        } else {
          L.polyline(latlngs, {
            color: '#f97316',
            weight: 4,
            opacity: 0.95,
          }).addTo(trackGroup);
        }
      }

      // Render clickable dashed gap bridges between separate segments
      if (nonEmptySegments.length > 1) {
        for (let s = 0; s < nonEmptySegments.length - 1; s += 1) {
          const prevSeg = nonEmptySegments[s];
          const nextSeg = nonEmptySegments[s + 1];
          const endPt = prevSeg.points[prevSeg.points.length - 1];
          const startPt = nextSeg.points[0];
          const gapDistM = Math.round(
            haversineDistanceM(endPt.lat, endPt.lon, startPt.lat, startPt.lon)
          );

          const gapLine = L.polyline(
            [
              [endPt.lat, endPt.lon],
              [startPt.lat, startPt.lon],
            ],
            {
              color: '#38bdf8',
              weight: 4,
              opacity: 0.9,
              dashArray: '6 6',
            }
          );
          gapLine.bindTooltip(
            `Unconnected Gap (${gapDistM} m)<br/><b>Click to connect these two points</b>`,
            { sticky: true, direction: 'top' }
          );
          gapLine.on('click', (ev) => {
            L.DomEvent.stopPropagation(ev);
            callbacksRef.current.onConnectPoints(endPt.id, startPt.id);
          });
          gapLine.addTo(trackGroup);
        }
      }

      // Highlight selected trim/cut portion (A -> B)
      if (trimRangeIndices) {
        const [lo, hi] = trimRangeIndices;
        const slice = allPoints.slice(lo, hi + 1);
        if (slice.length >= 2) {
          L.polyline(
            slice.map((p) => [p.lat, p.lon] as L.LatLngExpression),
            {
              color: '#f43f5e',
              weight: 6,
              opacity: 0.9,
              dashArray: '8 6',
            }
          ).addTo(trackGroup);
        }
      }

      // Highlight detected off-road excursions & green suggested on-road snap path
      const offRoadPointSet = new Set<string>();
      for (const anom of offRoadAnomalies) {
        for (const pid of anom.pointIds) offRoadPointSet.add(pid);

        if (anom.originalPath.length >= 2) {
          L.polyline(anom.originalPath, {
            color: '#ec4899',
            weight: 5,
            opacity: 0.85,
            dashArray: '5 5',
          })
            .bindTooltip(
              `Off-Road Detour (#${anom.startIndex + 1}${
                anom.endIndex > anom.startIndex ? `–#${anom.endIndex + 1}` : ''
              } • ${anom.maxOffRoadDistM.toFixed(0)} m off road)`,
              { sticky: true, direction: 'top' }
            )
            .addTo(trackGroup);
        }

        if (anom.suggestedPath.length >= 2) {
          const snapLine = L.polyline(anom.suggestedPath, {
            color: '#10b981',
            weight: 5,
            opacity: 0.92,
            dashArray: '7 5',
          });
          snapLine.bindTooltip(
            `Suggested Road Path${anom.roadName ? ` (${anom.roadName})` : ''}<br/><b>Click to snap ${
              anom.pointIds.length
            } off-road point${anom.pointIds.length > 1 ? 's' : ''} onto road</b>`,
            { sticky: true, direction: 'top' }
          );
          snapLine.on('click', (ev) => {
            L.DomEvent.stopPropagation(ev);
            callbacksRef.current.onFixOffRoadAnomaly?.(anom, 'road');
          });
          snapLine.addTo(trackGroup);
        }
      }

      // Start & End markers
      if (allPoints.length > 0) {
        const start = allPoints[0];
        const end = allPoints[allPoints.length - 1];

        L.circleMarker([start.lat, start.lon], {
          radius: 7,
          color: '#ffffff',
          weight: 2,
          fillColor: '#22c55e',
          fillOpacity: 1,
          interactive: false,
        })
          .bindTooltip('Start', { direction: 'top' })
          .addTo(markersGroup);

        if (allPoints.length > 1) {
          L.circleMarker([end.lat, end.lon], {
            radius: 7,
            color: '#ffffff',
            weight: 2,
            fillColor: '#ef4444',
            fillOpacity: 1,
            interactive: false,
          })
            .bindTooltip('End', { direction: 'top' })
            .addTo(markersGroup);
        }
      }

      // Render directly-draggable & clickable vertex handles (viewport-culled for speed & density)
      if (!onlyTerrain && allPoints.length > 0) {
        const bounds = map.getBounds().pad(0.2);
        const inViewIndices: number[] = [];
        for (let i = 0; i < allPoints.length; i += 1) {
          const p = allPoints[i];
          if (bounds.contains([p.lat, p.lon])) {
            inViewIndices.push(i);
          }
        }

        const maxVisibleHandles = 400;
        const step =
          inViewIndices.length > maxVisibleHandles
            ? Math.ceil(inViewIndices.length / maxVisibleHandles)
            : 1;

        const indicesToRender = new Set<number>();
        for (let k = 0; k < inViewIndices.length; k += step) {
          indicesToRender.add(inViewIndices[k]);
        }

        // Always render selected point, connect anchor point, off-road points, and segment gap endpoints
        for (let i = 0; i < allPoints.length; i += 1) {
          const ptId = allPoints[i].id;
          if (
            ptId === selectedPointId ||
            ptId === connectStartId ||
            offRoadPointSet.has(ptId) ||
            segmentEndpointIds.has(ptId)
          ) {
            indicesToRender.add(i);
          }
        }

        indicesToRender.forEach((idx) => {
          const pt = allPoints[idx];
          const isSelected = pt.id === selectedPointId;
          const isConnectAnchor = pt.id === connectStartId;
          const isOffRoad = offRoadPointSet.has(pt.id);
          const isGapEndpoint =
            segmentEndpointIds.has(pt.id) &&
            idx !== 0 &&
            idx !== allPoints.length - 1;

          let size = 10;
          let bg = '#fb923c';
          let border = '2px solid #ffffff';
          let shadow = '0 1px 3px rgba(0,0,0,0.5)';
          let zOffset = 100;
          let innerDotHtml = '';

          if (isConnectAnchor) {
            size = 24;
            bg = '#06b6d4';
            border = '3px solid #ffffff';
            shadow =
              '0 0 0 3px #0f172a, 0 0 0 7px rgba(6,182,212,0.55), 0 4px 10px rgba(0,0,0,0.75)';
            zOffset = 12000;
            innerDotHtml =
              '<div style="width:6px;height:6px;border-radius:50%;background:#ffffff;"></div>';
          } else if (isSelected) {
            size = 24;
            bg = '#d946ef';
            border = '3px solid #ffffff';
            shadow =
              '0 0 0 3px #0f172a, 0 0 0 7px rgba(217,70,239,0.6), 0 4px 10px rgba(0,0,0,0.75)';
            zOffset = 10000;
            innerDotHtml =
              '<div style="width:6px;height:6px;border-radius:50%;background:#ffffff;"></div>';
          } else if (isOffRoad) {
            size = 14;
            bg = '#f43f5e';
            border = '2px solid #ffffff';
            shadow = '0 0 0 3px rgba(244,63,94,0.45), 0 1px 4px rgba(0,0,0,0.5)';
            zOffset = 700;
          } else if (isGapEndpoint) {
            size = 14;
            bg = '#38bdf8';
            border = '2px solid #ffffff';
            shadow = '0 0 0 2px rgba(56,189,248,0.4), 0 1px 4px rgba(0,0,0,0.5)';
            zOffset = 500;
          }

          const cursor = editMode === 'connect' ? 'pointer' : 'grab';
          const icon = L.divIcon({
            className: 'gpx-vertex-handle',
            html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${bg};border:${border};box-shadow:${shadow};cursor:${cursor};box-sizing:border-box;display:flex;align-items:center;justify-content:center;">${innerDotHtml}</div>`,
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2],
          });

          const marker = L.marker([pt.lat, pt.lon], {
            icon,
            draggable: editMode !== 'connect',
            zIndexOffset: zOffset,
          });

          marker.on('click', (ev) => {
            L.DomEvent.stopPropagation(ev);
            callbacksRef.current.handlePointClick(pt.id);
          });

          // Right-click on any vertex handle deletes the point immediately
          marker.on('contextmenu', (ev) => {
            L.DomEvent.stopPropagation(ev);
            callbacksRef.current.onDeletePoint(pt.id);
          });

          marker.on('drag', () => {
            const pos = marker.getLatLng();
            const radius = callbacksRef.current.dragSmoothRadius;
            const dLat = pos.lat - pt.lat;
            const dLon = pos.lng - pt.lon;

            previewGroup.clearLayers();
            const lo = Math.max(0, idx - radius - 1);
            const hi = Math.min(allPoints.length - 1, idx + radius + 1);
            const previewCoords: L.LatLngExpression[] = [];

            for (let k = lo; k <= hi; k += 1) {
              const p = allPoints[k];
              const w = cosineFalloff(k - idx, radius);
              if (k === idx) {
                previewCoords.push([pos.lat, pos.lng]);
              } else if (w > 0) {
                previewCoords.push([p.lat + dLat * w, p.lon + dLon * w]);
              } else {
                previewCoords.push([p.lat, p.lon]);
              }
            }

            if (previewCoords.length >= 2) {
              L.polyline(previewCoords, {
                color: '#38bdf8',
                weight: 4,
                opacity: 0.95,
                dashArray: '6 4',
              }).addTo(previewGroup);
            }
          });

          marker.on('dragend', () => {
            previewGroup.clearLayers();
            const pos = marker.getLatLng();
            callbacksRef.current.onSelectPoint(pt.id);
            callbacksRef.current.onMovePoint(
              pt.id,
              pos.lat,
              pos.lng,
              callbacksRef.current.dragSmoothRadius
            );
          });

          const tooltipText =
            editMode === 'connect'
              ? connectStartId
                ? `Point #${idx + 1}<br/><b>Click to connect Point A → here</b>`
                : `Point #${idx + 1}<br/><b>Click to set as Point A</b>`
              : `Point #${idx + 1}${isOffRoad ? ' (Off-Road Detected)' : ''}${
                  isGapEndpoint ? ' (Gap Endpoint)' : ''
                }<br/>${pt.lat.toFixed(5)}, ${pt.lon.toFixed(5)}${
                  pt.ele !== undefined ? `<br/>Ele: ${pt.ele.toFixed(1)} m` : ''
                }<br/><i>Drag to move • Right-click to delete</i>`;

          marker.bindTooltip(tooltipText, {
            direction: 'top',
            offset: [0, -6],
          });

          marker.addTo(markersGroup);
        });
      }
    }

    // Waypoints
    for (const wpt of waypoints) {
      const wptIcon = L.divIcon({
        className: 'gpx-wpt-pin',
        html: `<div style="width:14px;height:14px;transform:rotate(45deg);background:#a855f7;border:2px solid #ffffff;box-shadow:0 2px 5px rgba(0,0,0,0.45);"></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      });
      L.marker([wpt.lat, wpt.lon], { icon: wptIcon })
        .bindTooltip(wpt.name || 'Waypoint', { direction: 'top' })
        .addTo(markersGroup);
    }
  }, [
    track,
    waypoints,
    selectedPointId,
    connectStartId,
    editMode,
    terrainElevations,
    onlyTerrain,
    trimRangeIndices,
    offRoadAnomalies,
    viewRevision,
  ]);

  // Hover point indicator & live Connect A -> B preview line
  useEffect(() => {
    const map = mapRef.current;
    const previewGroup = previewLayerGroupRef.current;
    if (!map) return;

    if (hoverMarkerRef.current) {
      map.removeLayer(hoverMarkerRef.current);
      hoverMarkerRef.current = null;
    }

    if (previewGroup && editMode === 'connect') {
      previewGroup.clearLayers();
    }

    if (!hoveredPointId || !track) return;
    const allPts = track.segments.flatMap((s) => s.points);
    const hoverIdx = allPts.findIndex((p) => p.id === hoveredPointId);
    if (hoverIdx === -1) return;
    const pt = allPts[hoverIdx];

    const hoverColor = editMode === 'connect' ? '#06b6d4' : '#facc15';
    const hoverGlow = editMode === 'connect' ? 'rgba(6,182,212,0.6)' : 'rgba(250,204,21,0.65)';
    const hoverIcon = L.divIcon({
      className: 'gpx-hover-point-marker',
      html: `<div style="width:22px;height:22px;border-radius:50%;background:${hoverColor};border:3px solid #0f172a;box-shadow:0 0 0 2px #ffffff, 0 0 0 6px ${hoverGlow}, 0 3px 8px rgba(0,0,0,0.75);box-sizing:border-box;display:flex;align-items:center;justify-content:center;pointer-events:none;"><div style="width:6px;height:6px;border-radius:50%;background:#0f172a;"></div></div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });

    hoverMarkerRef.current = L.marker([pt.lat, pt.lon], {
      icon: hoverIcon,
      interactive: false,
      zIndexOffset: 15000,
    }).addTo(map);

    // In Connect mode with Point A chosen, show live preview line A -> hovered B
    // and highlight the noisy intermediate points that will be removed
    if (editMode === 'connect' && connectStartId && previewGroup && connectStartId !== pt.id) {
      const startIdx = allPts.findIndex((p) => p.id === connectStartId);
      if (startIdx !== -1) {
        const startPt = allPts[startIdx];
        const lo = Math.min(startIdx, hoverIdx);
        const hi = Math.max(startIdx, hoverIdx);

        if (hi - lo > 1) {
          const removedSlice = allPts.slice(lo, hi + 1);
          L.polyline(
            removedSlice.map((p) => [p.lat, p.lon] as L.LatLngExpression),
            {
              color: '#ef4444',
              weight: 5,
              opacity: 0.75,
              dashArray: '5 6',
            }
          ).addTo(previewGroup);
        }

        L.polyline(
          [
            [startPt.lat, startPt.lon],
            [pt.lat, pt.lon],
          ],
          {
            color: '#06b6d4',
            weight: 5,
            opacity: 0.95,
            dashArray: '8 5',
          }
        ).addTo(previewGroup);
      }
    }
  }, [hoveredPointId, track, editMode, connectStartId]);

  // Fit bounds when fitTrigger increments
  const handleFitBounds = () => {
    const map = mapRef.current;
    if (!map || !track) return;
    const pts = track.segments.flatMap((s) => s.points);
    if (pts.length === 0) return;
    const bounds = L.latLngBounds(pts.map((p) => [p.lat, p.lon] as [number, number]));
    map.fitBounds(bounds, { padding: [36, 36], maxZoom: 16 });
  };

  useEffect(() => {
    if (fitTrigger > 0) {
      handleFitBounds();
    }
  }, [fitTrigger]);

  // Zoom & center map on requested focus point (e.g. from spike list or Jump to Max Speed)
  useEffect(() => {
    if (!focusPointRequest || !track) return;
    const map = mapRef.current;
    if (!map) return;
    const pt = track.segments.flatMap((s) => s.points).find((p) => p.id === focusPointRequest.pointId);
    if (!pt) return;
    const maxZoom = TILE_LAYERS[mapLayer]?.maxZoom ?? 18;
    const targetZoom = Math.min(maxZoom, Math.max(map.getZoom(), 17));
    map.setView([pt.lat, pt.lon], targetZoom, { animate: true });
  }, [focusPointRequest?.seq]);

  const connectStartIndex =
    connectStartId && track
      ? track.segments.flatMap((s) => s.points).findIndex((p) => p.id === connectStartId)
      : -1;

  return (
    <div className="map-wrapper">
      <div ref={containerRef} className="leaflet-container-box" />

      {/* Top-right Map Controls Overlay */}
      <div className="map-overlay-controls">
        <div className="map-control-group">
          <button
            className={`map-btn ${editMode === 'select' ? 'active' : ''}`}
            onClick={() => onChangeEditMode('select')}
            title="Select & Drag Any Trackpoint (drag dots directly to fix GPS jumps, right-click a dot to delete)"
          >
            <MousePointer size={15} />
            <span>Select / Drag</span>
          </button>
          <button
            className={`map-btn ${editMode === 'connect' ? 'active' : ''}`}
            onClick={() => onChangeEditMode('connect')}
            title="Connect Two Points (click 1st clean point, then click 2nd clean point to bridge gaps or remove noisy detours)"
          >
            <Link2 size={15} />
            <span>Connect Points</span>
          </button>
          <button
            className={`map-btn ${editMode === 'add' ? 'active' : ''}`}
            onClick={() => onChangeEditMode('add')}
            title="Add Trackpoints (click on map to append or insert after selected)"
          >
            <PlusCircle size={15} />
            <span>Add Point</span>
          </button>
          <button
            className={`map-btn ${editMode === 'waypoint' ? 'active' : ''}`}
            onClick={() => onChangeEditMode('waypoint')}
            title="Drop Waypoint (click on map to add a waypoint)"
          >
            <MapPin size={15} />
            <span>Add Waypoint</span>
          </button>
        </div>

        {editMode === 'select' && (
          <div className="map-control-group" title="When dragging a point, smoothly pull neighboring points along with it">
            <span style={{ fontSize: 11, color: '#94a3b8', padding: '0 6px', alignSelf: 'center' }}>
              Drag Pull:
            </span>
            <select
              className="map-select"
              value={dragSmoothRadius}
              onChange={(e) => onChangeDragSmoothRadius(Number(e.target.value))}
              aria-label="Drag neighbor pull radius"
            >
              <option value={0}>Single Point</option>
              <option value={2}>Smooth ±2 pts</option>
              <option value={5}>Smooth ±5 pts</option>
              <option value={10}>Smooth ±10 pts</option>
              <option value={20}>Smooth ±20 pts</option>
            </select>
          </div>
        )}

        <div className="map-control-group">
          <select
            className="map-select"
            value={mapLayer}
            onChange={(e) => onChangeLayer(e.target.value as MapLayerType)}
            aria-label="Map layer"
          >
            <option value="osm">OpenStreetMap</option>
            <option value="topo">OpenTopoMap</option>
            <option value="satellite">Satellite (Esri)</option>
          </select>
          <button className="map-btn" onClick={handleFitBounds} title="Fit track to view">
            <LocateFixed size={15} />
            <span>Fit</span>
          </button>
          {selectedPointId && track && (
            <button
              className="map-btn"
              onClick={() => {
                const pts = track.segments.flatMap((s) => s.points);
                const url = getGoogleStreetViewUrl(pts, selectedPointId);
                if (url) window.open(url, '_blank', 'noopener,noreferrer');
              }}
              title="Open Google Maps 360° Street View at the selected point"
            >
              <ExternalLink size={14} />
              <span>360° View</span>
            </button>
          )}
        </div>
      </div>

      {editMode !== 'select' && (
        <div
          className="map-mode-banner"
          style={
            editMode === 'connect'
              ? { borderColor: '#06b6d4', pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 10 }
              : undefined
          }
        >
          {editMode === 'connect' ? (
            connectStartId ? (
              <>
                <span>
                  <strong style={{ color: '#22d3ee' }}>Point A (#{connectStartIndex + 1})</strong> selected — now click the 2nd clean point (<strong>Point B</strong>) to connect them directly
                </span>
                <button
                  className="btn-secondary-sm"
                  style={{ padding: '2px 8px', fontSize: 11 }}
                  onClick={() => setConnectStartId(null)}
                >
                  Reset A
                </button>
              </>
            ) : (
              <span>
                <strong>Connect Mode:</strong> Click the 1st clean trackpoint (<strong>Point A</strong>) before the GPS jump or gap
              </span>
            )
          ) : editMode === 'add' ? (
            selectedPointId ? (
              'Click anywhere on the map to insert a new trackpoint after the selected point'
            ) : (
              'Click anywhere on the map to append a new trackpoint'
            )
          ) : (
            'Click anywhere on the map to place a new waypoint'
          )}
        </div>
      )}

      <div className="map-grade-legend" title="Track &amp; Terrain Grade %">
        <span className="legend-item"><i style={{ background: '#38bdf8' }} />&lt;-3%</span>
        <span className="legend-item"><i style={{ background: '#22c55e' }} />-3..3%</span>
        <span className="legend-item"><i style={{ background: '#eab308' }} />3..6%</span>
        <span className="legend-item"><i style={{ background: '#f97316' }} />6..10%</span>
        <span className="legend-item"><i style={{ background: '#ef4444' }} />&gt;10%</span>
      </div>
    </div>
  );
};
