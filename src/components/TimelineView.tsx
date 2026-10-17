import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Play,
  Pause,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Check,
  MapPin,
  Clock,
  Sparkles,
  Columns3,
  CalendarRange,
  Gauge,
  FolderOpen,
  ChevronsUp,
  ChevronsDown,
} from 'lucide-react';
import type { PhotoItem } from '../types/photo.ts';
import {
  BASE_TIME_CARD_HEIGHT_PX,
  BASE_TIME_CARD_WIDTH_PX,
  MAX_TIMELINE_ZOOM,
  MIN_TIMELINE_ZOOM,
  STRING_END_ZONE_HEIGHT_PX,
  buildTimelineDayColumns,
  buildVirtualStringItems,
  clampTimelinePanX,
  computeCenteredTimelinePanX,
  computeFlowingCardState,
  computeStringFlowVelocity,
  formatWallClockDate,
  getTimelineZoomMetrics,
  getWallClockParts,
  resolveStringEndHoverDirection,
  type DayColumnGroup,
  type StringEndHoverDirection,
  type TimelineGranularity,
} from '../utils/timelineMath.ts';

interface TimelineViewProps {
  photos: PhotoItem[];
  selectedIds: Set<string>;
  onToggleSelect: (photoId: string, event?: React.MouseEvent) => void;
  onSelectGroup: (photoIds: string[], additive?: boolean) => void;
  onOpenPhoto: (photo: PhotoItem) => void;
  spacingMode: 'compact' | 'proportional';
  onChangeSpacingMode: (mode: 'compact' | 'proportional') => void;
}

const COLUMN_WIDTH = BASE_TIME_CARD_WIDTH_PX;
const BASE_COLUMN_STEP = 256;

const GRANULARITY_LABELS: Record<TimelineGranularity, string> = {
  day: 'Daily',
  week: 'Weekly',
  month: 'Monthly',
  year: 'Yearly',
};

