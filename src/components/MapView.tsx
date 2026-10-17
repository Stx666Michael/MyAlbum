import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  Globe,
  MapPin,
  MapPinOff,
  ZoomIn,
  ZoomOut,
  Compass,
  Layers,
  Check,
  Sparkles,
  X,
  Crosshair,
  ChevronRight,
  ChevronLeft,
  Trash2,
} from 'lucide-react';
import type { PhotoItem, PhotoLocation } from '../types/photo.ts';
import {
  createPhotoSupercluster,
  queryMapClusters,
  type MapClusterNode,
} from '../utils/mapClusters.ts';
import { formatWallClockDate } from '../utils/timelineMath.ts';

type MapStyleId = 'dark' | 'light' | 'voyager' | 'satellite';

const TILE_SOURCES: Record<
  MapStyleId,
  { name: string; tiles: string[]; overlayTiles?: string[]; attribution: string }
> = {
  dark: {
    name: 'Dark Matter',
    tiles: [
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    ],
    overlayTiles: [
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    ],
    attribution: '© Esri, HERE, Garmin, OpenStreetMap contributors',
  },
  light: {
    name: 'Positron Light',
    tiles: [
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    ],
    overlayTiles: [
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    ],
    attribution: '© Esri, HERE, Garmin, OpenStreetMap contributors',
  },
  voyager: {
    name: 'Voyager Street',
    tiles: [
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    ],
    attribution: '© Esri, HERE, Garmin, USGS, OpenStreetMap contributors',
  },
  satellite: {
    name: 'World Satellite',
    tiles: [
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    ],
    overlayTiles: [
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    ],
    attribution: '© Esri, Maxar, Earthstar Geographics',
  },
};

function buildMapLibreStyle(styleId: MapStyleId, useGlobe: boolean): maplibregl.StyleSpecification {
  const sourceCfg = TILE_SOURCES[styleId];
  const sources: Record<string, maplibregl.SourceSpecification> = {
    'raster-tiles': {
      type: 'raster',
      tiles: sourceCfg.tiles,
      tileSize: 256,
      maxzoom: 19,
      attribution: sourceCfg.attribution,
    },
  };

  const layers: maplibregl.LayerSpecification[] = [
    {
      id: 'raster-layer',
      type: 'raster',
      source: 'raster-tiles',
      minzoom: 0,
      maxzoom: 20,
    },
  ];

  if (sourceCfg.overlayTiles && sourceCfg.overlayTiles.length > 0) {
    sources['raster-overlay-tiles'] = {
      type: 'raster',
      tiles: sourceCfg.overlayTiles,
      tileSize: 256,
      maxzoom: 19,
    };
    layers.push({
      id: 'raster-overlay-layer',
      type: 'raster',
      source: 'raster-overlay-tiles',
      minzoom: 0,
      maxzoom: 20,
    });
  }

  return {
    version: 8,
    projection: {
      type: useGlobe ? 'globe' : 'mercator',
    },
    sky: {
      'atmosphere-blend': useGlobe
        ? ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0]
        : 0,
    },
    sources,
    layers,
  } as maplibregl.StyleSpecification;
}

interface MapViewProps {
  photos: PhotoItem[];
  selectedIds: Set<string>;
  onToggleSelect: (photoId: string, event?: React.MouseEvent) => void;
  onSelectGroup: (photoIds: string[], additive?: boolean) => void;
  onOpenPhoto: (photo: PhotoItem) => void;
  onBatchSetLocation: (photoIds: string[], location: PhotoLocation) => Promise<void>;
  onBatchRemoveLocation: (photoIds: string[]) => Promise<void>;
  isPickingLocation?: boolean;
  onChangePickingLocation?: (picking: boolean) => void;
}

const PRESET_LOCATIONS: Array<{ name: string; lat: number; lng: number }> = [
  { name: 'Tokyo, Japan', lat: 35.6762, lng: 139.6503 },
  { name: 'Paris, France', lat: 48.8566, lng: 2.3522 },
  { name: 'Reykjavik, Iceland', lat: 64.1466, lng: -21.9426 },
  { name: 'New York, NY, USA', lat: 40.7128, lng: -74.0060 },
  { name: 'Cairo, Egypt', lat: 30.0444, lng: 31.2357 },
  { name: 'Sydney, Australia', lat: -33.8688, lng: 151.2093 },
  { name: 'London, UK', lat: 51.5072, lng: -0.1276 },
  { name: 'San Francisco, USA', lat: 37.7749, lng: -122.4194 },
];

