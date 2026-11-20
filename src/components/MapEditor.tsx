import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { GpxTrack, MapEditMode, MapLayerType, TrackPoint, Waypoint } from '../types/gpx';
import { getGoogleStreetViewUrl, getGradeColor, haversineDistanceM } from '../utils/gpxParser';
import { ExternalLink, LocateFixed, MapPin, MousePointer, PlusCircle } from 'lucide-react';

interface MapEditorProps {
  track: GpxTrack | undefined;
  waypoints: Waypoint[];
  selectedPointId: string | null;
  hoveredPointId: string | null;
  trimRangeIndices?: [number, number] | null;
  terrainElevations?: Record<string, number>;
  onlyTerrain?: boolean;
  editMode: MapEditMode;
  mapLayer: MapLayerType;
  onSelectPoint: (pointId: string) => void;
  onHoverPoint: (pointId: string | null) => void;
  onMovePoint: (pointId: string, lat: number, lon: number) => void;
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

export const MapEditor: React.FC<MapEditorProps> = ({
  track,
  waypoints,
  selectedPointId,
  hoveredPointId,
  trimRangeIndices = null,
  terrainElevations,
  onlyTerrain = false,
  editMode,
  mapLayer,
  onSelectPoint,
  onHoverPoint,
  onMovePoint,
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
  const hoverMarkerRef = useRef<L.CircleMarker | null>(null);
  const selectedMarkerRef = useRef<L.Marker | null>(null);

  // Keep latest callbacks in refs so Leaflet event listeners never go stale
  const callbacksRef = useRef({
    editMode,
    onSelectPoint,
    onHoverPoint,
    onMovePoint,
    onAddPoint,
    onAddWaypoint,
  });
  callbacksRef.current = {
    editMode,
    onSelectPoint,
    onHoverPoint,
    onMovePoint,
    onAddPoint,
    onAddWaypoint,
  };
  const lastHoveredIdRef = useRef<string | null>(null);

  const trackRef = useRef(track);
  trackRef.current = track;

  // Initialize Leaflet map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: [37.832, -122.485],
      zoom: 14,
      zoomControl: true,
    });

    const tile = L.tileLayer(TILE_LAYERS.osm.url, {
      attribution: TILE_LAYERS.osm.attribution,
      maxZoom: TILE_LAYERS.osm.maxZoom,
    }).addTo(map);

    const trackGroup = L.layerGroup().addTo(map);
    const markersGroup = L.layerGroup().addTo(map);

    map.on('click', (e: L.LeafletMouseEvent) => {
      const { editMode: mode, onAddPoint: addPt, onAddWaypoint: addWpt, onSelectPoint: selPt } =
        callbacksRef.current;

      if (mode === 'add') {
        addPt(e.latlng.lat, e.latlng.lng);
        return;
      }
      if (mode === 'waypoint') {
        addWpt(e.latlng.lat, e.latlng.lng);
        return;
      }

      // In select mode, find nearest trackpoint within reasonable pixel threshold
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
        selPt(closestId);
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
    el.style.cursor = editMode === 'add' || editMode === 'waypoint' ? 'crosshair' : '';
  }, [editMode]);

  // Render track polylines, start/end markers, waypoints, and vertex dots
  useEffect(() => {
    const map = mapRef.current;
    const trackGroup = trackLayerGroupRef.current;
    const markersGroup = markersLayerGroupRef.current;
    if (!map || !trackGroup || !markersGroup) return;

    trackGroup.clearLayers();
    markersGroup.clearLayers();
    selectedMarkerRef.current = null;

    if (track) {
      const allPoints: TrackPoint[] = [];
      for (const seg of track.segments) {
        if (seg.points.length > 0) {
          allPoints.push(...seg.points);
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

      // Render small clickable vertex dots (hidden when Only Terrain mode is active)
      if (!onlyTerrain) {
        const step = allPoints.length > 600 ? Math.ceil(allPoints.length / 400) : 1;
        for (let i = 0; i < allPoints.length; i += step) {
          const pt = allPoints[i];
          if (pt.id === selectedPointId) continue;
          const dot = L.circleMarker([pt.lat, pt.lon], {
            radius: 3.5,
            color: '#ffffff',
            weight: 1.5,
            fillColor: '#f97316',
            fillOpacity: 1,
          });
          dot.on('click', (ev) => {
            L.DomEvent.stopPropagation(ev);
            callbacksRef.current.onSelectPoint(pt.id);
          });
          dot.addTo(markersGroup);
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
          })
            .bindTooltip('End', { direction: 'top' })
            .addTo(markersGroup);
        }
      }

      // Selected point draggable marker
      if (selectedPointId) {
        const selPt = allPoints.find((p) => p.id === selectedPointId);
        if (selPt) {
          const icon = L.divIcon({
            className: 'gpx-selected-pin',
            html: `<div style="width:18px;height:18px;border-radius:50%;background:#3b82f6;border:3px solid #ffffff;box-shadow:0 0 0 3px rgba(59,130,246,0.45),0 2px 6px rgba(0,0,0,0.5);cursor:grab;"></div>`,
            iconSize: [18, 18],
            iconAnchor: [9, 9],
          });

          const marker = L.marker([selPt.lat, selPt.lon], {
            icon,
            draggable: true,
            zIndexOffset: 1000,
          });

          marker.on('dragend', () => {
            const pos = marker.getLatLng();
            callbacksRef.current.onMovePoint(selPt.id, pos.lat, pos.lng);
          });

          marker.bindTooltip(
            `Selected Point<br/>${selPt.lat.toFixed(5)}, ${selPt.lon.toFixed(5)}${
              selPt.ele !== undefined ? `<br/>Ele: ${selPt.ele.toFixed(1)} m` : ''
            }<br/><i>Drag to move</i>`,
            { direction: 'top', offset: [0, -8] }
          );

          marker.addTo(markersGroup);
          selectedMarkerRef.current = marker;
        }
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
  }, [track, waypoints, selectedPointId, terrainElevations, onlyTerrain, trimRangeIndices]);

  // Hover point indicator (synced from chart or table)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (hoverMarkerRef.current) {
      map.removeLayer(hoverMarkerRef.current);
      hoverMarkerRef.current = null;
    }

    if (!hoveredPointId || !track) return;
    const pt = track.segments.flatMap((s) => s.points).find((p) => p.id === hoveredPointId);
    if (!pt) return;

    hoverMarkerRef.current = L.circleMarker([pt.lat, pt.lon], {
      radius: 7,
      color: '#ffffff',
      weight: 2,
      fillColor: '#eab308',
      fillOpacity: 1,
      interactive: false,
    }).addTo(map);
  }, [hoveredPointId, track]);

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

  return (
    <div className="map-wrapper">
      <div ref={containerRef} className="leaflet-container-box" />

      {/* Top-right Map Controls Overlay */}
      <div className="map-overlay-controls">
        <div className="map-control-group">
          <button
            className={`map-btn ${editMode === 'select' ? 'active' : ''}`}
            onClick={() => onChangeEditMode('select')}
            title="Select & Move Points (click track to select, drag blue pin to move)"
          >
            <MousePointer size={15} />
            <span>Select / Move</span>
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
        <div className="map-mode-banner">
          {editMode === 'add'
            ? selectedPointId
              ? 'Click anywhere on the map to insert a new trackpoint after the selected point'
              : 'Click anywhere on the map to append a new trackpoint'
            : 'Click anywhere on the map to place a new waypoint'}
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

