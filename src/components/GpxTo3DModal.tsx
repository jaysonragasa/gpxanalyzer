import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  Box,
  Camera,
  Compass,
  Download,
  Mountain,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import { TrackPoint } from '../types/gpx';
import {
  BaseShape3D,
  buildTerrainSceneObjects,
  ColorTheme3D,
  computeTrackAspect,
  getTargetAspect,
  PlaquePosition3D,
  DemGridData,
  exportSceneToBinaryStl,
  fetchMap3DTerrainAndTextures,
  Terrain3DOptions,
  TrackStyle3D,
} from '../utils/terrain3d';

// Frees GPU resources (geometries, materials and their textures) of a group
function disposeGroup(group: THREE.Object3D) {
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      const mats: THREE.Material[] = Array.isArray(child.material)
        ? child.material
        : [child.material];
      for (const m of mats) {
        const map = (m as THREE.MeshStandardMaterial).map;
        if (map) map.dispose();
        m.dispose();
      }
    }
  });
}

// Delays a value so rapid slider drags / typing trigger one rebuild, not dozens
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

interface GpxTo3DModalProps {
  trackName: string;
  points: TrackPoint[];
  terrainElevations: Record<string, number>;
  onClose: () => void;
}

export const GpxTo3DModal: React.FC<GpxTo3DModalProps> = ({
  trackName,
  points,
  terrainElevations,
  onClose,
}) => {
  const [baseShape, setBaseShape] = useState<BaseShape3D>('rectangle');
  const [gridSize, setGridSize] = useState<number>(48);
  const [zExaggeration, setZExaggeration] = useState<number>(1.6);
  const [baseThicknessMm, setBaseThicknessMm] = useState<number>(6);
  const [trackWidthMm, setTrackWidthMm] = useState<number>(2.2);
  const [trackHeightMm, setTrackHeightMm] = useState<number>(1.8);
  const [trackStyle, setTrackStyle] = useState<TrackStyle3D>('tube');
  const [trackSmoothness, setTrackSmoothness] = useState<number>(0.7);
  const [showMarkers, setShowMarkers] = useState<boolean>(true);

  // Model footprint (map area) size
  const trackAspect = useMemo(() => computeTrackAspect(points), [points]);
  const [modelWidthMm, setModelWidthMm] = useState<number>(110);
  const [manualHeightMm, setManualHeightMm] = useState<number>(110);
  const [lockAspect, setLockAspect] = useState<boolean>(true);
  const isRoundBase = baseShape === 'circle' || baseShape === 'hexagon';
  const modelHeightMm = isRoundBase
    ? modelWidthMm
    : lockAspect
    ? Math.max(30, Math.min(300, Math.round(modelWidthMm / trackAspect)))
    : manualHeightMm;

  const [plaquePosition, setPlaquePosition] = useState<PlaquePosition3D>('bottom');

  // Keychain ring
  const [keychainEnabled, setKeychainEnabled] = useState<boolean>(false);
  const [keychainOuterDiameterMm, setKeychainOuterDiameterMm] = useState<number>(14);
  const [keychainHoleDiameterMm, setKeychainHoleDiameterMm] = useState<number>(6);
  const [keychainAngleDeg, setKeychainAngleDeg] = useState<number>(360);
  const [keychainThicknessMm, setKeychainThicknessMm] = useState<number>(3);

  // Auto-calculated Track Stats for Plaque
  const autoStats = useMemo(() => {
    let totalDistM = 0;
    let maxAlt = 0;
    let firstTime: string | undefined;
    let lastTime: string | undefined;

    for (let i = 0; i < points.length; i += 1) {
      const p = points[i];
      if (p.time && !firstTime) firstTime = p.time;
      if (p.time) lastTime = p.time;

      const alt = terrainElevations[p.id] !== undefined ? terrainElevations[p.id] : (p.ele ?? 0);
      if (alt > maxAlt) maxAlt = alt;

      if (i > 0) {
        const pPrev = points[i - 1];
        const dLat = (p.lat - pPrev.lat) * (Math.PI / 180);
        const dLon = (p.lon - pPrev.lon) * (Math.PI / 180);
        const lat1 = pPrev.lat * (Math.PI / 180);
        const lat2 = p.lat * (Math.PI / 180);
        const a =
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
        totalDistM += 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      }
    }

    let dateStr = '';
    if (firstTime) {
      const d = new Date(firstTime);
      if (!isNaN(d.getTime())) {
        const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
        dateStr = `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
      }
    }
    if (!dateStr) dateStr = new Date().toISOString().slice(0, 10);

    let durationStr = '01:00:00';
    if (firstTime && lastTime) {
      const sec = Math.max(0, Math.round((new Date(lastTime).getTime() - new Date(firstTime).getTime()) / 1000));
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      durationStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    const distStr = `${(totalDistM / 1000).toFixed(1)} KM`;
    const altStr = `${Math.round(maxAlt)} M`;

    return { dateStr, distStr, durationStr, altStr };
  }, [points, terrainElevations]);

  const [enablePlaqueTitle, setEnablePlaqueTitle] = useState<boolean>(true);
  const [titleText, setTitleText] = useState<string>(() =>
    trackName.replace(/[^a-zA-Z0-9\s.\-:]/g, '').toUpperCase().slice(0, 22)
  );
  const [showPlaqueStats, setShowPlaqueStats] = useState<boolean>(true);
  const [titleDateText, setTitleDateText] = useState<string>(() => autoStats.dateStr);
  const [titleDistanceText, setTitleDistanceText] = useState<string>(() => autoStats.distStr);
  const [titleDurationText, setTitleDurationText] = useState<string>(() => autoStats.durationStr);
  const [titleElevationText, setTitleElevationText] = useState<string>(() => autoStats.altStr);
  const [titleSizeMm, setTitleSizeMm] = useState<number>(6.5);
  const [theme, setTheme] = useState<ColorTheme3D>('satellite');
  const [customLowColor, setCustomLowColor] = useState('#2a703e');
  const [customHighColor, setCustomHighColor] = useState('#f5f7fa');
  const [customTrackColor, setCustomTrackColor] = useState('#fc4c02');
  const [customBaseColor, setCustomBaseColor] = useState('#1e293b');

  const [demGrid, setDemGrid] = useState<DemGridData | null>(null);
  const [satelliteCanvas, setSatelliteCanvas] = useState<HTMLCanvasElement | null>(null);
  const [topoCanvas, setTopoCanvas] = useState<HTMLCanvasElement | null>(null);
  const [isFetchingDem, setIsFetchingDem] = useState(false);

  const [modelStats, setModelStats] = useState({
    triangleCount: 0,
    widthMm: 110,
    lengthMm: 80,
    heightMm: 24,
  });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const currentDisplayGroupRef = useRef<THREE.Group | null>(null);
  const exportGroupRef = useRef<THREE.Group | null>(null);

  // The terrain/texture area must match the model aspect, so it is refetched
  // when the size or base shape changes (debounced; stale responses ignored)
  const mapAspect =
    Math.round(getTargetAspect({ baseShape, modelWidthMm, modelHeightMm }) * 100) / 100;
  const fetchKey = useDebouncedValue(`${mapAspect}|${isRoundBase}`, 600);
  const fetchSeqRef = useRef(0);

  const handleLoadMap3D = async () => {
    if (points.length < 2) return;
    const seq = ++fetchSeqRef.current;
    setIsFetchingDem(true);
    try {
      const bundle = await fetchMap3DTerrainAndTextures(points, mapAspect, isRoundBase);
      if (seq !== fetchSeqRef.current) return;
      setDemGrid(bundle.demGrid);
      setSatelliteCanvas(bundle.satelliteCanvas);
      setTopoCanvas(bundle.topoCanvas);
    } catch (err) {
      console.warn('3D terrain tile fetch warning:', err);
    } finally {
      if (seq === fetchSeqRef.current) setIsFetchingDem(false);
    }
  };

  useEffect(() => {
    void handleLoadMap3D();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, fetchKey]);

  const activeTextureCanvas = useMemo(() => {
    if (theme === 'satellite') return satelliteCanvas;
    if (theme === 'topo') return topoCanvas;
    return null;
  }, [theme, satelliteCanvas, topoCanvas]);

  const options: Terrain3DOptions = useMemo(
    () => ({
      baseShape,
      modelWidthMm,
      modelHeightMm,
      plaquePosition,
      keychainEnabled,
      keychainOuterDiameterMm,
      keychainHoleDiameterMm,
      keychainAngleDeg,
      keychainThicknessMm,
      gridSize,
      zExaggeration,
      baseThicknessMm,
      trackWidthMm,
      trackHeightMm,
      trackStyle,
      trackSmoothness,
      showMarkers,
      enablePlaqueTitle,
      titleText,
      titleDateText,
      titleDistanceText,
      titleDurationText,
      titleElevationText,
      showPlaqueStats,
      titleSizeMm,
      theme,
      customLowColor,
      customHighColor,
      customTrackColor,
      customBaseColor,
    }),
    [
      baseShape,
      modelWidthMm,
      modelHeightMm,
      plaquePosition,
      keychainEnabled,
      keychainOuterDiameterMm,
      keychainHoleDiameterMm,
      keychainAngleDeg,
      keychainThicknessMm,
      gridSize,
      zExaggeration,
      baseThicknessMm,
      trackWidthMm,
      trackHeightMm,
      trackStyle,
      trackSmoothness,
      showMarkers,
      enablePlaqueTitle,
      titleText,
      titleDateText,
      titleDistanceText,
      titleDurationText,
      titleElevationText,
      showPlaqueStats,
      titleSizeMm,
      theme,
      customLowColor,
      customHighColor,
      customTrackColor,
      customBaseColor,
    ]
  );

  const buildOptions = useDebouncedValue(options, 150);

  // Initialize Three.js WebGL Scene & OrbitControls
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const parent = canvas.parentElement;
    const width = parent?.clientWidth || 800;
    const height = parent?.clientHeight || 600;

    // 1. Scene
    const scene = new THREE.Scene();
    sceneRef.current = scene;

    // 2. Camera: Z is UP (CAD / GIS convention)
    const camera = new THREE.PerspectiveCamera(40, width / height, 1, 1000);
    camera.up.set(0, 0, 1);
    camera.position.set(-65, -165, 115);
    cameraRef.current = camera;

    // 3. Renderer with antialiasing and preserveDrawingBuffer for PNG export
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    rendererRef.current = renderer;

    // 4. OrbitControls: intuitive standard rotation (dragging left rotates camera around model)
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0, 12);
    controls.maxPolarAngle = Math.PI * 0.485; // Stay above ground plane
    controls.minDistance = 25;
    controls.maxDistance = 500;
    controlsRef.current = controls;

    // 5. Lighting: key directional sun light, soft fill, and ambient
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.72);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.35);
    dirLight.position.set(-70, -100, 140);
    dirLight.castShadow = true;
    // Default shadow frustum is +/-5 units; the model spans ~110-150 mm
    dirLight.shadow.camera.left = -110;
    dirLight.shadow.camera.right = 110;
    dirLight.shadow.camera.top = 110;
    dirLight.shadow.camera.bottom = -110;
    dirLight.shadow.camera.near = 1;
    dirLight.shadow.camera.far = 400;
    dirLight.shadow.mapSize.set(2048, 2048);
    dirLight.shadow.bias = -0.0005;
    scene.add(dirLight);

    const fillLight = new THREE.DirectionalLight(0x93c5fd, 0.45);
    fillLight.position.set(80, 90, 80);
    scene.add(fillLight);

    // Print bed grid: 180 x 180 mm (Bambu Lab A1 mini), 10 mm squares
    const gridHelper = new THREE.GridHelper(180, 18, 0x334155, 0x1e293b);
    gridHelper.rotation.x = Math.PI / 2;
    gridHelper.position.z = -0.1;
    scene.add(gridHelper);

    // Render loop
    let animId: number;
    const animate = () => {
      animId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // Resize observer
    const handleResize = () => {
      if (!canvas || !parent) return;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', handleResize);
      controls.dispose();
      if (currentDisplayGroupRef.current) {
        disposeGroup(currentDisplayGroupRef.current);
        currentDisplayGroupRef.current = null;
      }
      renderer.dispose();
      scene.clear();
    };
  }, []);

  // Rebuild 3D geometries whenever parameters or data change
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    // Remove previous display group
    if (currentDisplayGroupRef.current) {
      scene.remove(currentDisplayGroupRef.current);
      disposeGroup(currentDisplayGroupRef.current);
      currentDisplayGroupRef.current = null;
    }

    // Build new scene objects
    const bundle = buildTerrainSceneObjects(
      points,
      terrainElevations,
      demGrid,
      activeTextureCanvas,
      buildOptions
    );

    scene.add(bundle.displayGroup);
    currentDisplayGroupRef.current = bundle.displayGroup;
    exportGroupRef.current = bundle.exportGroup;
    setModelStats(bundle.stats);

    // Adjust orbit target to the center of the base height
    if (controlsRef.current) {
      controlsRef.current.target.set(0, 0, Math.min(20, bundle.stats.heightMm * 0.4));
    }
  }, [points, terrainElevations, demGrid, activeTextureCanvas, buildOptions]);

  // Preset Camera Views
  const setPresetView = (view: 'iso' | 'top' | 'front') => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;

    if (view === 'iso') {
      camera.position.set(-65, -165, 115);
      controls.target.set(0, 0, 12);
    } else if (view === 'top') {
      camera.position.set(0, -0.01, 210);
      controls.target.set(0, 0, 0);
    } else if (view === 'front') {
      camera.position.set(0, -210, 24);
      controls.target.set(0, 0, 12);
    }
    controls.update();
  };

  // Export to 3D Printable Binary STL
  const handleExportStl = () => {
    if (!exportGroupRef.current) return;
    const safeName =
      (titleText || trackName || 'gpx_3d_terrain')
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/_+/g, '_') || 'gpx_3d_terrain';

    const blob = exportSceneToBinaryStl(exportGroupRef.current, safeName);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}.stl`;
    a.click();
    // Revoking synchronously can cancel the download in some browsers
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // Export High-Res PNG Screenshot
  const handleExportPng = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `${trackName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'gpx_3d'}-view.png`;
    a.click();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="share-modal studio-3d-modal"
        style={{ maxWidth: '1180px' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="share-modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Box size={20} style={{ color: 'var(--accent)' }} />
            <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600 }}>
              GPX to 3D Terrain &amp; STL Studio
            </h3>
            <span
              className="merged-file-meta"
              style={{
                marginLeft: 10,
                backgroundColor: 'rgba(34, 197, 94, 0.15)',
                color: '#4ade80',
                border: '1px solid rgba(34, 197, 94, 0.3)',
                padding: '2px 8px',
                borderRadius: '12px',
                fontSize: '0.75rem',
              }}
            >
              {modelStats.triangleCount.toLocaleString()} Triangles • {modelStats.widthMm} ×{' '}
              {modelStats.lengthMm} × {modelStats.heightMm} mm (Watertight Solid)
            </span>
          </div>
          <button className="icon-btn-danger" onClick={onClose} title="Close Studio">
            <X size={18} />
          </button>
        </div>

        <div
          className="share-modal-body"
          style={{ gridTemplateColumns: '1fr 340px', minHeight: '620px', gap: 16 }}
        >
          {/* Left: Interactive 3D WebGL Canvas */}
          <div
            className="share-preview-pane"
            style={{
              position: 'relative',
              padding: 0,
              overflow: 'hidden',
              backgroundColor: '#090d16',
              borderRadius: '8px',
              border: '1px solid #1e293b',
              minHeight: '580px',
            }}
          >
            <canvas
              ref={canvasRef}
              style={{
                width: '100%',
                height: '100%',
                display: 'block',
                cursor: 'grab',
              }}
            />

            {/* Top-Left: Map 3D Terrain Data Status & Tile Fetch */}
            <div
              style={{
                position: 'absolute',
                top: 12,
                left: 12,
                display: 'flex',
                gap: 8,
                flexWrap: 'wrap',
                zIndex: 10,
              }}
            >
              <button
                className="btn-secondary-sm"
                onClick={handleLoadMap3D}
                disabled={isFetchingDem}
                style={
                  demGrid && satelliteCanvas
                    ? {
                        backgroundColor: 'rgba(34, 197, 94, 0.18)',
                        borderColor: '#22c55e',
                        color: '#4ade80',
                      }
                    : { backgroundColor: 'rgba(15, 23, 42, 0.75)' }
                }
                title="Reload Map 3D Depth Map (Terrarium DEM) &amp; Satellite Textures"
              >
                <Mountain size={13} />
                <span>
                  {isFetchingDem
                    ? 'Loading DEM & Tiles...'
                    : demGrid
                    ? '3D Terrain Loaded'
                    : 'Fetch 3D Depth Map'}
                </span>
              </button>

              {demGrid && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    fontSize: '0.74rem',
                    color: '#94a3b8',
                    backgroundColor: 'rgba(15, 23, 42, 0.75)',
                    padding: '3px 8px',
                    borderRadius: '6px',
                    backdropFilter: 'blur(4px)',
                    border: '1px solid #334155',
                  }}
                >
                  <Sparkles size={11} style={{ color: '#38bdf8' }} />
                  <span>DEM: {demGrid.rows}×{demGrid.cols}</span>
                </div>
              )}
            </div>

            {/* Top-Right: Camera Presets (Isometric, Top, Front, Reset) */}
            <div
              style={{
                position: 'absolute',
                top: 12,
                right: 12,
                display: 'flex',
                gap: 6,
                zIndex: 10,
                backgroundColor: 'rgba(15, 23, 42, 0.8)',
                padding: '4px',
                borderRadius: '8px',
                border: '1px solid #334155',
                backdropFilter: 'blur(6px)',
              }}
            >
              <button
                className="btn-secondary-sm"
                style={{ padding: '3px 7px', fontSize: '0.72rem' }}
                onClick={() => setPresetView('iso')}
                title="Isometric 3D View"
              >
                <Compass size={12} />
                <span>3D Iso</span>
              </button>
              <button
                className="btn-secondary-sm"
                style={{ padding: '3px 7px', fontSize: '0.72rem' }}
                onClick={() => setPresetView('top')}
                title="Top-Down Bird's Eye View"
              >
                <span>Top</span>
              </button>
              <button
                className="btn-secondary-sm"
                style={{ padding: '3px 7px', fontSize: '0.72rem' }}
                onClick={() => setPresetView('front')}
                title="Front Title View"
              >
                <span>Front</span>
              </button>
              <button
                className="btn-secondary-sm"
                style={{ padding: '3px 7px', fontSize: '0.72rem' }}
                onClick={() => setPresetView('iso')}
                title="Reset Camera Orientation"
              >
                <RotateCcw size={12} />
              </button>
            </div>

            {/* Bottom-Left: Mouse Interaction Hint */}
            <div
              style={{
                position: 'absolute',
                bottom: 12,
                left: 12,
                fontSize: '0.72rem',
                color: '#64748b',
                backgroundColor: 'rgba(15, 23, 42, 0.7)',
                padding: '4px 8px',
                borderRadius: '6px',
                backdropFilter: 'blur(4px)',
                pointerEvents: 'none',
              }}
            >
              <span>Left Drag: Orbit • Right Drag: Pan • Wheel: Zoom</span>
            </div>
          </div>

          {/* Right: Controls & STL Export Configuration */}
          <div
            className="share-controls-pane"
            style={{
              maxHeight: '620px',
              overflowY: 'auto',
              paddingRight: 6,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            {/* Base Shape Selector */}
            <div className="share-control-group">
              <label>Pedestal Base Shape</label>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, 1fr)',
                  gap: 6,
                  marginTop: 4,
                }}
              >
                {(['rectangle', 'circle', 'hexagon', 'ribbon'] as BaseShape3D[]).map((shape) => (
                  <button
                    key={shape}
                    className={`btn-secondary-sm ${baseShape === shape ? 'btn-active' : ''}`}
                    style={{
                      textTransform: 'capitalize',
                      padding: '5px 2px',
                      justifyContent: 'center',
                      fontSize: '0.76rem',
                    }}
                    onClick={() => setBaseShape(shape)}
                  >
                    {shape}
                  </button>
                ))}
              </div>
            </div>

            {/* Model Size */}
            <div className="share-control-group">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label>Model Size (Map Area)</label>
                {!isRoundBase && (
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      fontSize: '0.72rem',
                      color: '#94a3b8',
                      cursor: 'pointer',
                      margin: 0,
                    }}
                    title="Keep the height proportional to the track's shape"
                  >
                    <input
                      type="checkbox"
                      checked={lockAspect}
                      onChange={(e) => {
                        if (!e.target.checked) setManualHeightMm(modelHeightMm);
                        setLockAspect(e.target.checked);
                      }}
                      style={{ cursor: 'pointer', accentColor: '#38bdf8' }}
                    />
                    Fit to track
                  </label>
                )}
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginTop: 4,
                }}
              >
                <span style={{ fontSize: '0.74rem', color: '#94a3b8' }}>
                  {isRoundBase ? 'Diameter' : 'Width'}
                </span>
                <span className="slider-val">{modelWidthMm} mm</span>
              </div>
              <input
                type="range"
                min={30}
                max={250}
                step={5}
                value={modelWidthMm}
                onChange={(e) => setModelWidthMm(parseInt(e.target.value, 10))}
              />
              {!isRoundBase && (
                <>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginTop: 4,
                    }}
                  >
                    <span style={{ fontSize: '0.74rem', color: '#94a3b8' }}>Height</span>
                    <span className="slider-val">{modelHeightMm} mm</span>
                  </div>
                  <input
                    type="range"
                    min={30}
                    max={250}
                    step={5}
                    value={modelHeightMm}
                    disabled={lockAspect}
                    onChange={(e) => setManualHeightMm(parseInt(e.target.value, 10))}
                  />
                </>
              )}
            </div>

            {/* Theme Selector */}
            <div className="share-control-group">
              <label>Visual Color Theme &amp; Texture</label>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: 5,
                  marginTop: 4,
                }}
              >
                {[
                  { id: 'satellite', label: '🛰️ Satellite' },
                  { id: 'topo', label: '🗺️ Topo Map' },
                  { id: 'alpine', label: '🌲 Alpine' },
                  { id: 'volcanic', label: '🌋 Volcanic' },
                  { id: 'glacier', label: '❄️ Glacier' },
                  { id: 'pla', label: '🖨️ 3D Print White' },
                  { id: 'custom', label: '🎨 Custom' },
                ].map((th) => (
                  <button
                    key={th.id}
                    className={`btn-secondary-sm ${theme === th.id ? 'btn-active' : ''}`}
                    style={{
                      padding: '5px 4px',
                      fontSize: '0.74rem',
                      justifyContent: 'center',
                    }}
                    onClick={() => setTheme(th.id as ColorTheme3D)}
                  >
                    {th.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Custom Theme Pickers */}
            {theme === 'custom' && (
              <div
                style={{
                  backgroundColor: '#0f172a',
                  border: '1px solid #1e293b',
                  borderRadius: '6px',
                  padding: '8px',
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 8,
                }}
              >
                <label style={{ fontSize: '0.74rem' }}>
                  Valley Color
                  <input
                    type="color"
                    value={customLowColor}
                    onChange={(e) => setCustomLowColor(e.target.value)}
                    style={{ display: 'block', width: '100%', height: '24px', marginTop: 2 }}
                  />
                </label>
                <label style={{ fontSize: '0.74rem' }}>
                  Peak Color
                  <input
                    type="color"
                    value={customHighColor}
                    onChange={(e) => setCustomHighColor(e.target.value)}
                    style={{ display: 'block', width: '100%', height: '24px', marginTop: 2 }}
                  />
                </label>
                <label style={{ fontSize: '0.74rem' }}>
                  Track Color
                  <input
                    type="color"
                    value={customTrackColor}
                    onChange={(e) => setCustomTrackColor(e.target.value)}
                    style={{ display: 'block', width: '100%', height: '24px', marginTop: 2 }}
                  />
                </label>
                <label style={{ fontSize: '0.74rem' }}>
                  Base Color
                  <input
                    type="color"
                    value={customBaseColor}
                    onChange={(e) => setCustomBaseColor(e.target.value)}
                    style={{ display: 'block', width: '100%', height: '24px', marginTop: 2 }}
                  />
                </label>
              </div>
            )}

            {/* Relief / Elevation Exaggeration */}
            <div className="share-control-group">
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <label>Terrain Relief Exaggeration</label>
                <span className="slider-val">{zExaggeration.toFixed(1)}x</span>
              </div>
              <input
                type="range"
                min={0.5}
                max={3.2}
                step={0.1}
                value={zExaggeration}
                onChange={(e) => setZExaggeration(parseFloat(e.target.value))}
              />
            </div>

            {/* Base Thickness */}
            <div className="share-control-group">
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <label>Base Thickness (Pedestal)</label>
                <span className="slider-val">{baseThicknessMm} mm</span>
              </div>
              <input
                type="range"
                min={3}
                max={18}
                step={1}
                value={baseThicknessMm}
                onChange={(e) => setBaseThicknessMm(parseInt(e.target.value, 10))}
              />
            </div>

            {/* Track 3D Style & Smoothing */}
            <div className="share-control-group">
              <label>Track 3D Style &amp; Smoothing</label>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 6,
                  marginTop: 4,
                }}
              >
                <button
                  className={`btn-secondary-sm ${trackStyle === 'tube' ? 'btn-active' : ''}`}
                  style={{
                    padding: '6px 4px',
                    fontSize: '0.75rem',
                    justifyContent: 'center',
                    fontWeight: trackStyle === 'tube' ? 600 : 400,
                  }}
                  onClick={() => setTrackStyle('tube')}
                  title="Rounded-top track that sits flat on the terrain: no overhangs when printed"
                >
                  Smooth 3D Tube
                </button>
                <button
                  className={`btn-secondary-sm ${trackStyle === 'ribbon' ? 'btn-active' : ''}`}
                  style={{
                    padding: '6px 4px',
                    fontSize: '0.75rem',
                    justifyContent: 'center',
                    fontWeight: trackStyle === 'ribbon' ? 600 : 400,
                  }}
                  onClick={() => setTrackStyle('ribbon')}
                  title="Beveled flat-top ribbon"
                >
                  Beveled Ribbon
                </button>
              </div>

              {/* Spline Smoothing Slider */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginTop: 8,
                }}
              >
                <span style={{ fontSize: '0.74rem', color: '#94a3b8' }}>
                  Curve Smoothing Filter
                </span>
                <span className="slider-val">
                  {Math.round(trackSmoothness * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0.0}
                max={1.0}
                step={0.05}
                value={trackSmoothness}
                onChange={(e) => setTrackSmoothness(parseFloat(e.target.value))}
              />

              {/* Start & Finish Trophy Markers Toggle */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginTop: 6,
                }}
              >
                <span style={{ fontSize: '0.74rem', color: '#94a3b8' }}>
                  Start (Green) &amp; Finish (Red) Markers
                </span>
                <button
                  className={`btn-secondary-sm ${showMarkers ? 'btn-active' : ''}`}
                  style={{ padding: '2px 8px', fontSize: '0.72rem' }}
                  onClick={() => setShowMarkers((m) => !m)}
                >
                  {showMarkers ? 'Markers ON' : 'Markers OFF'}
                </button>
              </div>
            </div>

            {/* Track Width & Height */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 10,
              }}
            >
              <div className="share-control-group">
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <label>Track Width</label>
                  <span className="slider-val">{trackWidthMm.toFixed(1)} mm</span>
                </div>
                <input
                  type="range"
                  min={1.0}
                  max={4.5}
                  step={0.2}
                  value={trackWidthMm}
                  onChange={(e) => setTrackWidthMm(parseFloat(e.target.value))}
                />
              </div>
              <div className="share-control-group">
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <label>Track Height</label>
                  <span className="slider-val">{trackHeightMm.toFixed(1)} mm</span>
                </div>
                <input
                  type="range"
                  min={0.8}
                  max={4.0}
                  step={0.2}
                  value={trackHeightMm}
                  onChange={(e) => setTrackHeightMm(parseFloat(e.target.value))}
                />
              </div>
            </div>

            {/* 3D Base Trophy Plaque & Multi-line Stats */}
            {baseShape !== 'ribbon' && (
              <div className="share-control-group">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontWeight: 600, margin: 0 }}>
                    <input
                      type="checkbox"
                      checked={enablePlaqueTitle}
                      onChange={(e) => setEnablePlaqueTitle(e.target.checked)}
                      style={{ cursor: 'pointer', width: 15, height: 15, accentColor: '#38bdf8' }}
                    />
                    <span>3D Embossed Plaque Title</span>
                  </label>
                  {enablePlaqueTitle && (
                    <button
                      className={`btn-secondary-sm ${showPlaqueStats ? 'btn-active' : ''}`}
                      style={{ padding: '2px 8px', fontSize: '0.72rem' }}
                      onClick={() => setShowPlaqueStats((s) => !s)}
                      title="Toggle Date, Distance, Duration, and Max Altitude on the base"
                    >
                      {showPlaqueStats ? 'Trophy Stats ON' : 'Title Only'}
                    </button>
                  )}
                </div>

                {enablePlaqueTitle ? (
                  <>
                    {/* Plaque Position */}
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(4, 1fr)',
                        gap: 6,
                        marginTop: 6,
                      }}
                    >
                      {(['bottom', 'top', 'left', 'right'] as PlaquePosition3D[]).map((pos) => (
                        <button
                          key={pos}
                          className={`btn-secondary-sm ${plaquePosition === pos ? 'btn-active' : ''}`}
                          style={{
                            textTransform: 'capitalize',
                            padding: '4px 2px',
                            justifyContent: 'center',
                            fontSize: '0.74rem',
                          }}
                          onClick={() => setPlaquePosition(pos)}
                          title={
                            pos === 'left' || pos === 'right'
                              ? 'Side plaque: text runs along the edge'
                              : `Plaque on the ${pos} edge`
                          }
                        >
                          {pos}
                        </button>
                      ))}
                    </div>

                    {/* Title Line */}
                    <input
                      type="text"
                      className="input-text"
                      placeholder="ROUTE / SUMMIT NAME"
                      value={titleText}
                      maxLength={26}
                      onChange={(e) => setTitleText(e.target.value.toUpperCase())}
                      style={{ marginTop: 6, width: '100%', fontSize: '0.82rem' }}
                    />

                    {showPlaqueStats && (
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '1fr 1fr',
                          gap: 6,
                          marginTop: 6,
                          backgroundColor: '#0f172a',
                          padding: '8px',
                          borderRadius: '6px',
                          border: '1px solid #1e293b',
                        }}
                      >
                        <div>
                          <span style={{ fontSize: '0.70rem', color: '#94a3b8', display: 'block' }}>Date</span>
                          <input
                            type="text"
                            className="input-text"
                            value={titleDateText}
                            maxLength={16}
                            onChange={(e) => setTitleDateText(e.target.value.toUpperCase())}
                            style={{ width: '100%', fontSize: '0.74rem', padding: '3px 6px' }}
                          />
                        </div>
                        <div>
                          <span style={{ fontSize: '0.70rem', color: '#94a3b8', display: 'block' }}>Distance</span>
                          <input
                            type="text"
                            className="input-text"
                            value={titleDistanceText}
                            maxLength={12}
                            onChange={(e) => setTitleDistanceText(e.target.value.toUpperCase())}
                            style={{ width: '100%', fontSize: '0.74rem', padding: '3px 6px' }}
                          />
                        </div>
                        <div>
                          <span style={{ fontSize: '0.70rem', color: '#94a3b8', display: 'block' }}>Duration</span>
                          <input
                            type="text"
                            className="input-text"
                            value={titleDurationText}
                            maxLength={12}
                            onChange={(e) => setTitleDurationText(e.target.value.toUpperCase())}
                            style={{ width: '100%', fontSize: '0.74rem', padding: '3px 6px' }}
                          />
                        </div>
                        <div>
                          <span style={{ fontSize: '0.70rem', color: '#94a3b8', display: 'block' }}>Max Altitude</span>
                          <input
                            type="text"
                            className="input-text"
                            value={titleElevationText}
                            maxLength={10}
                            onChange={(e) => setTitleElevationText(e.target.value.toUpperCase())}
                            style={{ width: '100%', fontSize: '0.74rem', padding: '3px 6px' }}
                          />
                        </div>
                      </div>
                    )}

                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginTop: 6,
                      }}
                    >
                      <span style={{ fontSize: '0.74rem', color: '#94a3b8' }}>Letter Size</span>
                      <span className="slider-val">{titleSizeMm.toFixed(1)} mm</span>
                    </div>
                    <input
                      type="range"
                      min={4.5}
                      max={9.0}
                      step={0.5}
                      value={titleSizeMm}
                      onChange={(e) => setTitleSizeMm(parseFloat(e.target.value))}
                    />
                  </>
                ) : (
                  <div style={{ fontSize: '0.74rem', color: '#64748b', marginTop: 4, fontStyle: 'italic' }}>
                    Plaque title disabled — full terrain relief extends across the entire base.
                  </div>
                )}
              </div>
            )}

            {/* Keychain Ring */}
            <div className="share-control-group">
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  cursor: 'pointer',
                  fontWeight: 600,
                  margin: 0,
                }}
              >
                <input
                  type="checkbox"
                  checked={keychainEnabled}
                  onChange={(e) => setKeychainEnabled(e.target.checked)}
                  style={{ cursor: 'pointer', width: 15, height: 15, accentColor: '#38bdf8' }}
                />
                <span>Keychain Ring</span>
              </label>
              {keychainEnabled && (
                <>
                  {(
                    [
                      {
                        label: 'Ring Size (outer Ø)',
                        value: keychainOuterDiameterMm,
                        min: 8,
                        max: 30,
                        step: 1,
                        unit: 'mm',
                        set: (v: number) => {
                          setKeychainOuterDiameterMm(v);
                          setKeychainHoleDiameterMm((h) => Math.min(h, v - 3));
                        },
                      },
                      {
                        label: 'Hole Size (inner Ø)',
                        value: keychainHoleDiameterMm,
                        min: 2,
                        max: keychainOuterDiameterMm - 3,
                        step: 0.5,
                        unit: 'mm',
                        set: setKeychainHoleDiameterMm,
                      },
                      {
                        label: 'Thickness',
                        value: keychainThicknessMm,
                        min: 1.5,
                        max: 10,
                        step: 0.5,
                        unit: 'mm',
                        set: setKeychainThicknessMm,
                      },
                      {
                        label: 'Position (0° = top, clockwise)',
                        value: keychainAngleDeg,
                        min: 1,
                        max: 360,
                        step: 1,
                        unit: '°',
                        set: setKeychainAngleDeg,
                      },
                    ] as const
                  ).map((s) => (
                    <div key={s.label}>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginTop: 6,
                        }}
                      >
                        <span style={{ fontSize: '0.74rem', color: '#94a3b8' }}>{s.label}</span>
                        <span className="slider-val">
                          {s.value}
                          {s.unit === '°' ? '°' : ` ${s.unit}`}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={s.min}
                        max={s.max}
                        step={s.step}
                        value={s.value}
                        onChange={(e) => s.set(parseFloat(e.target.value))}
                      />
                    </div>
                  ))}
                </>
              )}
            </div>

            {/* Grid Quality */}
            <div className="share-control-group">
              <label>Mesh Resolution</label>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: 6,
                  marginTop: 4,
                }}
              >
                {[
                  { label: 'Fast (36)', size: 36 },
                  { label: 'Standard (48)', size: 48 },
                  { label: 'High (64)', size: 64 },
                ].map((g) => (
                  <button
                    key={g.size}
                    className={`btn-secondary-sm ${gridSize === g.size ? 'btn-active' : ''}`}
                    style={{ fontSize: '0.74rem', padding: '4px 2px', justifyContent: 'center' }}
                    onClick={() => setGridSize(g.size)}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Action Buttons: STL & PNG Export */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                marginTop: 'auto',
                paddingTop: 10,
              }}
            >
              <button
                className="btn-primary"
                onClick={handleExportStl}
                style={{
                  padding: '9px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  fontSize: '0.88rem',
                  fontWeight: 600,
                }}
              >
                <Download size={16} />
                <span>Export 3D Printable STL</span>
              </button>

              <button
                className="btn-secondary"
                onClick={handleExportPng}
                style={{
                  padding: '7px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  fontSize: '0.82rem',
                }}
              >
                <Camera size={15} />
                <span>Save 3D Snapshot (PNG)</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