export const MapView: React.FC<MapViewProps> = ({
  photos,
  selectedIds,
  onToggleSelect,
  onSelectGroup,
  onOpenPhoto,
  onBatchSetLocation,
  onBatchRemoveLocation,
  isPickingLocation = false,
  onChangePickingLocation,
}) => {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  const [viewport, setViewport] = useState({ width: 1280, height: 760 });
  const [center, setCenter] = useState<{ lng: number; lat: number }>({ lng: 18, lat: 24 });
  const [zoom, setZoom] = useState<number>(1.85);
  const [styleId, setStyleId] = useState<MapStyleId>('dark');
  const [globeMode, setGlobeMode] = useState<boolean>(true);
  const [mapReady, setMapReady] = useState<boolean>(false);
  const appliedStyleRef = useRef<{ styleId: MapStyleId; globeMode: boolean }>({
    styleId: 'dark',
    globeMode: true,
  });

  // Cluster inspector popover state (tracked by photo IDs so edits/removals update live)
  const [activeClusterSelection, setActiveClusterSelection] = useState<{
    photoIds: string[];
    title: string;
  } | null>(null);

  // Unlocated drawer state
  const [showUnlocatedDrawer, setShowUnlocatedDrawer] = useState<boolean>(false);

  // Interactive pin picker state for batch location assignment
  const [pickingModeInternal, setPickingModeInternal] = useState<boolean>(false);
  const isPinPicking = isPickingLocation || pickingModeInternal;
  const setPinPicking = useCallback(
    (val: boolean) => {
      setPickingModeInternal(val);
      onChangePickingLocation?.(val);
    },
    [onChangePickingLocation]
  );

  const [pickedCoord, setPickedCoord] = useState<{ lat: number; lng: number }>({
    lat: 35.6762,
    lng: 139.6503,
  });
  const [pickedLatInput, setPickedLatInput] = useState<string>('35.6762');
  const [pickedLngInput, setPickedLngInput] = useState<string>('139.6503');
  const [pickedName, setPickedName] = useState<string>('Tokyo, Japan');
  const [isSavingBatchLoc, setIsSavingBatchLoc] = useState<boolean>(false);

  const updatePickedCoordinates = useCallback((lat: number, lng: number) => {
    setPickedCoord({ lat, lng });
    setPickedLatInput(String(lat));
    setPickedLngInput(String(lng));
  }, []);

  // Fallback drag state if user drags when WebGL is unavailable
  const fallbackDragRef = useRef<{ active: boolean; x: number; y: number; lng: number; lat: number }>({
    active: false,
    x: 0,
    y: 0,
    lng: 0,
    lat: 0,
  });

  const locatedPhotos = useMemo(() => photos.filter((p) => p.location !== null), [photos]);
  const unlocatedPhotos = useMemo(() => photos.filter((p) => p.location === null), [photos]);

  // Live resolved cluster photos for the cluster inspector popover
  const activeCluster = useMemo(() => {
    if (!activeClusterSelection) return null;
    const idSet = new Set(activeClusterSelection.photoIds);
    const livePhotos = locatedPhotos.filter((p) => idSet.has(p.id));
    if (livePhotos.length === 0) return null;
    return {
      allPhotos: livePhotos,
      title: livePhotos[0]?.location?.name || activeClusterSelection.title || 'Grouped area',
    };
  }, [activeClusterSelection, locatedPhotos]);

  // Automatically close unlocated drawer when no unlocated photos remain
  useEffect(() => {
    if (unlocatedPhotos.length === 0 && showUnlocatedDrawer) {
      setShowUnlocatedDrawer(false);
    }
  }, [unlocatedPhotos.length, showUnlocatedDrawer]);

  // Measure viewport
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const update = () => {
      setViewport({
        width: el.clientWidth || 1280,
        height: el.clientHeight || 760,
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Initialize MapLibre GL JS v5 with 3D Globe projection
  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container) return;

    let mapInstance: maplibregl.Map | null = null;
    try {
      appliedStyleRef.current = { styleId, globeMode };
      mapInstance = new maplibregl.Map({
        container,
        style: buildMapLibreStyle(styleId, globeMode),
        center: [center.lng, center.lat],
        zoom,
        minZoom: 0.8,
        maxZoom: 18,
        attributionControl: false,
      });

      mapRef.current = mapInstance;

      const syncCamera = () => {
        if (!mapInstance) return;
        const c = mapInstance.getCenter();
        setCenter({ lng: c.lng, lat: c.lat });
        setZoom(Number(mapInstance.getZoom().toFixed(2)));
      };

      mapInstance.on('load', () => {
        setMapReady(true);
        syncCamera();
      });

      mapInstance.on('move', syncCamera);
      mapInstance.on('zoom', syncCamera);
    } catch {
      // Fallback mathematical projection will be used if WebGL context is unavailable
      setMapReady(false);
    }

    return () => {
      if (mapInstance) {
        mapInstance.remove();
        mapRef.current = null;
      }
    };
  }, []);

  // Update map style or globe projection only when styleId or globeMode changes after mount
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (
      appliedStyleRef.current.styleId === styleId &&
      appliedStyleRef.current.globeMode === globeMode
    ) {
      return;
    }
    appliedStyleRef.current = { styleId, globeMode };
    try {
      map.setStyle(buildMapLibreStyle(styleId, globeMode));
    } catch {
      // ignore
    }
  }, [styleId, globeMode]);

  // Build Supercluster spatial index
  const superclusterIndex = useMemo(() => createPhotoSupercluster(locatedPhotos, 62, 16), [locatedPhotos]);

  // Query clusters across world bbox for current zoom level
  const clusterNodes: MapClusterNode[] = useMemo(() => {
    return queryMapClusters(superclusterIndex, [-180, -85, 180, 85], zoom);
  }, [superclusterIndex, zoom]);

  // Project [lng, lat] to screen pixel [x, y] and determine if visible on front hemisphere of 3D globe
  const projectPoint = useCallback(
    (lng: number, lat: number): { x: number; y: number; visible: boolean } => {
      const deg2rad = Math.PI / 180;
      const lat1 = center.lat * deg2rad;
      const lat2 = lat * deg2rad;
      const dLng = (lng - center.lng) * deg2rad;

      const cosAngle =
        Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos(dLng);

      // Hide markers on the far side of the Earth across all zoom levels in globe mode
      // so antipodal markers never project through the front viewport when zoomed in
      const isGlobeActive = globeMode && zoom < 5.5;
      if ((globeMode || zoom >= 2.5) && cosAngle < 0.15) {
        return { x: -9999, y: -9999, visible: false };
      }

      const map = mapRef.current;
      if (map && mapReady) {
        try {
          const pt = map.project([lng, lat]);
          const inBounds =
            pt.x >= -80 &&
            pt.x <= viewport.width + 80 &&
            pt.y >= -80 &&
            pt.y <= viewport.height + 80;
          return { x: pt.x, y: pt.y, visible: inBounds };
        } catch {
          // fallback below
        }
      }

      // Mathematical Orthographic (Globe) / Web Mercator fallback projection
      if (isGlobeActive) {
        const radius = Math.min(viewport.width, viewport.height) * 0.34 * Math.pow(1.42, zoom - 1.5);
        const x = viewport.width / 2 + radius * Math.cos(lat2) * Math.sin(dLng);
        const y =
          viewport.height / 2 -
          radius * (Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng));
        return { x, y, visible: true };
      } else {
        const scale = 256 * Math.pow(2, zoom);
        const worldX = ((lng + 180) / 360) * scale;
        const centerWorldX = ((center.lng + 180) / 360) * scale;
        const sinLat = Math.sin(Math.max(-85, Math.min(85, lat)) * deg2rad);
        const centerSinLat = Math.sin(Math.max(-85, Math.min(85, center.lat)) * deg2rad);
        const worldY = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
        const centerWorldY =
          (0.5 - Math.log((1 + centerSinLat) / (1 - centerSinLat)) / (4 * Math.PI)) * scale;

        const x = viewport.width / 2 + (worldX - centerWorldX);
        const y = viewport.height / 2 + (worldY - centerWorldY);
        const visible = x >= -100 && x <= viewport.width + 100 && y >= -100 && y <= viewport.height + 100;
        return { x, y, visible };
      }
    },
    [center, zoom, globeMode, mapReady, viewport]
  );

  const flyToCamera = useCallback((nextLng: number, nextLat: number, nextZoom: number) => {
    setCenter({ lng: nextLng, lat: nextLat });
    setZoom(nextZoom);
    const map = mapRef.current;
    if (map) {
      try {
        map.flyTo({ center: [nextLng, nextLat], zoom: nextZoom, duration: 750 });
      } catch {
        // ignore
      }
    }
  }, []);

  const handleZoomIn = () => {
    const nextZoom = Math.min(18, Number((zoom + 1.2).toFixed(2)));
    flyToCamera(center.lng, center.lat, nextZoom);
  };

  const handleZoomOut = () => {
    const nextZoom = Math.max(1.0, Number((zoom - 1.2).toFixed(2)));
    flyToCamera(center.lng, center.lat, nextZoom);
  };

  const handleResetGlobe = () => {
    setActiveClusterSelection(null);
    setGlobeMode(true);
    flyToCamera(18, 24, 1.85);
  };

  // Handle clicking on the map surface when in Pin Picking mode
  const handleCanvasClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isPinPicking) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-map-ui="true"]')) return;

    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return;
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    const map = mapRef.current;
    if (map && mapReady) {
      try {
        const lngLat = map.unproject([clickX, clickY]);
        const lat = Number(Math.max(-85, Math.min(85, lngLat.lat)).toFixed(5));
        const lng = Number((((lngLat.lng + 180) % 360 + 360) % 360 - 180).toFixed(5));
        updatePickedCoordinates(lat, lng);
        setPickedName(`${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(3)}°${lng >= 0 ? 'E' : 'W'}`);
        return;
      } catch {
        // fallback below
      }
    }

    // Fallback unproject
    const dx = (clickX - viewport.width / 2) / (viewport.width * 0.35);
    const dy = (viewport.height / 2 - clickY) / (viewport.height * 0.35);
    const lat = Number(Math.max(-80, Math.min(80, center.lat + dy * (60 / Math.max(1, zoom)))).toFixed(5));
    const lng = Number(Math.max(-179, Math.min(179, center.lng + dx * (90 / Math.max(1, zoom)))).toFixed(5));
    updatePickedCoordinates(lat, lng);
    setPickedName(`${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(3)}°${lng >= 0 ? 'E' : 'W'}`);
  };

  const handleApplyPickedLocation = async () => {
    const targetIds = Array.from(selectedIds);
    if (targetIds.length === 0) return;
    setIsSavingBatchLoc(true);
    try {
      await onBatchSetLocation(targetIds, {
        lat: pickedCoord.lat,
        lng: pickedCoord.lng,
        name: pickedName.trim() || `${pickedCoord.lat.toFixed(4)}, ${pickedCoord.lng.toFixed(4)}`,
      });
      setPinPicking(false);
    } finally {
      setIsSavingBatchLoc(false);
    }
  };

  const isGlobeVisualActive = globeMode && zoom < 5.5;
  const globeRadiusPx = useMemo(
    () => Math.min(viewport.width, viewport.height) * 0.34 * Math.pow(1.42, Math.min(4.2, zoom) - 1.5),
    [viewport, zoom]
  );

  return (
    <div
      ref={wrapperRef}
      onClick={handleCanvasClick}
      onPointerDown={(e) => {
        if (mapReady) return;
        const target = e.target as HTMLElement;
        if (target.closest('[data-map-ui="true"]')) return;
        fallbackDragRef.current = {
          active: true,
          x: e.clientX,
          y: e.clientY,
          lng: center.lng,
          lat: center.lat,
        };
      }}
      onPointerMove={(e) => {
        if (!fallbackDragRef.current.active) return;
        const dx = e.clientX - fallbackDragRef.current.x;
        const dy = e.clientY - fallbackDragRef.current.y;
        const factor = 140 / Math.pow(1.6, zoom);
        setCenter({
          lng: ((((fallbackDragRef.current.lng - (dx / viewport.width) * factor) + 180) % 360 + 360) % 360) - 180,
          lat: Math.max(-80, Math.min(80, fallbackDragRef.current.lat + (dy / viewport.height) * factor)),
        });
      }}
      onPointerUp={() => {
        fallbackDragRef.current.active = false;
      }}
      onWheel={(e) => {
        if (mapReady) return;
        const delta = e.deltaY < 0 ? 0.65 : -0.65;
        setZoom((z) => Math.max(1.0, Math.min(18, Number((z + delta).toFixed(2)))));
      }}
      className={`relative h-full w-full overflow-hidden bg-slate-950 select-none ${
        isPinPicking ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'
      }`}
      data-testid="map-view-container"
      data-projection={isGlobeVisualActive ? 'globe' : 'mercator'}
      data-zoom={zoom}
    >
      {/* Atmospheric 3D Globe Underlayer & Space Halo (visible behind/around the globe at low zoom) */}
      {isGlobeVisualActive && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden"
          data-testid="globe-atmosphere-layer"
        >
          <div
            className="rounded-full transition-all duration-300"
            style={
              mapReady
                ? {
                    width: globeRadiusPx * 2.2,
                    height: globeRadiusPx * 2.2,
                    background:
                      'radial-gradient(circle, rgba(56, 189, 248, 0.14) 0%, rgba(14, 116, 144, 0.06) 55%, rgba(2, 6, 23, 0) 75%)',
                  }
                : {
                    width: globeRadiusPx * 2,
                    height: globeRadiusPx * 2,
                    background:
                      'radial-gradient(circle at 35% 30%, rgba(30, 58, 138, 0.55), rgba(15, 23, 42, 0.92) 70%, rgba(2, 6, 23, 0.98) 100%)',
                    boxShadow:
                      '0 0 90px 18px rgba(56, 189, 248, 0.18), inset 0 0 50px rgba(56, 189, 248, 0.22)',
                    border: '1px solid rgba(56, 189, 248, 0.32)',
                  }
            }
          />
        </div>
      )}

      {/* MapLibre GL JS v5 Canvas */}
      <div ref={mapContainerRef} className="absolute inset-0 h-full w-full" />

      {/* Top-Left Status & Globe Indicator Bar */}
      <div
        data-map-ui="true"
        className="absolute left-5 top-4 z-20 flex flex-wrap items-center gap-2.5 rounded-xl border border-slate-800/80 bg-slate-900/85 px-3.5 py-2 text-xs text-slate-300 backdrop-blur-md shadow-xl"
      >
        <div className="flex items-center gap-1.5">
          <Globe className={`h-4 w-4 ${isGlobeVisualActive ? 'text-sky-400 animate-pulse' : 'text-slate-400'}`} />
          <span className="font-semibold text-slate-100" data-testid="globe-status-label">
            {isGlobeVisualActive ? '3D Globe Projection' : 'Detailed Map View'}
          </span>
          <span className="rounded-md bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-sky-300">
            Zoom {zoom.toFixed(1)}x
          </span>
        </div>

        <span className="text-slate-700">|</span>

        <div className="flex items-center gap-1.5 text-slate-400">
          <MapPin className="h-3.5 w-3.5 text-emerald-400" />
          <span>
            <strong className="text-slate-200">{locatedPhotos.length}</strong> located
          </span>
        </div>

        {unlocatedPhotos.length > 0 && (
          <>
            <span className="text-slate-700">|</span>
            <button
              type="button"
              onClick={() => setShowUnlocatedDrawer((v) => !v)}
              className="flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-amber-300 hover:bg-amber-500/25 transition"
              data-testid="toggle-unlocated-drawer-btn"
            >
              <MapPinOff className="h-3 w-3" />
              <span>{unlocatedPhotos.length} Unlocated</span>
              {showUnlocatedDrawer ? <ChevronLeft className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </button>
          </>
        )}
      </div>

      {/* Top-Right Map Style, Globe Reset, and Batch Location Controls */}
      <div
        data-map-ui="true"
        data-testid="location-view-options-bar"
        className="absolute right-5 top-4 z-20 ml-auto flex flex-wrap items-center justify-end gap-2 rounded-xl border border-slate-800/80 bg-slate-900/85 p-1.5 backdrop-blur-md shadow-xl"
      >
        {/* Batch Pick Location on Map Trigger */}
        <button
          type="button"
          onClick={() => {
            if (!isPinPicking && selectedIds.size === 0 && unlocatedPhotos.length > 0) {
              // Automatically select unlocated photos if none are selected yet
              onSelectGroup(unlocatedPhotos.map((p) => p.id), true);
            }
            setPinPicking(!isPinPicking);
          }}
          className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition border ${
            isPinPicking
              ? 'border-sky-400 bg-sky-500 text-slate-950 shadow-[0_0_15px_rgba(56,189,248,0.4)]'
              : 'border-slate-700 bg-slate-800/80 text-slate-200 hover:border-sky-400/50 hover:text-sky-300'
          }`}
          data-testid="map-pick-location-btn"
        >
          <Crosshair className="h-3.5 w-3.5" />
          {isPinPicking ? 'Exit Pin Picker' : 'Batch Pin Picker'}
        </button>

        {selectedIds.size > 0 && (
          <button
            type="button"
            onClick={() => onBatchRemoveLocation(Array.from(selectedIds))}
            className="flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/15 px-2.5 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-500/25 transition"
            title="Remove GPS coordinates from all selected photos"
            data-testid="map-batch-remove-location-btn"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Remove Location ({selectedIds.size})
          </button>
        )}

        <div className="h-5 w-px bg-slate-800" />

        {/* Map Theme Selector */}
        <div className="flex items-center gap-1 rounded-lg bg-slate-950/80 p-0.5 border border-slate-800">
          <Layers className="ml-1.5 h-3.5 w-3.5 text-slate-400" />
          {(['dark', 'light', 'voyager', 'satellite'] as MapStyleId[]).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setStyleId(id)}
              className={`rounded-md px-2 py-1 text-[11px] font-medium capitalize transition ${
                styleId === id
                  ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {id}
            </button>
          ))}
        </div>

        <div className="h-5 w-px bg-slate-800" />

        {/* Zoom & Globe View Controls */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleZoomOut}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition"
            title="Zoom Out towards 3D Globe"
            data-testid="map-zoom-out"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={handleZoomIn}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition"
            title="Zoom In"
            data-testid="map-zoom-in"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={handleResetGlobe}
            className="flex items-center gap-1 rounded-lg border border-slate-700/80 bg-slate-800/70 px-2 py-1 text-xs font-medium text-sky-300 hover:bg-slate-800 transition"
            title="Zoom out to Full 3D Globe"
            data-testid="map-reset-globe-btn"
          >
            <Compass className="h-3.5 w-3.5" />
            Globe View
          </button>
        </div>
      </div>

      {/* Interactive Pin Picker Floating Banner (when assigning location in batch) */}
      {isPinPicking && (
        <div
          data-map-ui="true"
          className="absolute left-1/2 top-16 z-30 flex w-[92vw] max-w-2xl -translate-x-1/2 flex-col gap-2.5 rounded-2xl border border-sky-400/50 bg-slate-900/95 p-4 backdrop-blur-xl shadow-2xl"
          data-testid="map-pin-picker-banner"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-sky-500/20 text-sky-400">
                <Crosshair className="h-4 w-4" />
              </span>
              <span className="text-sm font-semibold text-white">
                Batch Set Location ({selectedIds.size} photo{selectedIds.size === 1 ? '' : 's'} selected)
              </span>
            </div>
            <button
              type="button"
              onClick={() => setPinPicking(false)}
              className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <p className="text-xs text-slate-300">
            Click anywhere on the globe/map to position the target pin, or choose a quick destination below:
          </p>

          <div className="flex flex-wrap gap-1.5">
            {PRESET_LOCATIONS.map((preset) => (
              <button
                key={preset.name}
                type="button"
                onClick={() => {
                  updatePickedCoordinates(preset.lat, preset.lng);
                  setPickedName(preset.name);
                  flyToCamera(preset.lng, preset.lat, Math.max(zoom, 4.5));
                }}
                className={`rounded-lg border px-2 py-1 text-[11px] font-medium transition ${
                  pickedName === preset.name
                    ? 'border-sky-400 bg-sky-500/20 text-sky-200'
                    : 'border-slate-800 bg-slate-950/70 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                }`}
                data-testid={`preset-loc-${preset.name.split(',')[0].toLowerCase().replace(/\s+/g, '-')}`}
              >
                {preset.name}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <div className="flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-xs">
              <span className="text-slate-500">Lat:</span>
              <input
                type="text"
                inputMode="decimal"
                value={pickedLatInput}
                onChange={(e) => {
                  const val = e.target.value;
                  setPickedLatInput(val);
                  const parsed = Number(val);
                  if (val.trim() !== '' && val.trim() !== '-' && Number.isFinite(parsed)) {
                    setPickedCoord((c) => ({ ...c, lat: Math.max(-85, Math.min(85, parsed)) }));
                  }
                }}
                onBlur={() => setPickedLatInput(String(pickedCoord.lat))}
                className="w-20 bg-transparent font-mono text-slate-100 focus:outline-none"
                aria-label="Latitude"
              />
              <span className="text-slate-600">|</span>
              <span className="text-slate-500">Lng:</span>
              <input
                type="text"
                inputMode="decimal"
                value={pickedLngInput}
                onChange={(e) => {
                  const val = e.target.value;
                  setPickedLngInput(val);
                  const parsed = Number(val);
                  if (val.trim() !== '' && val.trim() !== '-' && Number.isFinite(parsed)) {
                    setPickedCoord((c) => ({ ...c, lng: Math.max(-180, Math.min(180, parsed)) }));
                  }
                }}
                onBlur={() => setPickedLngInput(String(pickedCoord.lng))}
                className="w-20 bg-transparent font-mono text-slate-100 focus:outline-none"
                aria-label="Longitude"
              />
            </div>

            <input
              type="text"
              value={pickedName}
              onChange={(e) => setPickedName(e.target.value)}
              placeholder="Location label (e.g. Shibuya, Tokyo)"
              className="min-w-[180px] flex-1 rounded-lg border border-slate-800 bg-slate-950 px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
              data-testid="map-picked-name-input"
            />

            <button
              type="button"
              disabled={selectedIds.size === 0 || isSavingBatchLoc}
              onClick={handleApplyPickedLocation}
              className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-40 transition shadow-lg"
              data-testid="map-apply-location-btn"
            >
              <Check className="h-3.5 w-3.5" />
              {isSavingBatchLoc ? 'Saving...' : `Apply to ${selectedIds.size} Selected`}
            </button>
          </div>
        </div>
      )}

      {/* Cluster Markers & Single Photo Markers Overlay */}
      <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
        {clusterNodes.map((node) => {
          const pos = projectPoint(node.lng, node.lat);
          if (!pos.visible) return null;

          if (node.isCluster) {
            const selectedInCluster = node.allPhotos.filter((p) => selectedIds.has(p.id)).length;
            const allSelected = selectedInCluster === node.allPhotos.length && node.allPhotos.length > 0;
            const locationTitle =
              node.samplePhotos[0]?.location?.name?.split(',').slice(-2).join(',').trim() ||
              `${node.lat.toFixed(1)}°, ${node.lng.toFixed(1)}°`;

            return (
              <div
                key={node.id}
                data-map-ui="true"
                data-testid={`map-cluster-marker-${node.clusterId}`}
                data-cluster-count={node.pointCount}
                style={{
                  transform: `translate3d(${Math.round(pos.x)}px, ${Math.round(pos.y)}px, 0)`,
                }}
                className="pointer-events-auto absolute left-0 top-0 -translate-x-1/2 -translate-y-1/2"
              >
                <div
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveClusterSelection({
                      photoIds: node.allPhotos.map((p) => p.id),
                      title: node.samplePhotos[0]?.location?.name || locationTitle,
                    });
                    if (zoom < 10) {
                      flyToCamera(node.lng, node.lat, Math.min(13, Math.max(zoom + 2.5, node.expansionZoom)));
                    }
                  }}
                  className={`group relative flex cursor-pointer items-center gap-2 rounded-2xl border p-1.5 pr-3 backdrop-blur-md transition-all duration-200 hover:scale-105 ${
                    allSelected
                      ? 'border-sky-400 bg-sky-950/90 shadow-[0_0_24px_rgba(56,189,248,0.45)]'
                      : selectedInCluster > 0
                        ? 'border-sky-400/70 bg-slate-900/95'
                        : 'border-slate-700/90 bg-slate-900/90 hover:border-sky-400/70 shadow-2xl'
                  }`}
                >
                  {/* Stacked Photo Thumbnails */}
                  <div className="relative h-11 w-11 shrink-0">
                    {node.samplePhotos.slice(0, 2).map((p, idx) => (
                      <img
                        key={p.id}
                        src={p.url}
                        alt={p.fileName}
                        className="absolute inset-0 h-11 w-11 rounded-xl object-cover border border-white/20 shadow"
                        style={{
                          transform: idx === 0 ? 'rotate(0deg)' : 'rotate(6deg) translate(2px, -2px)',
                          zIndex: 2 - idx,
                        }}
                      />
                    ))}
                    {/* Prominent Photo Count Badge */}
                    <span
                      className="absolute -right-2 -top-2 z-10 flex h-6 min-w-[24px] items-center justify-center rounded-full bg-sky-500 px-1.5 font-mono text-xs font-bold text-slate-950 shadow-[0_0_12px_rgba(56,189,248,0.6)] border border-white/40"
                      data-testid="cluster-count-badge"
                    >
                      {node.pointCount}
                    </span>
                  </div>

                  <div className="min-w-0 max-w-[120px]">
                    <p className="truncate text-xs font-semibold text-slate-100">{locationTitle}</p>
                    <p className="text-[10px] text-sky-300 font-medium">{node.pointCount} photos</p>
                  </div>
                </div>
              </div>
            );
          }

          // Single Photo Pin Marker
          const { photo } = node;
          const isSelected = selectedIds.has(photo.id);
          return (
            <div
              key={node.id}
              data-map-ui="true"
              data-testid={`map-photo-marker-${photo.id}`}
              style={{
                transform: `translate3d(${Math.round(pos.x)}px, ${Math.round(pos.y)}px, 0)`,
              }}
              className="pointer-events-auto absolute left-0 top-0 -translate-x-1/2 -translate-y-full"
            >
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  if (e.shiftKey || e.metaKey || e.ctrlKey) {
                    onToggleSelect(photo.id, e);
                  } else {
                    onOpenPhoto(photo);
                  }
                }}
                className="group relative flex flex-col items-center cursor-pointer transition-transform duration-200 hover:scale-110 hover:z-30"
              >
                <div
                  className={`relative h-14 w-14 overflow-hidden rounded-2xl border-2 p-0.5 backdrop-blur-md transition ${
                    isSelected
                      ? 'border-sky-400 bg-sky-500/30 shadow-[0_0_20px_rgba(56,189,248,0.5)]'
                      : 'border-white/80 bg-slate-900 shadow-xl group-hover:border-sky-400'
                  }`}
                >
                  <img
                    src={photo.url}
                    alt={photo.fileName}
                    className="h-full w-full rounded-xl object-cover"
                  />

                  {/* Selection Checkbox on Pin */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleSelect(photo.id, e);
                    }}
                    className={`absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-md border transition ${
                      isSelected
                        ? 'border-sky-300 bg-sky-500 text-slate-950'
                        : 'border-white/40 bg-slate-950/60 text-transparent opacity-0 group-hover:opacity-100 hover:border-sky-300'
                    }`}
                    title="Select photo for batch edit"
                    data-testid={`map-select-photo-${photo.id}`}
                  >
                    <Check className="h-3 w-3" />
                  </button>

                  {photo.isLocationEdited && (
                    <span className="absolute right-1 top-1 rounded-full bg-amber-500 p-0.5 text-slate-950">
                      <Sparkles className="h-2.5 w-2.5" />
                    </span>
                  )}
                </div>

                {/* Pin Pointer Tail */}
                <div
                  className={`h-2.5 w-2.5 -mt-1 rotate-45 border-b-2 border-r-2 ${
                    isSelected ? 'border-sky-400 bg-sky-500' : 'border-white/80 bg-slate-900'
                  }`}
                />
              </div>
            </div>
          );
        })}

        {/* Active Target Pin when in Pin Picking mode */}
        {isPinPicking && (() => {
          const targetPos = projectPoint(pickedCoord.lng, pickedCoord.lat);
          if (!targetPos.visible) return null;
          return (
            <div
              style={{
                transform: `translate3d(${Math.round(targetPos.x)}px, ${Math.round(targetPos.y)}px, 0)`,
              }}
              className="pointer-events-none absolute left-0 top-0 -translate-x-1/2 -translate-y-full z-30"
              data-testid="map-picked-target-pin"
            >
              <div className="flex flex-col items-center">
                <div className="rounded-full bg-sky-500 px-2.5 py-1 text-[10px] font-bold text-slate-950 shadow-lg whitespace-nowrap">
                  {pickedName}
                </div>
                <MapPin className="h-8 w-8 text-sky-400 drop-shadow-[0_0_12px_rgba(56,189,248,0.9)] -mt-1" />
              </div>
            </div>
          );
        })()}
      </div>

      {/* Cluster Inspector Popover Panel (shows photos inside a clicked cluster) */}
      {activeCluster && (
        <div
          data-map-ui="true"
          className="absolute bottom-5 left-5 z-20 flex w-80 max-h-[65vh] flex-col rounded-2xl border border-slate-800/90 bg-slate-900/95 backdrop-blur-xl shadow-2xl overflow-hidden"
          data-testid="cluster-inspector-popover"
        >
          <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
            <div>
              <h3 className="text-xs font-semibold text-white">
                Cluster Photos ({activeCluster.allPhotos.length})
              </h3>
              <p className="text-[11px] text-slate-400 truncate max-w-[190px]">
                {activeCluster.title}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  const ids = activeCluster.allPhotos.map((p) => p.id);
                  const allSelected = ids.every((id) => selectedIds.has(id));
                  onSelectGroup(ids, !allSelected);
                }}
                className="rounded-lg border border-sky-500/40 bg-sky-500/15 px-2 py-1 text-[11px] font-medium text-sky-300 hover:bg-sky-500/25 transition"
                data-testid="select-all-in-cluster-btn"
              >
                Select All
              </button>
              <button
                type="button"
                onClick={() => setActiveClusterSelection(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 overflow-y-auto p-3">
            {activeCluster.allPhotos.map((photo) => {
              const isSelected = selectedIds.has(photo.id);
              return (
                <div
                  key={photo.id}
                  onClick={() => onOpenPhoto(photo)}
                  className={`group relative cursor-pointer overflow-hidden rounded-xl border transition ${
                    isSelected
                      ? 'border-sky-400 ring-2 ring-sky-400/40'
                      : 'border-slate-800 hover:border-slate-600'
                  }`}
                >
                  <img src={photo.url} alt={photo.fileName} className="h-24 w-full object-cover" />
                  <div className="absolute inset-0 bg-gradient-to-t from-slate-950/85 via-transparent to-transparent" />
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleSelect(photo.id, e);
                    }}
                    className={`absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-md border ${
                      isSelected
                        ? 'border-sky-300 bg-sky-500 text-slate-950'
                        : 'border-white/40 bg-slate-950/60 text-transparent group-hover:text-white/60'
                    }`}
                  >
                    <Check className="h-3 w-3" />
                  </button>
                  <div className="absolute inset-x-1.5 bottom-1 text-[10px] text-slate-200 truncate font-medium">
                    {formatWallClockDate(photo.timestamp)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Unlocated Photos Drawer (allows selecting unlocated photos & assigning locations in a batch) */}
      {showUnlocatedDrawer && (
        <div
          data-map-ui="true"
          className="absolute bottom-5 right-5 top-20 z-20 flex w-80 flex-col rounded-2xl border border-slate-800/90 bg-slate-900/95 backdrop-blur-xl shadow-2xl overflow-hidden"
          data-testid="unlocated-photos-drawer"
        >
          <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
            <div className="flex items-center gap-2">
              <MapPinOff className="h-4 w-4 text-amber-400" />
              <div>
                <h3 className="text-xs font-semibold text-white">
                  Unlocated Photos ({unlocatedPhotos.length})
                </h3>
                <p className="text-[10px] text-slate-400">Select to assign a location on the map</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowUnlocatedDrawer(false)}
              className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex items-center justify-between border-b border-slate-800/80 bg-slate-950/50 px-3.5 py-2">
            <button
              type="button"
              onClick={() => {
                const ids = unlocatedPhotos.map((p) => p.id);
                const allSelected = ids.every((id) => selectedIds.has(id));
                onSelectGroup(ids, !allSelected);
              }}
              className="text-xs font-medium text-sky-400 hover:text-sky-300"
              data-testid="select-all-unlocated-btn"
            >
              {unlocatedPhotos.every((p) => selectedIds.has(p.id)) ? 'Deselect All' : 'Select All Unlocated'}
            </button>

            <button
              type="button"
              onClick={() => {
                const ids = unlocatedPhotos.map((p) => p.id);
                if (!ids.some((id) => selectedIds.has(id))) {
                  onSelectGroup(ids, true);
                }
                setPinPicking(true);
              }}
              className="flex items-center gap-1 rounded-lg bg-sky-500/20 border border-sky-500/40 px-2.5 py-1 text-[11px] font-medium text-sky-300 hover:bg-sky-500/30"
              data-testid="assign-unlocated-on-map-btn"
            >
              <Crosshair className="h-3 w-3" />
              Place on Map
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2.5 overflow-y-auto p-3">
            {unlocatedPhotos.map((photo) => {
              const isSelected = selectedIds.has(photo.id);
              return (
                <div
                  key={photo.id}
                  onClick={() => onOpenPhoto(photo)}
                  className={`group relative cursor-pointer overflow-hidden rounded-xl border transition ${
                    isSelected
                      ? 'border-sky-400 ring-2 ring-sky-400/40'
                      : 'border-slate-800 hover:border-slate-600'
                  }`}
                  data-testid={`unlocated-card-${photo.id}`}
                >
                  <img src={photo.url} alt={photo.fileName} className="h-24 w-full object-cover" />
                  <div className="absolute inset-0 bg-gradient-to-t from-slate-950/90 via-transparent to-transparent" />
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleSelect(photo.id, e);
                    }}
                    className={`absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-md border ${
                      isSelected
                        ? 'border-sky-300 bg-sky-500 text-slate-950'
                        : 'border-white/40 bg-slate-950/60 text-transparent group-hover:text-white/60'
                    }`}
                    data-testid={`select-unlocated-${photo.id}`}
                  >
                    <Check className="h-3 w-3" />
                  </button>
                  <div className="absolute inset-x-1.5 bottom-1">
                    <p className="truncate text-[10px] font-medium text-slate-200">{photo.fileName}</p>
                    <p className="text-[9px] text-slate-400">{formatWallClockDate(photo.timestamp)}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