export const TimelineView: React.FC<TimelineViewProps> = ({
  photos,
  selectedIds,
  onToggleSelect,
  onSelectGroup,
  onOpenPhoto,
  spacingMode,
  onChangeSpacingMode,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 1280, height: 760 });

  // Horizontal-only pan and zoom state (y is strictly locked at 0)
  const [zoom, setZoom] = useState(1);

  // Compute active granularity ('day' | 'week' | 'month' | 'year') and resized time card dimensions
  const zoomMetrics = useMemo(
    () => getTimelineZoomMetrics(zoom, COLUMN_WIDTH, BASE_COLUMN_STEP),
    [zoom]
  );

  const columns: DayColumnGroup[] = useMemo(
    () =>
      buildTimelineDayColumns(
        photos,
        spacingMode,
        zoomMetrics.columnStepPx,
        zoomMetrics.granularity
      ),
    [photos, spacingMode, zoomMetrics.columnStepPx, zoomMetrics.granularity]
  );

  const totalTimelineWidth = useMemo(() => {
    if (columns.length === 0) return 0;
    return columns[columns.length - 1].xOffsetPx + zoomMetrics.columnWidthPx;
  }, [columns, zoomMetrics.columnWidthPx]);

  // Initialize horizontal pan centered on screen instead of left-aligned
  const [pan, setPan] = useState(() => ({
    x: computeCenteredTimelinePanX(totalTimelineWidth, 1280),
    y: 0,
  }));
  const hasUserPannedRef = useRef(false);
  const prevLayoutRef = useRef({
    timelineWidth: totalTimelineWidth,
    viewWidth: 1280,
  });

  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; panX: number; moved: boolean }>({
    x: 0,
    panX: 0,
    moved: false,
  });

  // Flow animation & string end fast-forward/backward hover state
  const [isFlowing, setIsFlowing] = useState(true);
  const [speedMultiplier, setSpeedMultiplier] = useState(1);
  const [hoveredDayKey, setHoveredDayKey] = useState<string | null>(null);
  const [hoveredPhotoId, setHoveredPhotoId] = useState<string | null>(null);
  const [hoveredStringEnd, setHoveredStringEnd] = useState<{
    dayKey: string;
    direction: Exclude<StringEndHoverDirection, null>;
  } | null>(null);

  const hoveredDayKeyRef = useRef<string | null>(null);
  const hoveredPhotoIdRef = useRef<string | null>(null);
  const hoveredStringEndRef = useRef<{
    dayKey: string;
    direction: Exclude<StringEndHoverDirection, null>;
  } | null>(null);
  hoveredDayKeyRef.current = hoveredDayKey;
  hoveredPhotoIdRef.current = hoveredPhotoId;
  hoveredStringEndRef.current = hoveredStringEnd;

  const columnPhasesRef = useRef<Record<string, number>>({});
  const [, setFrameTick] = useState(0);

  // Measure container
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateSize = () => {
      setViewportSize({
        width: el.clientWidth || 1280,
        height: el.clientHeight || 760,
      });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Re-center when photo collection changes
  useEffect(() => {
    hasUserPannedRef.current = false;
  }, [photos]);

  // Initialize deterministic staggered starting phase per column so strings feel alive immediately
  // while keeping photo #1 at the top of each column on initial load, and prune stale hover keys on granularity merge
  useEffect(() => {
    const activeDayKeys = new Set<string>();
    columns.forEach((col, idx) => {
      activeDayKeys.add(col.dayKey);
      if (columnPhasesRef.current[col.dayKey] === undefined) {
        columnPhasesRef.current[col.dayKey] = (idx * 23) % 72;
      }
    });

    if (hoveredDayKeyRef.current && !activeDayKeys.has(hoveredDayKeyRef.current)) {
      hoveredDayKeyRef.current = null;
      hoveredPhotoIdRef.current = null;
      setHoveredDayKey(null);
      setHoveredPhotoId(null);
    }
    if (hoveredStringEndRef.current && !activeDayKeys.has(hoveredStringEndRef.current.dayKey)) {
      hoveredStringEndRef.current = null;
      setHoveredStringEnd(null);
    }
  }, [columns]);

  // Helper to activate fast-forward ('forward' at bottom end) or fast-backward ('backward' at top end)
  const activateStringEndHover = useCallback(
    (col: DayColumnGroup, direction: Exclude<StringEndHoverDirection, null>) => {
      const prev = hoveredStringEndRef.current;
      const isNewActivation = !prev || prev.dayKey !== col.dayKey || prev.direction !== direction;
      hoveredStringEndRef.current = { dayKey: col.dayKey, direction };
      setHoveredStringEnd((curr) =>
        curr && curr.dayKey === col.dayKey && curr.direction === direction
          ? curr
          : { dayKey: col.dayKey, direction }
      );
      if (isNewActivation) {
        // Apply immediate frame step so fast-forward/backward is responsive right on hover entry
        const velocity = computeStringFlowVelocity(col.speedPxPerSec, speedMultiplier, {
          isFlowing,
          isColumnHovered: true,
          isPhotoHovered: false,
          endHoverDirection: direction,
        });
        columnPhasesRef.current[col.dayKey] =
          (columnPhasesRef.current[col.dayKey] || 0) + velocity * 0.05;
        setFrameTick((t) => (t + 1) % 1000000);
      }
    },
    [isFlowing, speedMultiplier]
  );

  const clearStringEndHover = useCallback((dayKey: string) => {
    if (hoveredStringEndRef.current?.dayKey === dayKey) {
      hoveredStringEndRef.current = null;
    }
    setHoveredStringEnd((curr) => (curr && curr.dayKey === dayKey ? null : curr));
  }, []);

  // Unified requestAnimationFrame loop for downward infinite flowing strings (and fast-forward/backward on end hover)
  useEffect(() => {
    if (!isFlowing && !hoveredStringEnd) return;
    let rafId = 0;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(0.064, Math.max(0, (now - lastTime) / 1000));
      lastTime = now;

      for (const col of columns) {
        const endDir =
          hoveredStringEndRef.current?.dayKey === col.dayKey
            ? hoveredStringEndRef.current.direction
            : null;
        const velocity = computeStringFlowVelocity(col.speedPxPerSec, speedMultiplier, {
          isFlowing,
          isColumnHovered: hoveredDayKeyRef.current === col.dayKey,
          isPhotoHovered: Boolean(hoveredPhotoIdRef.current),
          endHoverDirection: endDir,
        });
        const deltaPx = velocity * dt;
        columnPhasesRef.current[col.dayKey] = (columnPhasesRef.current[col.dayKey] || 0) + deltaPx;
      }

      setFrameTick((t) => (t + 1) % 1000000);
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isFlowing, speedMultiplier, columns, hoveredStringEnd]);

  // Center timeline on screen by default, and keep horizontal pan centered/clamped when columns merge or resize
  useEffect(() => {
    const prevLayout = prevLayoutRef.current;
    prevLayoutRef.current = {
      timelineWidth: totalTimelineWidth,
      viewWidth: viewportSize.width,
    };

    setPan((prev) => {
      let targetX: number;
      if (
        !hasUserPannedRef.current ||
        prevLayout.timelineWidth <= 0 ||
        totalTimelineWidth <= viewportSize.width - 96
      ) {
        targetX = computeCenteredTimelinePanX(totalTimelineWidth, viewportSize.width);
      } else {
        const prevCenterRatio =
          (prevLayout.viewWidth * 0.5 - prev.x) / Math.max(1, prevLayout.timelineWidth);
        targetX = viewportSize.width * 0.5 - prevCenterRatio * totalTimelineWidth;
      }
      const clampedX = clampTimelinePanX(targetX, totalTimelineWidth, viewportSize.width);
      if (clampedX === prev.x && prev.y === 0) return prev;
      return { x: clampedX, y: 0 };
    });
  }, [totalTimelineWidth, viewportSize.width]);

  // Center timeline on screen and align photo #1 at the top of each column when reset
  const handleResetView = useCallback(() => {
    const defaultMetrics = getTimelineZoomMetrics(1, COLUMN_WIDTH, BASE_COLUMN_STEP);
    const defaultCols = buildTimelineDayColumns(
      photos,
      spacingMode,
      defaultMetrics.columnStepPx,
      defaultMetrics.granularity
    );
    const defaultWidth =
      defaultCols.length > 0
        ? defaultCols[defaultCols.length - 1].xOffsetPx + defaultMetrics.columnWidthPx
        : 0;
    hasUserPannedRef.current = false;
    setZoom(1);
    setPan({
      x: computeCenteredTimelinePanX(defaultWidth, viewportSize.width),
      y: 0,
    });
    defaultCols.forEach((col, idx) => {
      columnPhasesRef.current[col.dayKey] = (idx * 16) % 48;
    });
    setFrameTick((t) => (t + 1) % 1000000);
  }, [photos, spacingMode, viewportSize.width]);

  // Non-passive wheel handler: horizontal scroll pans X; vertical wheel zooms in/out without moving time cards vertically
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-no-wheel-zoom="true"]')) {
        return;
      }
      e.preventDefault();

      // Support horizontal trackpad scroll if not holding ctrl/meta and deltaX is dominant
      if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        hasUserPannedRef.current = true;
        setPan((prev) => ({
          x: clampTimelinePanX(prev.x - e.deltaX, totalTimelineWidth, viewportSize.width),
          y: 0,
        }));
        return;
      }

      const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
      const nextZoom = Math.max(
        MIN_TIMELINE_ZOOM,
        Math.min(MAX_TIMELINE_ZOOM, Number((zoom * zoomFactor).toFixed(3)))
      );
      if (nextZoom === zoom) return;

      setZoom(nextZoom);
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoom, totalTimelineWidth, viewportSize.width]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-no-drag="true"]')) return;

    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      panX: pan.x,
      moved: false,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartRef.current.x;
    if (Math.abs(dx) > 4) {
      dragStartRef.current.moved = true;
      hasUserPannedRef.current = true;
    }
    setPan({
      x: clampTimelinePanX(
        dragStartRef.current.panX + dx,
        totalTimelineWidth,
        viewportSize.width
      ),
      y: 0,
    });
  };

  const handlePointerUp = () => {
    setIsDragging(false);
  };

  const jumpToColumn = (col: DayColumnGroup) => {
    hasUserPannedRef.current = true;
    const targetPanX =
      viewportSize.width * 0.5 - (col.xOffsetPx + zoomMetrics.columnWidthPx * 0.5);
    setPan({
      x: clampTimelinePanX(targetPanX, totalTimelineWidth, viewportSize.width),
      y: 0,
    });
  };

  // Visible height of each vertical string below its resized time card
  const stringViewportHeight = useMemo(() => {
    return Math.max(320, viewportSize.height - 160 - zoomMetrics.cardHeightPx);
  }, [viewportSize.height, zoomMetrics.cardHeightPx]);

  if (photos.length === 0) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center text-slate-400">
        <FolderOpen className="mb-3 h-12 w-12 text-slate-600" />
        <p className="text-lg font-medium text-slate-300">No photos in current folder</p>
        <p className="mt-1 text-sm text-slate-500">Choose another folder or load the built-in demo album.</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      className={`relative h-full w-full overflow-hidden select-none ${
        isDragging ? 'cursor-grabbing' : 'cursor-grab'
      }`}
      data-testid="timeline-canvas"
      data-granularity={zoomMetrics.granularity}
    >
      {/* Subtle Ambient Background Grid & Glow (moves horizontally only) */}
      <div
        className="pointer-events-none absolute inset-0 opacity-25"
        style={{
          backgroundImage:
            'radial-gradient(circle at 1px 1px, rgba(148, 163, 184, 0.24) 1px, transparent 0)',
          backgroundSize: `${Math.max(16, Math.round(32 * zoomMetrics.cardScale))}px ${Math.max(16, Math.round(32 * zoomMetrics.cardScale))}px`,
          backgroundPosition: `${Math.round(pan.x)}px 0px`,
        }}
      />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-slate-950/90 via-slate-950/40 to-transparent z-10" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-36 bg-gradient-to-t from-slate-950 via-slate-950/60 to-transparent z-10" />

      {/* Top Overlay Row: Orientation Legend (Left) + Timeline Controls Toolbar (Right) */}
      <div className="pointer-events-none absolute inset-x-5 top-3.5 z-20 flex flex-wrap items-center justify-between gap-2">
        {/* Top-Left Timeline Orientation Legend */}
        <div
          data-no-drag="true"
          className="pointer-events-auto flex items-center gap-2.5 rounded-xl border border-slate-800/80 bg-slate-900/85 px-3 py-1.5 text-xs text-slate-300 backdrop-blur-md shadow-lg"
        >
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-sky-400 shadow-[0_0_8px_#38bdf8]" />
            <span className="font-medium text-slate-200">Timeline:</span>
            <span className="text-slate-400">Oldest (L) → Newest (R)</span>
          </div>
          <span className="text-slate-700">|</span>
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />
            <span className="font-medium text-slate-200">Strings:</span>
            <span className="text-slate-400">Oldest (Top) → Newest (Bottom) • ↓ Loop</span>
          </div>
        </div>

        {/* Top-Right Timeline Controls Toolbar */}
        <div
          data-no-drag="true"
          className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-xl border border-slate-800/80 bg-slate-900/85 p-1.5 backdrop-blur-md shadow-xl"
        >
          {/* Spacing Mode Toggle: Compact vs Proportional */}
          <div className="flex items-center rounded-lg bg-slate-950/80 p-0.5 border border-slate-800/70">
            <button
              type="button"
              onClick={() => onChangeSpacingMode('compact')}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
                spacingMode === 'compact'
                  ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Space active photo strings evenly"
              data-testid="spacing-compact-btn"
            >
              <Columns3 className="h-3.5 w-3.5" />
              Compact
            </button>
            <button
              type="button"
              onClick={() => onChangeSpacingMode('proportional')}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
                spacingMode === 'proportional'
                  ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Scale horizontal gaps proportionally to calendar distance between strings"
              data-testid="spacing-proportional-btn"
            >
              <CalendarRange className="h-3.5 w-3.5" />
              Proportional Gaps
            </button>
          </div>

          <div className="h-5 w-px bg-slate-800" />

          {/* Flow Play/Pause & Speed Control */}
          <button
            type="button"
            onClick={() => setIsFlowing((f) => !f)}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition border ${
              isFlowing
                ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
                : 'border-amber-500/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25'
            }`}
            data-testid="toggle-flow-btn"
          >
            {isFlowing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {isFlowing ? 'Flowing' : 'Paused'}
          </button>

          <div className="flex items-center gap-1.5 px-2 text-xs text-slate-400" title="String downward flow speed">
            <Gauge className="h-3.5 w-3.5 text-sky-400" />
            <input
              type="range"
              min="0.25"
              max="2.5"
              step="0.25"
              value={speedMultiplier}
              onChange={(e) => setSpeedMultiplier(Number(e.target.value))}
              className="h-1.5 w-16 cursor-pointer accent-sky-400"
              aria-label="Flow speed multiplier"
            />
            <span className="w-8 font-mono text-[11px] text-slate-300">{speedMultiplier.toFixed(1)}x</span>
          </div>

          <div className="h-5 w-px bg-slate-800" />

          {/* Active String Granularity Badge (Daily -> Weekly -> Monthly -> Yearly) */}
          <span
            className={`rounded-lg border px-2 py-1 text-[11px] font-semibold transition ${
              zoomMetrics.granularity === 'day'
                ? 'border-slate-700/80 bg-slate-800/70 text-slate-300'
                : 'border-sky-500/50 bg-sky-500/15 text-sky-300 shadow-[0_0_12px_rgba(56,189,248,0.2)]'
            }`}
            title="Strings automatically merge from Daily to Weekly, Monthly, and Yearly when zoomed out"
            data-testid="timeline-granularity-badge"
            data-granularity={zoomMetrics.granularity}
          >
            {GRANULARITY_LABELS[zoomMetrics.granularity]} Strings ({columns.length})
          </span>

          {/* Zoom Controls */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() =>
                setZoom((z) => Math.max(MIN_TIMELINE_ZOOM, Number((z - 0.15).toFixed(2))))
              }
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition"
              title="Zoom Out"
              data-testid="timeline-zoom-out"
            >
              <ZoomOut className="h-4 w-4" />
            </button>
            <span
              className="min-w-[46px] text-center font-mono text-xs text-slate-300"
              data-testid="timeline-zoom-level"
            >
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() =>
                setZoom((z) => Math.min(MAX_TIMELINE_ZOOM, Number((z + 0.15).toFixed(2))))
              }
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition"
              title="Zoom In"
              data-testid="timeline-zoom-in"
            >
              <ZoomIn className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={handleResetView}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition"
              title="Reset Zoom & Pan"
              data-testid="timeline-reset-view"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Horizontal-Only Panned Canvas (pan.y is locked at 0; time cards stay at top and resize) */}
      <div
        className="absolute left-0 top-16 origin-top-left will-change-transform"
        style={{
          transform: `translate3d(${pan.x}px, 0px, 0)`,
        }}
        data-testid="timeline-transform-layer"
        data-pan-x={pan.x}
        data-pan-y={0}
        data-zoom={zoom}
        data-granularity={zoomMetrics.granularity}
      >
        {/* Horizontal Timeline Axis Beam connecting all Time Cards */}
        {columns.length > 0 && (
          <div
            className="pointer-events-none absolute h-[2px] bg-gradient-to-r from-sky-500/30 via-sky-400/70 to-indigo-500/40"
            style={{
              top: Math.round(zoomMetrics.cardHeightPx * 0.5),
              left: 0,
              width: totalTimelineWidth,
            }}
          />
        )}

        {/* Timeline Columns ("Vertical Strings") */}
        <div
          className="relative"
          style={{
            width: totalTimelineWidth,
            height: stringViewportHeight + zoomMetrics.cardHeightPx + 36,
          }}
        >
          {columns.map((col, colIndex) => {
            const phaseOffset = columnPhasesRef.current[col.dayKey] || 0;
            const { items: virtualItems } = buildVirtualStringItems(
              col.photos,
              stringViewportHeight,
              zoomMetrics.cardSlotHeightPx
            );
            const activeEndDirection =
              hoveredStringEnd?.dayKey === col.dayKey ? hoveredStringEnd.direction : null;
            const activeVelocity = computeStringFlowVelocity(col.speedPxPerSec, speedMultiplier, {
              isFlowing,
              isColumnHovered: hoveredDayKey === col.dayKey,
              isPhotoHovered: Boolean(hoveredPhotoId),
              endHoverDirection: activeEndDirection,
            });
            const flowMode =
              activeEndDirection === 'backward'
                ? 'fast-backward'
                : activeEndDirection === 'forward'
                  ? 'fast-forward'
                  : hoveredDayKey === col.dayKey
                    ? 'slow'
                    : isFlowing
                      ? 'normal'
                      : 'paused';
            const pulseOffsetPx =
              (((phaseOffset * 1.4) % stringViewportHeight) + stringViewportHeight) %
              stringViewportHeight;

            const allSelectedInDay =
              col.photos.length > 0 && col.photos.every((p) => selectedIds.has(p.id));
            const someSelectedInDay = col.photos.some((p) => selectedIds.has(p.id));
            const prevCol = colIndex > 0 ? columns[colIndex - 1] : null;
            const gapWidth = prevCol
              ? col.xOffsetPx - (prevCol.xOffsetPx + zoomMetrics.columnWidthPx)
              : 0;

            return (
              <React.Fragment key={col.dayKey}>
                {/* Proportional Time Gap Badge between columns */}
                {prevCol && col.gapLabel && gapWidth >= 44 && (
                  <div
                    className="pointer-events-none absolute flex items-center justify-center"
                    style={{
                      top: Math.max(4, Math.round(zoomMetrics.cardHeightPx * 0.5 - 11)),
                      left: prevCol.xOffsetPx + zoomMetrics.columnWidthPx,
                      width: gapWidth,
                    }}
                  >
                    <span className="rounded-full border border-slate-800 bg-slate-950/90 px-2.5 py-0.5 font-mono text-[10px] text-slate-400 shadow">
                      {col.gapLabel}
                    </span>
                  </div>
                )}

                <div
                  className="absolute top-0 flex flex-col items-center"
                  style={{
                    left: col.xOffsetPx,
                    width: zoomMetrics.columnWidthPx,
                  }}
                  onMouseEnter={() => setHoveredDayKey(col.dayKey)}
                  onMouseLeave={() => {
                    setHoveredDayKey(null);
                    setHoveredPhotoId(null);
                    clearStringEndHover(col.dayKey);
                  }}
                  data-testid={`timeline-day-column-${col.dayKey}`}
                  data-day-key={col.dayKey}
                  data-granularity={zoomMetrics.granularity}
                  data-card-slot-height={zoomMetrics.cardSlotHeightPx}
                  data-speed={col.speedPxPerSec}
                  data-flow-mode={flowMode}
                  data-flow-velocity={Number(activeVelocity.toFixed(2))}
                  data-phase={Number(phaseOffset.toFixed(2))}
                >
                  {/* Column Time Card on top of the string (resizes in place without moving vertically) */}
                  <div
                    data-no-drag="true"
                    data-testid={`timeline-time-card-${col.dayKey}`}
                    data-card-width={zoomMetrics.columnWidthPx}
                    data-card-height={zoomMetrics.cardHeightPx}
                    className="relative z-10 shrink-0 overflow-hidden"
                    style={{
                      width: zoomMetrics.columnWidthPx,
                      height: zoomMetrics.cardHeightPx,
                    }}
                  >
                    <div
                      style={{
                        width: COLUMN_WIDTH,
                        height: BASE_TIME_CARD_HEIGHT_PX,
                        transform: `scale(${zoomMetrics.cardScale})`,
                        transformOrigin: 'top left',
                      }}
                      className={`group flex items-center justify-between rounded-xl border px-3 py-2 backdrop-blur-md transition-colors ${
                        allSelectedInDay
                          ? 'border-sky-400/80 bg-sky-950/80 shadow-[0_0_20px_rgba(56,189,248,0.25)]'
                          : someSelectedInDay
                            ? 'border-sky-500/50 bg-slate-900/90'
                            : 'border-slate-800/90 bg-slate-900/85 hover:border-slate-700'
                      }`}
                    >
                      <div className="min-w-0 pr-1.5">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-xs font-semibold tracking-tight text-slate-100">
                            {col.displayDate}
                          </span>
                          <span className="shrink-0 rounded-md bg-slate-800/90 px-1.5 py-0.5 font-mono text-[10px] font-medium text-sky-300">
                            {col.photos.length}
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-400">
                          <span className="truncate">{col.weekday}</span>
                          <span>•</span>
                          <span
                            className={`shrink-0 font-mono ${
                              activeEndDirection === 'backward'
                                ? 'text-amber-300 font-semibold'
                                : activeEndDirection === 'forward'
                                  ? 'text-sky-300 font-semibold'
                                  : 'text-slate-500'
                            }`}
                            title="String flow speed"
                          >
                            {activeEndDirection === 'backward'
                              ? `↑↑ ${Math.abs(Math.round(activeVelocity))}px/s`
                              : activeEndDirection === 'forward'
                                ? `↓↓ ${Math.abs(Math.round(activeVelocity))}px/s`
                                : `↓ ${col.speedPxPerSec}px/s`}
                          </span>
                        </div>
                      </div>

                      {/* Select entire string bucket button */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectGroup(
                            col.photos.map((p) => p.id),
                            !allSelectedInDay
                          );
                        }}
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border transition ${
                          allSelectedInDay
                            ? 'border-sky-400 bg-sky-500 text-slate-950'
                            : 'border-slate-700 bg-slate-800/70 text-slate-400 hover:border-sky-400/60 hover:text-sky-300'
                        }`}
                        title={
                          allSelectedInDay
                            ? 'Deselect all photos in this string'
                            : 'Select all photos in this string'
                        }
                        data-testid={`select-day-${col.dayKey}`}
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Top String Anchor Node (hover to fast-backward / rewind string upwards) */}
                  <div
                    data-no-drag="true"
                    onMouseEnter={() => activateStringEndHover(col, 'backward')}
                    onMouseLeave={() => clearStringEndHover(col.dayKey)}
                    className="relative z-20 my-1 flex cursor-ns-resize flex-col items-center"
                    title="Hover top end of string to fast-backward (↑)"
                  >
                    <div
                      className={`h-2.5 w-2.5 rounded-full border transition-all ${
                        activeEndDirection === 'backward'
                          ? 'scale-125 border-amber-300 bg-amber-400/70 shadow-[0_0_14px_#fbbf24]'
                          : 'border-sky-400/80 bg-sky-400/30 shadow-[0_0_10px_#38bdf8]'
                      }`}
                    />
                  </div>

                  {/* Vertical Flowing String Viewport with Smooth Top & Bottom Gradient Mask */}
                  <div
                    className="relative w-full overflow-hidden"
                    style={{
                      height: stringViewportHeight,
                      WebkitMaskImage:
                        'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.96) 11%, rgba(0,0,0,0.96) 89%, transparent 100%)',
                      maskImage:
                        'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.96) 11%, rgba(0,0,0,0.96) 89%, transparent 100%)',
                    }}
                    data-testid={`timeline-string-viewport-${col.dayKey}`}
                    onMouseMove={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const offsetY = e.clientY - rect.top;
                      const dir = resolveStringEndHoverDirection(
                        offsetY,
                        stringViewportHeight,
                        STRING_END_ZONE_HEIGHT_PX
                      );
                      if (dir) {
                        activateStringEndHover(col, dir);
                      } else {
                        clearStringEndHover(col.dayKey);
                      }
                    }}
                  >
                    {/* Top End of String Hover Zone: Fast Backward (Rewind ↑) */}
                    <div
                      data-no-drag="true"
                      data-testid={`string-top-end-${col.dayKey}`}
                      data-direction="backward"
                      onMouseEnter={() => activateStringEndHover(col, 'backward')}
                      onMouseLeave={() => clearStringEndHover(col.dayKey)}
                      style={{ height: STRING_END_ZONE_HEIGHT_PX }}
                      className={`group/topend absolute inset-x-0 top-0 z-30 flex cursor-ns-resize items-start justify-center pt-1.5 transition-opacity ${
                        activeEndDirection === 'backward'
                          ? 'opacity-100'
                          : 'opacity-0 hover:opacity-100 group-hover:opacity-80'
                      }`}
                      title="Hover top end to fast-backward string (↑)"
                    >
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium backdrop-blur-md transition ${
                          activeEndDirection === 'backward'
                            ? 'border-amber-400/80 bg-amber-950/90 text-amber-200 shadow-[0_0_15px_rgba(251,191,36,0.35)]'
                            : 'border-slate-700/80 bg-slate-900/80 text-slate-300'
                        }`}
                      >
                        <ChevronsUp className="h-3 w-3 text-amber-300 animate-pulse" />
                        <span>Fast Backward</span>
                      </span>
                    </div>

                    {/* Bottom End of String Hover Zone: Fast Forward (Advance ↓) */}
                    <div
                      data-no-drag="true"
                      data-testid={`string-bottom-end-${col.dayKey}`}
                      data-direction="forward"
                      onMouseEnter={() => activateStringEndHover(col, 'forward')}
                      onMouseLeave={() => clearStringEndHover(col.dayKey)}
                      style={{ height: STRING_END_ZONE_HEIGHT_PX }}
                      className={`group/bottomend absolute inset-x-0 bottom-0 z-30 flex cursor-ns-resize items-end justify-center pb-1.5 transition-opacity ${
                        activeEndDirection === 'forward'
                          ? 'opacity-100'
                          : 'opacity-0 hover:opacity-100 group-hover:opacity-80'
                      }`}
                      title="Hover bottom end to fast-forward string (↓)"
                    >
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium backdrop-blur-md transition ${
                          activeEndDirection === 'forward'
                            ? 'border-sky-400/80 bg-sky-950/90 text-sky-200 shadow-[0_0_15px_rgba(56,189,248,0.35)]'
                            : 'border-slate-700/80 bg-slate-900/80 text-slate-300'
                        }`}
                      >
                        <ChevronsDown className="h-3 w-3 text-sky-300 animate-pulse" />
                        <span>Fast Forward</span>
                      </span>
                    </div>

                    {/* Glowing Central Vertical String Filament */}
                    <div className="pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 w-[2px] bg-gradient-to-b from-sky-400/20 via-sky-400/65 to-indigo-400/20 shadow-[0_0_12px_rgba(56,189,248,0.45)]" />

                    {/* Animated Pulse Beads along the String */}
                    <div
                      className="pointer-events-none absolute left-1/2 -translate-x-1/2 h-16 w-[3px] rounded-full bg-gradient-to-b from-transparent via-sky-300 to-transparent opacity-75"
                      style={{
                        transform: `translate3d(-50%, ${pulseOffsetPx}px, 0)`,
                      }}
                    />

                    {/* Photo Cards Flowing Along the String */}
                    {virtualItems.map((vItem) => {
                      const state = computeFlowingCardState(
                        vItem.virtualIndex,
                        virtualItems.length,
                        phaseOffset,
                        stringViewportHeight,
                        zoomMetrics.cardSlotHeightPx
                      );
                      if (!state.isVisible) return null;

                      const { photo } = vItem;
                      const isSelected = selectedIds.has(photo.id);
                      const { timeLabel } = getWallClockParts(photo.timestamp);
                      const cardTimeDisplay =
                        zoomMetrics.granularity === 'day'
                          ? timeLabel
                          : `${formatWallClockDate(photo.timestamp).replace(/, \d{4}$/, '')} • ${timeLabel}`;

                      return (
                        <div
                          key={`${col.dayKey}-v${vItem.virtualIndex}-${photo.id}`}
                          data-no-drag="true"
                          data-testid={`timeline-photo-card-${photo.id}`}
                          data-photo-index={vItem.photoIndex}
                          onMouseEnter={() => setHoveredPhotoId(photo.id)}
                          onMouseLeave={() => setHoveredPhotoId(null)}
                          onClick={(e) => {
                            if (dragStartRef.current.moved) return;
                            if (e.shiftKey || e.metaKey || e.ctrlKey) {
                              onToggleSelect(photo.id, e);
                            } else {
                              onOpenPhoto(photo);
                            }
                          }}
                          className="group/card absolute left-2 right-2 cursor-pointer will-change-transform"
                          style={{
                            height: Math.max(88, zoomMetrics.cardSlotHeightPx - 16),
                            transform: `translate3d(0, ${state.y}px, 0) scale(${state.scale})`,
                            opacity: state.opacity,
                          }}
                        >
                          {/* String Attachment Clasp */}
                          <div className="pointer-events-none absolute -top-1.5 left-1/2 z-20 h-3 w-3 -translate-x-1/2 rounded-full border-2 border-sky-300 bg-slate-950 shadow-[0_0_8px_#38bdf8]" />

                          <div
                            className={`relative h-full w-full overflow-hidden rounded-xl border transition-all duration-200 ${
                              isSelected
                                ? 'border-sky-400 ring-2 ring-sky-400/50 shadow-[0_8px_25px_rgba(56,189,248,0.3)]'
                                : 'border-slate-700/80 bg-slate-900/90 hover:border-sky-400/60 hover:shadow-[0_10px_28px_rgba(15,23,42,0.85)]'
                            }`}
                          >
                            {/* Photo Thumbnail */}
                            <img
                              src={photo.url}
                              alt={photo.fileName}
                              loading="lazy"
                              draggable={false}
                              className="h-full w-full object-cover transition-transform duration-300 group-hover/card:scale-105"
                            />

                            {/* Subtle Top & Bottom Legibility Gradient */}
                            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-slate-950/90 via-slate-950/15 to-slate-950/45" />

                            {/* Top Row: Selection Checkbox & Order Badge */}
                            <div className="absolute inset-x-2 top-2 flex items-center justify-between">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onToggleSelect(photo.id, e);
                                }}
                                className={`flex h-6 w-6 items-center justify-center rounded-md border backdrop-blur-md transition ${
                                  isSelected
                                    ? 'border-sky-300 bg-sky-500 text-slate-950 shadow-sm'
                                    : 'border-white/30 bg-slate-950/55 text-transparent opacity-85 group-hover/card:opacity-100 hover:border-sky-300'
                                }`}
                                title={isSelected ? 'Deselect photo' : 'Select photo for batch edit'}
                                data-testid={`select-photo-${photo.id}`}
                              >
                                <Check className="h-3.5 w-3.5" />
                              </button>

                              <div className="flex items-center gap-1">
                                {photo.isEdited && (
                                  <span
                                    className="flex items-center gap-0.5 rounded-full bg-amber-500/90 px-1.5 py-0.5 text-[9px] font-semibold text-slate-950 shadow"
                                    title="Metadata edited in MyAlbum"
                                  >
                                    <Sparkles className="h-2.5 w-2.5" />
                                    Edited
                                  </span>
                                )}
                                <span className="rounded-md bg-slate-950/75 px-1.5 py-0.5 font-mono text-[10px] font-medium text-sky-200 backdrop-blur-sm border border-white/10">
                                  #{vItem.photoIndex + 1}/{col.photos.length}
                                </span>
                              </div>
                            </div>

                            {/* Bottom Info Overlay: Time of day, filename & GPS pin indicator */}
                            <div className="absolute inset-x-2.5 bottom-2 flex items-end justify-between gap-1.5">
                              <div className="min-w-0">
                                <div className="flex items-center gap-1 font-mono text-xs font-semibold text-white drop-shadow">
                                  <Clock className="h-3 w-3 text-sky-400 shrink-0" />
                                  <span className="truncate">{cardTimeDisplay}</span>
                                </div>
                                <p className="truncate text-[10px] text-slate-300/90">{photo.fileName}</p>
                              </div>

                              {photo.location && (
                                <span
                                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/25 border border-emerald-400/50 text-emerald-300"
                                  title={photo.location.name || `${photo.location.lat}, ${photo.location.lng}`}
                                >
                                  <MapPin className="h-2.5 w-2.5" />
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Bottom String Anchor Termination Node (hover to fast-forward string downwards) */}
                  <div
                    data-no-drag="true"
                    onMouseEnter={() => activateStringEndHover(col, 'forward')}
                    onMouseLeave={() => clearStringEndHover(col.dayKey)}
                    className="relative z-20 mt-1 flex cursor-ns-resize flex-col items-center"
                    title="Hover bottom end of string to fast-forward (↓)"
                  >
                    <div
                      className={`h-2 w-2 rounded-full border transition-all ${
                        activeEndDirection === 'forward'
                          ? 'scale-125 border-sky-300 bg-sky-400/70 shadow-[0_0_14px_#38bdf8]'
                          : 'border-indigo-400/70 bg-indigo-400/30 shadow-[0_0_8px_#818cf8]'
                      }`}
                    />
                  </div>
                </div>
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* Bottom Chronological Quick-Jump Scrubber Bar */}
      <div
        data-no-drag="true"
        data-no-wheel-zoom="true"
        className="absolute bottom-4 left-1/2 z-20 flex max-w-[92vw] -translate-x-1/2 items-center gap-1.5 overflow-x-auto rounded-2xl border border-slate-800/90 bg-slate-900/85 px-3 py-2 backdrop-blur-md shadow-2xl"
        data-testid="timeline-minimap"
      >
        <span className="mr-1.5 text-[11px] font-medium text-slate-400 shrink-0">
          Jump to {GRANULARITY_LABELS[zoomMetrics.granularity]}:
        </span>
        {columns.map((col) => {
          const hasSelected = col.photos.some((p) => selectedIds.has(p.id));
          return (
            <button
              key={col.dayKey}
              type="button"
              onClick={() => jumpToColumn(col)}
              className={`group flex flex-col items-center rounded-lg border px-2.5 py-1 transition shrink-0 ${
                hasSelected
                  ? 'border-sky-400/60 bg-sky-500/15 text-sky-200'
                  : 'border-slate-800 bg-slate-950/70 text-slate-300 hover:border-slate-700 hover:bg-slate-800/80'
              }`}
              title={`Jump to ${col.displayDate} (${col.photos.length} photos)`}
            >
              <span className="font-mono text-[10px] font-semibold">
                {zoomMetrics.granularity === 'day'
                  ? col.displayDate.replace(/, \d{4}$/, '')
                  : col.displayDate}
              </span>
              <span className="text-[9px] text-slate-500 group-hover:text-sky-300">
                {col.photos.length} photos
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
