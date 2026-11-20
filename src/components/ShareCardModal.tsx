import React, { useEffect, useRef, useState } from 'react';
import { Download, ImagePlus, X } from 'lucide-react';
import { ArchiveActivity } from '../utils/stravaArchive';
import { formatDuration } from '../utils/gpxParser';

interface ShareCardModalProps {
  activities: ArchiveActivity[];
  dateRangeLabel: string;
  totalDistanceM: number;
  totalElevGainM: number;
  totalDurationSec: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  maxElevationM: number | null;
  maxHeartRate: number | null;
  maxPower: number | null;
  onClose: () => void;
}

type AspectPreset = 'story' | 'portrait' | 'square';
type BgPreset = 'strava-dark' | 'black' | 'slate' | 'sunset' | 'emerald' | 'custom';

const ASPECT_DIMS: Record<AspectPreset, { w: number; h: number; label: string }> = {
  story: { w: 1080, h: 1920, label: '9:16 Story' },
  portrait: { w: 1080, h: 1350, label: '4:5 Portrait' },
  square: { w: 1080, h: 1080, label: '1:1 Square' },
};

export const ShareCardModal: React.FC<ShareCardModalProps> = ({
  activities,
  dateRangeLabel,
  totalDistanceM,
  totalElevGainM,
  totalDurationSec,
  avgSpeedKmh,
  maxSpeedKmh,
  maxElevationM,
  maxHeartRate,
  maxPower,
  onClose,
}) => {
  const [aspect, setAspect] = useState<AspectPreset>('story');
  const [bgPreset, setBgPreset] = useState<BgPreset>('strava-dark');
  const [customColor, setCustomColor] = useState('#1e293b');
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
  const [overlayOpacity, setOverlayOpacity] = useState(0.55);
  const [footerText, setFooterText] = useState('STRAVA ARCHIVE');
  const [footerColor, setFooterColor] = useState('#ffffff');
  const [footerSize, setFooterSize] = useState(42);
  const [headerText, setHeaderText] = useState(
    `${activities.length} ${activities.length === 1 ? 'Activity' : 'Activities'} • ${dateRangeLabel}`
  );
  const [showDateRange, setShowDateRange] = useState(true);
  const [routeColor, setRouteColor] = useState('#fc4c02');

  const [showDistance, setShowDistance] = useState(true);
  const [showMaxElev, setShowMaxElev] = useState(true);
  const [showTime, setShowTime] = useState(true);
  const [showMaxSpeed, setShowMaxSpeed] = useState(true);
  const [showAvgSpeed, setShowAvgSpeed] = useState(true);
  const [showElevGain, setShowElevGain] = useState(false);
  const [showMaxHr, setShowMaxHr] = useState(maxHeartRate !== null);
  const [showMaxPower, setShowMaxPower] = useState(maxPower !== null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bgInputRef = useRef<HTMLInputElement | null>(null);

  const handleUploadBg = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setBgImage(img);
      URL.revokeObjectURL(url);
    };
    img.src = url;
    e.target.value = '';
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { w, h } = ASPECT_DIMS[aspect];
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 1. Background
    if (bgImage) {
      const scale = Math.max(w / bgImage.width, h / bgImage.height);
      const dw = bgImage.width * scale;
      const dh = bgImage.height * scale;
      ctx.drawImage(bgImage, (w - dw) / 2, (h - dh) / 2, dw, dh);
      ctx.fillStyle = `rgba(0, 0, 0, ${overlayOpacity})`;
      ctx.fillRect(0, 0, w, h);
    } else if (bgPreset === 'strava-dark') {
      ctx.fillStyle = '#262626';
      ctx.fillRect(0, 0, w, h);
    } else if (bgPreset === 'black') {
      ctx.fillStyle = '#09090b';
      ctx.fillRect(0, 0, w, h);
    } else if (bgPreset === 'slate') {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, w, h);
    } else if (bgPreset === 'sunset') {
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#3b0764');
      grad.addColorStop(0.55, '#7c2d12');
      grad.addColorStop(1, '#18181b');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    } else if (bgPreset === 'emerald') {
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#064e3b');
      grad.addColorStop(1, '#09090b');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.fillStyle = customColor;
      ctx.fillRect(0, 0, w, h);
    }

    const isStory = aspect === 'story';
    const centerX = w / 2;
    let y = isStory ? h * 0.22 : aspect === 'portrait' ? h * 0.14 : h * 0.12;

    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';

    if (showDateRange && headerText.trim()) {
      ctx.font = '600 28px Inter, -apple-system, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.68)';
      ctx.fillText(headerText.trim(), centerX, y - 54);
    }

    const drawStat = (label: string, value: string, gap = 115) => {
      ctx.font = '600 30px Inter, -apple-system, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(label, centerX, y);
      y += 66;
      ctx.font = '800 66px Inter, -apple-system, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(value, centerX, y);
      y += gap;
    };

    const distKm = `${(totalDistanceM / 1000).toFixed(2)} km`;
    const maxElevStr =
      maxElevationM !== null ? `${Math.round(maxElevationM).toLocaleString()} m` : '—';
    const timeStr = formatDuration(totalDurationSec);

    if (showDistance) drawStat('Distance', distKm, isStory ? 88 : 68);
    if (showMaxElev) drawStat('Max Elev', maxElevStr, isStory ? 88 : 68);
    if (showTime) drawStat('Time', timeStr, isStory ? 90 : 70);

    const secondaryStats: Array<{ label: string; value: string }> = [];
    if (showMaxSpeed) {
      secondaryStats.push({ label: 'Max Speed', value: `${maxSpeedKmh.toFixed(1)} km/h` });
    }
    if (showAvgSpeed) {
      secondaryStats.push({ label: 'Ave. Speed', value: `${avgSpeedKmh.toFixed(1)} km/h` });
    }
    if (showElevGain) {
      secondaryStats.push({
        label: 'Elev Gain',
        value: `${Math.round(totalElevGainM).toLocaleString()} m`,
      });
    }
    if (showMaxHr) {
      secondaryStats.push({
        label: 'Max Heart Rate',
        value: maxHeartRate !== null ? `${Math.round(maxHeartRate)} bpm` : '—',
      });
    }
    if (showMaxPower) {
      secondaryStats.push({
        label: 'Max Power',
        value: maxPower !== null ? `${Math.round(maxPower)} W` : '—',
      });
    }

    const colOffset = 215;
    for (let i = 0; i < secondaryStats.length; i += 2) {
      const left = secondaryStats[i];
      const right = secondaryStats[i + 1];
      ctx.font = '600 25px Inter, -apple-system, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.78)';
      if (right) {
        ctx.fillText(left.label, centerX - colOffset, y);
        ctx.fillText(right.label, centerX + colOffset, y);
      } else {
        ctx.fillText(left.label, centerX, y);
      }
      y += 50;
      ctx.font = '800 44px Inter, -apple-system, sans-serif';
      ctx.fillStyle = '#ffffff';
      if (right) {
        ctx.fillText(left.value, centerX - colOffset, y);
        ctx.fillText(right.value, centerX + colOffset, y);
      } else {
        ctx.fillText(left.value, centerX, y);
      }
      y += isStory ? 74 : 58;
    }

    // Route Silhouette
    const routeBoxTop = y + (isStory ? 40 : 28);
    const routeBoxBottom = h - (isStory ? 240 : 145);
    const routeBoxH = Math.max(140, routeBoxBottom - routeBoxTop);
    const routeBoxW = w * 0.62;

    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    for (const act of activities) {
      for (const p of act.points) {
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
        if (p.lon < minLon) minLon = p.lon;
        if (p.lon > maxLon) maxLon = p.lon;
      }
    }

    if (Number.isFinite(minLat) && Number.isFinite(minLon)) {
      const midLatRad = (((minLat + maxLat) / 2) * Math.PI) / 180;
      const cosLat = Math.max(0.2, Math.cos(midLatRad));
      const spanLon = Math.max(1e-5, (maxLon - minLon) * cosLat);
      const spanLat = Math.max(1e-5, maxLat - minLat);
      const scale = Math.min(routeBoxW / spanLon, routeBoxH / spanLat);
      const drawW = spanLon * scale;
      const drawH = spanLat * scale;
      const offsetX = centerX - drawW / 2;
      const offsetY = routeBoxTop + (routeBoxH - drawH) / 2;

      ctx.strokeStyle = routeColor;
      ctx.lineWidth = activities.length > 20 ? 5 : 9;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (const act of activities) {
        if (act.points.length < 2) continue;
        ctx.beginPath();
        act.points.forEach((p, idx) => {
          const px = offsetX + (p.lon - minLon) * cosLat * scale;
          const py = offsetY + (maxLat - p.lat) * scale;
          if (idx === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
      }
    }

    // Footer text
    if (footerText.trim()) {
      ctx.font = `800 ${footerSize}px Inter, -apple-system, sans-serif`;
      ctx.fillStyle = footerColor;
      ctx.fillText(footerText.trim(), centerX, h - (isStory ? 130 : 65));
    }
  }, [
    activities,
    aspect,
    bgPreset,
    customColor,
    bgImage,
    overlayOpacity,
    footerText,
    footerColor,
    footerSize,
    headerText,
    showDateRange,
    routeColor,
    dateRangeLabel,
    totalDistanceM,
    totalElevGainM,
    totalDurationSec,
    avgSpeedKmh,
    maxSpeedKmh,
    maxElevationM,
    maxHeartRate,
    maxPower,
    showDistance,
    showMaxElev,
    showTime,
    showMaxSpeed,
    showAvgSpeed,
    showElevGain,
    showMaxHr,
    showMaxPower,
  ]);

  const handleDownloadJpg = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const url = canvas.toDataURL('image/jpeg', 0.95);
    const a = document.createElement('a');
    a.href = url;
    a.download = `strava-summary-${aspect}.jpg`;
    a.click();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="share-modal" onClick={(e) => e.stopPropagation()}>
        <div className="share-modal-header">
          <h3>Export Strava Summary Card (JPG)</h3>
          <button className="icon-btn-danger" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="share-modal-body">
          <div className="share-preview-pane">
            <canvas ref={canvasRef} className="share-canvas-preview" />
          </div>

          <div className="share-controls-pane">
            <label className="field">
              <span>Aspect Ratio</span>
              <div className="shift-btn-row" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                {(Object.keys(ASPECT_DIMS) as AspectPreset[]).map((key) => (
                  <button
                    key={key}
                    className={`btn-secondary-sm ${aspect === key ? 'active-blue' : ''}`}
                    onClick={() => setAspect(key)}
                  >
                    {ASPECT_DIMS[key].label}
                  </button>
                ))}
              </div>
            </label>

            <label className="field">
              <span>Background Style</span>
              <div className="bg-swatches">
                {(
                  [
                    ['strava-dark', '#262626', 'Strava Dark'],
                    ['black', '#09090b', 'Pure Black'],
                    ['slate', '#0f172a', 'Midnight'],
                    ['sunset', 'linear-gradient(#3b0764,#7c2d12)', 'Sunset'],
                    ['emerald', 'linear-gradient(#064e3b,#09090b)', 'Forest'],
                  ] as const
                ).map(([id, bg, title]) => (
                  <button
                    key={id}
                    className={`swatch-btn ${!bgImage && bgPreset === id ? 'selected' : ''}`}
                    style={{ background: bg }}
                    title={title}
                    onClick={() => {
                      setBgImage(null);
                      setBgPreset(id);
                    }}
                  />
                ))}
                <input
                  type="color"
                  value={customColor}
                  title="Custom background color"
                  onChange={(e) => {
                    setBgImage(null);
                    setBgPreset('custom');
                    setCustomColor(e.target.value);
                  }}
                />
              </div>
            </label>

            <div className="field">
              <span>Custom Photo Background</span>
              <input
                ref={bgInputRef}
                type="file"
                accept="image/*"
                onChange={handleUploadBg}
                hidden
              />
              <div className="action-row">
                <button
                  className="btn-secondary-sm"
                  onClick={() => bgInputRef.current?.click()}
                >
                  <ImagePlus size={14} /> Upload Photo
                </button>
                {bgImage && (
                  <button className="btn-danger-sm" onClick={() => setBgImage(null)}>
                    Clear Photo
                  </button>
                )}
              </div>
            </div>

            {bgImage && (
              <label className="field">
                <span>Dark Overlay ({Math.round(overlayOpacity * 100)}%)</span>
                <input
                  type="range"
                  min="0"
                  max="0.9"
                  step="0.05"
                  value={overlayOpacity}
                  onChange={(e) => setOverlayOpacity(parseFloat(e.target.value))}
                />
              </label>
            )}

            <div className="form-grid-2">
              <label className="field">
                <span>Route Color</span>
                <input
                  type="color"
                  value={routeColor}
                  onChange={(e) => setRouteColor(e.target.value)}
                />
              </label>
              <label className="field">
                <span>Footer Color</span>
                <input
                  type="color"
                  value={footerColor}
                  onChange={(e) => setFooterColor(e.target.value)}
                />
              </label>
            </div>

            <div className="form-grid-2">
              <label className="field">
                <span>Footer Text</span>
                <input
                  type="text"
                  placeholder="Leave blank to hide"
                  value={footerText}
                  onChange={(e) => setFooterText(e.target.value)}
                />
              </label>
              <label className="field">
                <span>Footer Size ({footerSize}px)</span>
                <input
                  type="range"
                  min="20"
                  max="72"
                  step="2"
                  value={footerSize}
                  onChange={(e) => setFooterSize(parseInt(e.target.value, 10))}
                />
              </label>
            </div>

            <label className="field">
              <span>Top Header Text</span>
              <input
                type="text"
                value={headerText}
                onChange={(e) => setHeaderText(e.target.value)}
              />
            </label>

            <div className="field">
              <span>Visible Stats</span>
              <div className="form-grid-2" style={{ gap: '6px 10px' }}>
                <label className="checkbox-row">
                  <input type="checkbox" checked={showDistance} onChange={(e) => setShowDistance(e.target.checked)} />
                  <span>Distance</span>
                </label>
                <label className="checkbox-row">
                  <input type="checkbox" checked={showMaxElev} onChange={(e) => setShowMaxElev(e.target.checked)} />
                  <span>Max Elev</span>
                </label>
                <label className="checkbox-row">
                  <input type="checkbox" checked={showTime} onChange={(e) => setShowTime(e.target.checked)} />
                  <span>Time</span>
                </label>
                <label className="checkbox-row">
                  <input type="checkbox" checked={showMaxSpeed} onChange={(e) => setShowMaxSpeed(e.target.checked)} />
                  <span>Max Speed</span>
                </label>
                <label className="checkbox-row">
                  <input type="checkbox" checked={showAvgSpeed} onChange={(e) => setShowAvgSpeed(e.target.checked)} />
                  <span>Ave. Speed</span>
                </label>
                <label className="checkbox-row">
                  <input type="checkbox" checked={showElevGain} onChange={(e) => setShowElevGain(e.target.checked)} />
                  <span>Elev Gain</span>
                </label>
                <label className="checkbox-row">
                  <input type="checkbox" checked={showMaxHr} onChange={(e) => setShowMaxHr(e.target.checked)} />
                  <span>Max Heart Rate</span>
                </label>
                <label className="checkbox-row">
                  <input type="checkbox" checked={showMaxPower} onChange={(e) => setShowMaxPower(e.target.checked)} />
                  <span>Max Power</span>
                </label>
              </div>
            </div>

            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={showDateRange}
                onChange={(e) => setShowDateRange(e.target.checked)}
              />
              <span>Show top header text</span>
            </label>

            <button className="btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={handleDownloadJpg}>
              <Download size={16} />
              <span>Download JPG</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
