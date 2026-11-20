import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { LocateFixed } from 'lucide-react';
import { ArchiveActivity } from '../utils/stravaArchive';
import { MapLayerType } from '../types/gpx';
import { formatDistance } from '../utils/gpxParser';

interface ArchiveMapProps {
  activities: ArchiveActivity[];
  selectedActivityId: string | null;
  mapLayer: MapLayerType;
  onSelectActivity: (id: string) => void;
  onChangeLayer: (layer: MapLayerType) => void;
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

export const ArchiveMap: React.FC<ArchiveMapProps> = ({
  activities,
  selectedActivityId,
  mapLayer,
  onSelectActivity,
  onChangeLayer,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const groupRef = useRef<L.LayerGroup | null>(null);
  const onSelectRef = useRef(onSelectActivity);
  onSelectRef.current = onSelectActivity;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { center: [14.6, 121.0], zoom: 11 });
    const tile = L.tileLayer(TILE_LAYERS.osm.url, {
      attribution: TILE_LAYERS.osm.attribution,
      maxZoom: TILE_LAYERS.osm.maxZoom,
    }).addTo(map);
    const group = L.layerGroup().addTo(map);

    const resizeObserver = new ResizeObserver(() => map.invalidateSize());
    resizeObserver.observe(containerRef.current);

    mapRef.current = map;
    tileLayerRef.current = tile;
    groupRef.current = group;

    return () => {
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (tileLayerRef.current) map.removeLayer(tileLayerRef.current);
    const cfg = TILE_LAYERS[mapLayer];
    tileLayerRef.current = L.tileLayer(cfg.url, {
      attribution: cfg.attribution,
      maxZoom: cfg.maxZoom,
    }).addTo(map);
    tileLayerRef.current.bringToBack();
  }, [mapLayer]);

  const fitAll = () => {
    const map = mapRef.current;
    if (!map || activities.length === 0) return;
    const coords: [number, number][] = [];
    for (const act of activities) {
      for (const p of act.points) coords.push([p.lat, p.lon]);
    }
    if (coords.length > 0) {
      map.fitBounds(L.latLngBounds(coords), { padding: [32, 32], maxZoom: 15 });
    }
  };

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    group.clearLayers();

    for (const act of activities) {
      if (act.points.length < 2) continue;
      const isSelected = act.id === selectedActivityId;
      const latlngs: L.LatLngExpression[] = act.points.map((p) => [p.lat, p.lon]);
      const line = L.polyline(latlngs, {
        color: isSelected ? '#38bdf8' : '#fc4c02',
        weight: isSelected ? 4.5 : 2.6,
        opacity: isSelected ? 1 : 0.72,
      });
      const dateLabel = act.dateIso ? new Date(act.dateIso).toLocaleDateString() : '';
      line.bindTooltip(
        `<strong>${act.name}</strong><br/>${formatDistance(act.distanceM)}${
          dateLabel ? ` • ${dateLabel}` : ''
        }`,
        { sticky: true }
      );
      line.on('click', () => onSelectRef.current(act.id));
      line.addTo(group);
      if (isSelected) line.bringToFront();
    }
  }, [activities, selectedActivityId]);

  useEffect(() => {
    fitAll();
  }, [activities.length]);

  return (
    <div className="map-wrapper">
      <div ref={containerRef} className="leaflet-container-box" />
      <div className="map-overlay-controls">
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
          <button className="map-btn" onClick={fitAll} title="Fit all activities">
            <LocateFixed size={15} />
            <span>Fit All</span>
          </button>
        </div>
      </div>
    </div>
  );
};
