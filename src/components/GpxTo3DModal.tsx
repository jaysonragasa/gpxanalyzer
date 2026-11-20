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
  DemGridData,
  exportSceneToBinaryStl,
  fetchMap3DTerrainAndTextures,
  Terrain3DOptions,
  TrackStyle3D,
} from '../utils/terrain3d';

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
  const [titleText, setTitleText] = useState<string>(() =>
    trackName.replace(/[^a-zA-Z0-9\s.\-:]/g, '').toUpperCase().slice(0, 22)
  );
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

  const handleLoadMap3D = async () => {
    if (points.length < 2) return;
    setIsFetchingDem(true);
    try {
      const bundle = await fetchMap3DTerrainAndTextures(points);
      setDemGrid(bundle.demGrid);
      if (bundle.satelliteCanvas) setSatelliteCanvas(bundle.satelliteCanvas);
      if (bundle.topoCanvas) setTopoCanvas(bundle.topoCanvas);
    } catch (err) {
      console.warn('3D terrain tile fetch warning:', err);
    } finally {
      setIsFetchingDem(false);
    }
  };

  // Automatically load Map 3D Terrain Depth & Satellite Texture on mount
  useEffect(() => {
    void handleLoadMap3D();
  }, []);

  const activeTextureCanvas = useMemo(() => {
    if (theme === 'satellite') return satelliteCanvas;
    if (theme === 'topo') return topoCanvas;
    return null;
  }, [theme, satelliteCanvas, topoCanvas]);

  const options: Terrain3DOptions = useMemo(
    () => ({
      baseShape,
      gridSize,
      zExaggeration,
      baseThicknessMm,
      trackWidthMm,
      trackHeightMm,
      trackStyle,
      trackSmoothness,
      showMarkers,
      titleText,
      titleSizeMm,
      theme,
      customLowColor,
      customHighColor,
      customTrackColor,
      customBaseColor,
    }),
    [
      baseShape,
      gridSize,
      zExaggeration,
      baseThicknessMm,
      trackWidthMm,
      trackHeightMm,
      trackStyle,
      trackSmoothness,
      showMarkers,
      titleText,
      titleSizeMm,
      theme,
      customLowColor,
      customHighColor,
      customTrackColor,
      customBaseColor,
    ]
  );

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
    scene.add(dirLight);

    const fillLight = new THREE.DirectionalLight(0x93c5fd, 0.45);
    fillLight.position.set(80, 90, 80);
    scene.add(fillLight);

    // Subtle floor shadow grid helper
    const gridHelper = new THREE.GridHelper(240, 24, 0x334155, 0x1e293b);
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
      currentDisplayGroupRef.current.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (Array.isArray(child.material)) {
            child.material.forEach((m) => m.dispose());
          } else {
            child.material.dispose();
          }
        }
      });
      currentDisplayGroupRef.current = null;
    }

    // Build new scene objects
    const bundle = buildTerrainSceneObjects(
      points,
      terrainElevations,
      demGrid,
      activeTextureCanvas,
      options
    );

    scene.add(bundle.displayGroup);
    currentDisplayGroupRef.current = bundle.displayGroup;
    exportGroupRef.current = bundle.exportGroup;
    setModelStats(bundle.stats);

    // Adjust orbit target to the center of the base height
    if (controlsRef.current) {
      controlsRef.current.target.set(0, 0, Math.min(20, bundle.stats.heightMm * 0.4));
    }
  }, [points, terrainElevations, demGrid, activeTextureCanvas, options]);

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
    URL.revokeObjectURL(url);
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
        className="share-modal"
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
                  title="Smooth rounded 3D pipe: zero self-intersections, ideal for 3D printing"
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
                  Start (Green) &amp; Finish (Red) Pins
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

            {/* 3D Embossed Title Plaque */}
            <div className="share-control-group">
              <label>3D Embossed Plaque Title</label>
              <input
                type="text"
                className="input-text"
                placeholder="ROUTE / SUMMIT NAME"
                value={titleText}
                maxLength={24}
                onChange={(e) => setTitleText(e.target.value.toUpperCase())}
                style={{ marginTop: 4, width: '100%', fontSize: '0.82rem' }}
              />
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
                max={10.0}
                step={0.5}
                value={titleSizeMm}
                onChange={(e) => setTitleSizeMm(parseFloat(e.target.value))}
              />
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
