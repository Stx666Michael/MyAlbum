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
  SlidersHorizontal,
} from 'lucide-react';
import type { PhotoItem } from '../types/photo.ts';
import {
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
  computeStringGranularityTransition,
  computeSwipeVelocityBoost,
  decayStringSwipeMomentum,
  formatWallClockDate,
  getTimelineZoomMetrics,
  getWallClockParts,
  resolveStringEndHoverDirection,
  type DayColumnGroup,
  type StringEndHoverDirection,
  type StringGranularityTransition,
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
const STRING_MERGE_TRANSITION_MS = 380;

interface ActiveGranularityTransition extends StringGranularityTransition {
  id: number;
  prevGranularity: TimelineGranularity;
  nextGranularity: TimelineGranularity;
  prevColumns: DayColumnGroup[];
  prevColumnWidthPx: number;
  prevCardHeightPx: number;
  prevCardSlotHeightPx: number;
  prevCardScale: number;
  prevPhases: Record<string, number>;
}

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
  const [isSettingsHovered, setIsSettingsHovered] = useState(false);
  const [hoveredDayKey, setHoveredDayKey] = useState<string | null>(null);
  const [hoveredPhotoId, setHoveredPhotoId] = useState<string | null>(null);
  const [hoveredStringEnd, setHoveredStringEnd] = useState<{
    dayKey: string;
    direction: Exclude<StringEndHoverDirection, null>;
  } | null>(null);

  const speedMultiplierRef = useRef<number>(1);
  const columnsRef = useRef<DayColumnGroup[]>(columns);
  const speedSliderRef = useRef<HTMLInputElement | null>(null);
  const hoveredDayKeyRef = useRef<string | null>(null);
  const hoveredPhotoIdRef = useRef<string | null>(null);
  const hoveredStringEndRef = useRef<{
    dayKey: string;
    direction: Exclude<StringEndHoverDirection, null>;
  } | null>(null);
  speedMultiplierRef.current = speedMultiplier;
  columnsRef.current = columns;
  hoveredDayKeyRef.current = hoveredDayKey;
  hoveredPhotoIdRef.current = hoveredPhotoId;
  hoveredStringEndRef.current = hoveredStringEnd;

  const columnPhasesRef = useRef<Record<string, number>>({});
  const stringSwipeRef = useRef<{
    dayKey: string;
    startX: number;
    startY: number;
    lastY: number;
    lastTime: number;
    active: boolean;
  } | null>(null);
  const stringMomentumRef = useRef<Record<string, number>>({});
  const [hasActiveMomentum, setHasActiveMomentum] = useState(false);
  const [, setFrameTick] = useState(0);

  // Track previous granularity & columns for smooth merge/unmerge animations
  const prevGranularityRef = useRef<{
    photos: PhotoItem[];
    granularity: TimelineGranularity;
    columns: DayColumnGroup[];
    columnWidthPx: number;
    cardHeightPx: number;
    cardSlotHeightPx: number;
    cardScale: number;
  }>({
    photos,
    granularity: zoomMetrics.granularity,
    columns,
    columnWidthPx: zoomMetrics.columnWidthPx,
    cardHeightPx: zoomMetrics.cardHeightPx,
    cardSlotHeightPx: zoomMetrics.cardSlotHeightPx,
    cardScale: zoomMetrics.cardScale,
  });
  const transitionSeqRef = useRef(0);
  const transitionTimerRef = useRef<number | null>(null);
  const activeTransitionRef = useRef<ActiveGranularityTransition | null>(null);

  // Synchronously detect granularity transitions and seed/initialize column phases during render
  // so the very first frame of a merge/unmerge has FLIP offsets, ghost strings, and continuous phases
  const prevSnapshot = prevGranularityRef.current;
  if (prevSnapshot.photos !== photos) {
    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }
    activeTransitionRef.current = null;
    columnPhasesRef.current = {};
    stringMomentumRef.current = {};
    stringSwipeRef.current = null;
  } else if (prevSnapshot.granularity !== zoomMetrics.granularity) {
    const prevPhasesSnapshot = { ...columnPhasesRef.current };
    const prevMomentumSnapshot = { ...stringMomentumRef.current };
    const transition = computeStringGranularityTransition(
      prevSnapshot.columns,
      columns,
      prevSnapshot.granularity,
      zoomMetrics.granularity
    );

    // Phase & swipe momentum continuity: seed uninitialized nextCol phases and active momentum from matching sourceKeys
    for (const col of columns) {
      const entering = transition.enteringByKey[col.dayKey];
      if (entering && entering.sourceKeys.length > 0) {
        if (columnPhasesRef.current[col.dayKey] === undefined) {
          const sourcePhases = entering.sourceKeys
            .map((k) => prevPhasesSnapshot[k])
            .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
          if (sourcePhases.length > 0) {
            const avgPhase =
              sourcePhases.reduce((sum, p) => sum + p, 0) / sourcePhases.length;
            columnPhasesRef.current[col.dayKey] = Number(avgPhase.toFixed(2));
          }
        }
        if (stringMomentumRef.current[col.dayKey] === undefined) {
          const sourceBoosts = entering.sourceKeys
            .map((k) => prevMomentumSnapshot[k])
            .filter(
              (v): v is number =>
                typeof v === 'number' && Number.isFinite(v) && Math.abs(v) >= 1.5
            );
          if (sourceBoosts.length > 0) {
            const avgBoost =
              sourceBoosts.reduce((sum, b) => sum + b, 0) / sourceBoosts.length;
            if (Math.abs(avgBoost) >= 1.5) {
              stringMomentumRef.current[col.dayKey] = Number(avgBoost.toFixed(2));
            }
          }
        }
      }
    }

    // Prune phases and momentum from the previous granularity so subsequent unmerges/merges seed fresh phases
    const nextKeySet = new Set(columns.map((c) => c.dayKey));
    for (const existingKey of Object.keys(columnPhasesRef.current)) {
      if (!nextKeySet.has(existingKey)) {
        delete columnPhasesRef.current[existingKey];
      }
    }
    for (const existingKey of Object.keys(stringMomentumRef.current)) {
      if (!nextKeySet.has(existingKey)) {
        delete stringMomentumRef.current[existingKey];
      }
    }
    if (stringSwipeRef.current && !nextKeySet.has(stringSwipeRef.current.dayKey)) {
      stringSwipeRef.current = null;
    }

    if (transition.mode) {
      transitionSeqRef.current += 1;
      activeTransitionRef.current = {
        ...transition,
        id: transitionSeqRef.current,
        prevGranularity: prevSnapshot.granularity,
        nextGranularity: zoomMetrics.granularity,
        prevColumns: prevSnapshot.columns,
        prevColumnWidthPx: prevSnapshot.columnWidthPx,
        prevCardHeightPx: prevSnapshot.cardHeightPx,
        prevCardSlotHeightPx: prevSnapshot.cardSlotHeightPx,
        prevCardScale: prevSnapshot.cardScale,
        prevPhases: prevPhasesSnapshot,
      };
    } else {
      activeTransitionRef.current = null;
    }
  } else if (
    activeTransitionRef.current &&
    prevSnapshot.columns !== columns
  ) {
    // Keep active FLIP/ghost deltas aligned if spacingMode or intra-granularity zoom changes mid-transition
    const updatedTransition = computeStringGranularityTransition(
      activeTransitionRef.current.prevColumns,
      columns,
      activeTransitionRef.current.prevGranularity,
      zoomMetrics.granularity
    );
    activeTransitionRef.current = {
      ...activeTransitionRef.current,
      enteringByKey: updatedTransition.enteringByKey,
      exitingGhosts: updatedTransition.exitingGhosts,
    };
  }

  // Ensure every active column has a deterministic initial phase before rendering
  columns.forEach((col, idx) => {
    if (columnPhasesRef.current[col.dayKey] === undefined) {
      columnPhasesRef.current[col.dayKey] = (idx * 23) % 72;
    }
  });

  prevGranularityRef.current = {
    photos,
    granularity: zoomMetrics.granularity,
    columns,
    columnWidthPx: zoomMetrics.columnWidthPx,
    cardHeightPx: zoomMetrics.cardHeightPx,
    cardSlotHeightPx: zoomMetrics.cardSlotHeightPx,
    cardScale: zoomMetrics.cardScale,
  };

  const activeTransition = activeTransitionRef.current;
  const activeTransitionId = activeTransition?.id ?? 0;

  // Auto-clear the merge/unmerge transition & ghost strings layer after STRING_MERGE_TRANSITION_MS
  useEffect(() => {
    if (!activeTransitionId) return;
    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current);
    }
    transitionTimerRef.current = window.setTimeout(() => {
      if (activeTransitionRef.current?.id === activeTransitionId) {
        activeTransitionRef.current = null;
        setFrameTick((t) => (t + 1) % 1000000);
      }
      transitionTimerRef.current = null;
    }, STRING_MERGE_TRANSITION_MS);

    return () => {
      if (transitionTimerRef.current !== null) {
        window.clearTimeout(transitionTimerRef.current);
        transitionTimerRef.current = null;
      }
    };
  }, [activeTransitionId]);

  const applySpeedMultiplier = useCallback((rawValue: number) => {
    if (!Number.isFinite(rawValue)) return;
    const nextSpeed = Math.max(0.25, Math.min(2.5, Number(rawValue.toFixed(2))));
    speedMultiplierRef.current = nextSpeed;
    setSpeedMultiplier(nextSpeed);
  }, []);

  // Ensure native input/change events on the range slider always update speedMultiplier (including direct DOM value updates)
  useEffect(() => {
    const el = speedSliderRef.current;
    if (!el) return;
    const onSliderEvent = (e: Event) => {
      const target = e.currentTarget as HTMLInputElement | null;
      if (!target) return;
      applySpeedMultiplier(Number(target.value));
    };
    el.addEventListener('input', onSliderEvent);
    el.addEventListener('change', onSliderEvent);
    return () => {
      el.removeEventListener('input', onSliderEvent);
      el.removeEventListener('change', onSliderEvent);
    };
  }, [applySpeedMultiplier, photos.length]);

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

  // Prune stale hover keys when active column keys change across granularity transitions
  useEffect(() => {
    const activeDayKeys = new Set(columns.map((c) => c.dayKey));
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
      if (
        stringSwipeRef.current?.active ||
        Math.abs(stringMomentumRef.current[col.dayKey] || 0) >= 1.5
      ) {
        return;
      }
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
        const velocity = computeStringFlowVelocity(col.speedPxPerSec, speedMultiplierRef.current, {
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
    [isFlowing]
  );

  const clearStringEndHover = useCallback((dayKey: string) => {
    if (hoveredStringEndRef.current?.dayKey === dayKey) {
      hoveredStringEndRef.current = null;
    }
    setHoveredStringEnd((curr) => (curr && curr.dayKey === dayKey ? null : curr));
  }, []);

  // Unified requestAnimationFrame loop for downward infinite flowing strings (plus end hover and smooth swipe momentum decay)
  useEffect(() => {
    if (!isFlowing && !hoveredStringEnd && !hasActiveMomentum) return;
    let rafId = 0;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const rawDt = (now - lastTime) / 1000;
      const dt = rawDt > 0.001 ? Math.min(0.12, rawDt) : 0.05;
      lastTime = now;

      const currentCols = columnsRef.current;
      const currentSpeedMultiplier = speedMultiplierRef.current;
      let stillHasMomentum = false;

      for (const col of currentCols) {
        const rawBoost = stringMomentumRef.current[col.dayKey];
        const currentBoost =
          typeof rawBoost === 'number' && Number.isFinite(rawBoost) ? rawBoost : 0;
        let nextBoost = 0;
        if (Math.abs(currentBoost) >= 1.5) {
          if (
            stringSwipeRef.current?.active &&
            stringSwipeRef.current.dayKey === col.dayKey
          ) {
            nextBoost = currentBoost;
            stillHasMomentum = true;
          } else {
            nextBoost = decayStringSwipeMomentum(currentBoost, dt);
            if (nextBoost === 0) {
              delete stringMomentumRef.current[col.dayKey];
            } else {
              stringMomentumRef.current[col.dayKey] = nextBoost;
              stillHasMomentum = true;
            }
          }
        } else if (rawBoost !== undefined) {
          delete stringMomentumRef.current[col.dayKey];
        }

        const endDir =
          hoveredStringEndRef.current?.dayKey === col.dayKey
            ? hoveredStringEndRef.current.direction
            : null;
        const velocity = computeStringFlowVelocity(col.speedPxPerSec, currentSpeedMultiplier, {
          isFlowing,
          isColumnHovered: hoveredDayKeyRef.current === col.dayKey,
          isPhotoHovered: Boolean(hoveredPhotoIdRef.current),
          endHoverDirection: endDir,
          swipeBoostPxPerSec: nextBoost,
        });
        const deltaPx = velocity * dt;
        columnPhasesRef.current[col.dayKey] = (columnPhasesRef.current[col.dayKey] || 0) + deltaPx;
      }

      if (!stillHasMomentum && Object.keys(stringMomentumRef.current).length === 0) {
        setHasActiveMomentum(false);
      }

      setFrameTick((t) => (t + 1) % 1000000);
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isFlowing, hoveredStringEnd, hasActiveMomentum]);

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

  // Center timeline on screen, reset speed slider & timeline settings, and align photo #1 at the top of each column when reset
  const handleResetView = useCallback(() => {
    const defaultMetrics = getTimelineZoomMetrics(1, COLUMN_WIDTH, BASE_COLUMN_STEP);
    const defaultCols = buildTimelineDayColumns(
      photos,
      'compact',
      defaultMetrics.columnStepPx,
      defaultMetrics.granularity
    );
    const defaultWidth =
      defaultCols.length > 0
        ? defaultCols[defaultCols.length - 1].xOffsetPx + defaultMetrics.columnWidthPx
        : 0;
    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }
    activeTransitionRef.current = null;
    stringMomentumRef.current = {};
    stringSwipeRef.current = null;
    setHasActiveMomentum(false);
    columnPhasesRef.current = {};
    defaultCols.forEach((col, idx) => {
      columnPhasesRef.current[col.dayKey] = (idx * 16) % 48;
    });
    prevGranularityRef.current = {
      photos,
      granularity: defaultMetrics.granularity,
      columns: defaultCols,
      columnWidthPx: defaultMetrics.columnWidthPx,
      cardHeightPx: defaultMetrics.cardHeightPx,
      cardSlotHeightPx: defaultMetrics.cardSlotHeightPx,
      cardScale: defaultMetrics.cardScale,
    };
    hasUserPannedRef.current = false;
    speedMultiplierRef.current = 1;
    if (speedSliderRef.current) {
      speedSliderRef.current.value = '1';
    }
    setSpeedMultiplier(1);
    setIsFlowing(true);
    onChangeSpacingMode('compact');
    setZoom(1);
    setPan({
      x: computeCenteredTimelinePanX(defaultWidth, viewportSize.width),
      y: 0,
    });
    setFrameTick((t) => (t + 1) % 1000000);
  }, [photos, onChangeSpacingMode, viewportSize.width]);

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

  // Ensure releasing the pointer outside the timeline canvas ends any active string swipe or canvas drag
  useEffect(() => {
    const onWindowPointerEnd = () => {
      if (stringSwipeRef.current) {
        stringSwipeRef.current = null;
      }
      setIsDragging((dragging) => (dragging ? false : dragging));
    };
    window.addEventListener('pointerup', onWindowPointerEnd);
    window.addEventListener('pointercancel', onWindowPointerEnd);
    return () => {
      window.removeEventListener('pointerup', onWindowPointerEnd);
      window.removeEventListener('pointercancel', onWindowPointerEnd);
    };
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragStartRef.current.moved = false;
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
    const swipe = stringSwipeRef.current;
    if (swipe) {
      const totalDx = e.clientX - swipe.startX;
      const totalDy = e.clientY - swipe.startY;
      const dy = e.clientY - swipe.lastY;
      const now = performance.now();
      const elapsedMs = Math.max(8, now - swipe.lastTime);

      if (swipe.active || (Math.abs(totalDy) > 4 && Math.abs(totalDy) >= Math.abs(totalDx))) {
        swipe.active = true;
        swipe.lastY = e.clientY;
        swipe.lastTime = now;
        dragStartRef.current.moved = true;
        if (isDragging) {
          setIsDragging(false);
        }
        if (hoveredDayKeyRef.current === swipe.dayKey) {
          hoveredDayKeyRef.current = null;
          hoveredPhotoIdRef.current = null;
          setHoveredDayKey(null);
          setHoveredPhotoId(null);
        }
        clearStringEndHover(swipe.dayKey);

        if (dy !== 0) {
          columnPhasesRef.current[swipe.dayKey] =
            (columnPhasesRef.current[swipe.dayKey] || 0) + dy * 1.25;
          const prevBoost = stringMomentumRef.current[swipe.dayKey] || 0;
          const boost = computeSwipeVelocityBoost(dy, elapsedMs, prevBoost);
          if (boost !== 0) {
            stringMomentumRef.current[swipe.dayKey] = boost;
            setHasActiveMomentum(true);
          } else {
            delete stringMomentumRef.current[swipe.dayKey];
          }
          setFrameTick((t) => (t + 1) % 1000000);
        }
        return;
      }

      if (!swipe.active && Math.abs(totalDx) > 6 && Math.abs(totalDx) > Math.abs(totalDy)) {
        stringSwipeRef.current = null;
      } else {
        return;
      }
    }

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
    stringSwipeRef.current = null;
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

  // Visible height of each vertical string below its resized time card (time cards start at top-4)
  const stringViewportHeight = useMemo(() => {
    return Math.max(320, viewportSize.height - 112 - zoomMetrics.cardHeightPx);
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
      onPointerDownCapture={(e) => {
        if (e.button === 0) {
          dragStartRef.current.moved = false;
        }
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      className={`relative h-full w-full overflow-hidden select-none touch-none ${
        isDragging ? 'cursor-grabbing' : 'cursor-grab'
      }`}
      data-testid="timeline-canvas"
      data-granularity={zoomMetrics.granularity}
      data-transition-mode={activeTransition?.mode ?? 'steady'}
    >
      {/* Subtle Ambient Background Grid & Glow (moves horizontally only) */}
      <div
        className={`pointer-events-none absolute inset-0 opacity-25 ${
          !isDragging
            ? 'transition-[background-size,background-position] duration-300 ease-out'
            : 'transition-none'
        }`}
        style={{
          backgroundImage:
            'radial-gradient(circle at 1px 1px, rgba(148, 163, 184, 0.24) 1px, transparent 0)',
          backgroundSize: `${Math.max(16, Math.round(32 * zoomMetrics.cardScale))}px ${Math.max(16, Math.round(32 * zoomMetrics.cardScale))}px`,
          backgroundPosition: `${Math.round(pan.x)}px 0px`,
        }}
      />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-slate-950/75 via-slate-950/30 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-36 bg-gradient-to-t from-slate-950 via-slate-950/60 to-transparent z-10" />

      {/* Top-Right Collapsible Timeline Settings Button & Options Bar (overlaps top time cards) */}
      <div
        className="pointer-events-none absolute right-5 top-3.5 z-40 flex items-center justify-end"
        data-testid="timeline-top-overlay"
      >
        <div
          data-no-drag="true"
          data-no-wheel-zoom="true"
          data-testid="timeline-view-options-bar"
          data-expanded={isSettingsHovered ? 'true' : 'false'}
          onMouseEnter={() => {
            setIsSettingsHovered(true);
            hoveredDayKeyRef.current = null;
            hoveredPhotoIdRef.current = null;
            setHoveredDayKey(null);
            setHoveredPhotoId(null);
          }}
          onMouseLeave={() => setIsSettingsHovered(false)}
          className={`pointer-events-auto ml-auto flex items-center justify-end rounded-xl border backdrop-blur-md transition-all duration-300 ease-out ${
            isSettingsHovered
              ? 'gap-2 border-slate-700/90 bg-slate-900/95 p-1.5 shadow-[0_12px_36px_rgba(2,6,23,0.85)]'
              : 'gap-0 border-slate-800/90 bg-slate-900/85 p-1 shadow-xl hover:border-sky-500/40'
          }`}
        >
          {/* Expandable Timeline Controls Panel */}
          <div
            data-testid="timeline-options-panel"
            aria-hidden={!isSettingsHovered}
            className={`flex items-center gap-2 overflow-hidden whitespace-nowrap transition-all duration-300 ease-out origin-right ${
              isSettingsHovered
                ? 'opacity-100 scale-100 translate-x-0 pointer-events-auto max-w-[90vw] pr-1'
                : 'opacity-0 scale-95 translate-x-3 pointer-events-none max-w-0 pr-0'
            }`}
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
                ref={speedSliderRef}
                type="range"
                min="0.25"
                max="2.5"
                step="0.25"
                value={speedMultiplier}
                onChange={(e) => applySpeedMultiplier(Number(e.target.value))}
                onInput={(e) => applySpeedMultiplier(Number((e.target as HTMLInputElement).value))}
                className="h-1.5 w-16 cursor-pointer accent-sky-400"
                aria-label="Flow speed multiplier"
                data-testid="timeline-speed-slider"
              />
              <span
                className="min-w-[34px] text-right font-mono text-[11px] text-slate-300"
                data-testid="timeline-speed-value"
              >
                {Number.isInteger(speedMultiplier * 2)
                  ? `${speedMultiplier.toFixed(1)}x`
                  : `${speedMultiplier.toFixed(2)}x`}
              </span>
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
                title="Reset Timeline Settings, Zoom & Pan"
                data-testid="timeline-reset-view"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Settings Button (displayed by default, expands options bar on hover) */}
          <button
            type="button"
            onClick={() => setIsSettingsHovered(true)}
            onFocus={() => setIsSettingsHovered(true)}
            aria-expanded={isSettingsHovered}
            aria-label="Timeline settings"
            title="Hover to expand timeline options"
            data-testid="timeline-settings-btn"
            className={`flex shrink-0 items-center justify-center rounded-lg py-1.5 text-xs font-medium transition-all duration-300 ${
              isSettingsHovered
                ? 'gap-0 border border-sky-500/40 bg-sky-500/20 px-2 text-sky-300 shadow-sm'
                : 'gap-1.5 border border-transparent px-2.5 text-slate-300 hover:text-white'
            }`}
          >
            <SlidersHorizontal
              className={`h-4 w-4 transition-transform duration-300 ${
                isSettingsHovered ? 'rotate-90 text-sky-300' : 'rotate-0 text-sky-400'
              }`}
            />
            <span
              className={`overflow-hidden whitespace-nowrap transition-all duration-300 ${
                isSettingsHovered ? 'max-w-0 opacity-0' : 'max-w-[60px] opacity-100'
              }`}
            >
              Settings
            </span>
          </button>
        </div>
      </div>

      {/* Horizontal-Only Panned Canvas (pan.y is locked at 0; time cards stay near top and allow floating settings bar to overlap) */}
      <div
        className={`absolute left-0 top-4 z-10 origin-top-left will-change-transform ${
          !isDragging ? 'transition-transform duration-300 ease-out' : 'transition-none'
        }`}
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
            className="pointer-events-none absolute h-[2px] bg-gradient-to-r from-sky-500/30 via-sky-400/70 to-indigo-500/40 transition-all duration-300 ease-out"
            style={{
              top: Math.round(zoomMetrics.cardHeightPx * 0.5),
              left: 0,
              width: totalTimelineWidth,
            }}
          />
        )}

        {/* Timeline Columns ("Vertical Strings") */}
        <div
          className="relative transition-[width,height] duration-300 ease-out"
          style={{
            width: totalTimelineWidth,
            height: stringViewportHeight + zoomMetrics.cardHeightPx + 36,
          }}
        >
          {/* Outgoing Converging/Splitting Ghost Strings Layer during Merge/Unmerge Transitions */}
          {activeTransition && activeTransition.mode && activeTransition.exitingGhosts.length > 0 && (
            <div
              className="pointer-events-none absolute inset-0 z-0 overflow-visible"
              data-testid="timeline-merge-ghosts-layer"
              data-transition-mode={activeTransition.mode}
            >
              {activeTransition.exitingGhosts.map((ghost) => {
                const ghostPhase = activeTransition.prevPhases[ghost.col.dayKey] ?? 0;
                const { items: ghostVirtualItems } = buildVirtualStringItems(
                  ghost.col.photos,
                  stringViewportHeight,
                  activeTransition.prevCardSlotHeightPx
                );
                const visibleGhostCards = ghostVirtualItems
                  .map((vItem) => ({
                    vItem,
                    state: computeFlowingCardState(
                      vItem.virtualIndex,
                      ghostVirtualItems.length,
                      ghostPhase,
                      stringViewportHeight,
                      activeTransition.prevCardSlotHeightPx
                    ),
                  }))
                  .filter((entry) => entry.state.isVisible)
                  .slice(0, 4);
                return (
                  <div
                    key={`ghost-${activeTransition.id}-${ghost.col.dayKey}`}
                    className="timeline-ghost-converge pointer-events-none absolute top-0 flex flex-col items-center"
                    style={
                      {
                        left: ghost.col.xOffsetPx,
                        width: activeTransition.prevColumnWidthPx,
                        '--ghost-delta-x': `${ghost.deltaXPx}px`,
                      } as React.CSSProperties
                    }
                    data-testid={`timeline-merge-ghost-${ghost.col.dayKey}`}
                    data-ghost-key={ghost.col.dayKey}
                    data-target-key={ghost.targetKey}
                    data-delta-x={ghost.deltaXPx}
                  >
                    {/* Ghost Time Card Preview */}
                    <div
                      style={{
                        width: activeTransition.prevColumnWidthPx,
                        height: activeTransition.prevCardHeightPx,
                        borderRadius: `${Math.round(12 * activeTransition.prevCardScale)}px`,
                        padding: `${Math.round(8 * activeTransition.prevCardScale)}px ${Math.round(12 * activeTransition.prevCardScale)}px`,
                      }}
                      className="flex shrink-0 items-center justify-between overflow-hidden border border-sky-400/50 bg-slate-900/75 shadow-[0_0_20px_rgba(56,189,248,0.22)]"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span
                            className="truncate font-semibold tracking-tight text-sky-100/90"
                            style={{
                              fontSize: `${Number((12 * activeTransition.prevCardScale).toFixed(2))}px`,
                              lineHeight: 1.2,
                            }}
                          >
                            {ghost.col.displayDate}
                          </span>
                          <span className="shrink-0 rounded bg-sky-500/20 px-1.5 py-0.5 font-mono text-[10px] font-medium text-sky-300">
                            {ghost.col.photos.length}
                          </span>
                        </div>
                        <div
                          className="truncate text-slate-400/80"
                          style={{
                            fontSize: `${Number((10 * activeTransition.prevCardScale).toFixed(2))}px`,
                            lineHeight: 1.2,
                          }}
                        >
                          {ghost.col.weekday}
                        </div>
                      </div>
                    </div>

                    {/* Ghost Top Anchor Node (matches active column spacing) */}
                    <div className="relative z-10 my-1 flex flex-col items-center">
                      <div className="h-2.5 w-2.5 rounded-full border border-sky-400/70 bg-sky-400/25 shadow-[0_0_8px_#38bdf8]" />
                    </div>

                    {/* Ghost Vertical String Filament & Preview Cards */}
                    <div
                      className="relative w-full overflow-hidden"
                      style={{ height: stringViewportHeight }}
                    >
                      <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-[2px] bg-gradient-to-b from-sky-400/45 via-sky-300/75 to-indigo-400/20 shadow-[0_0_16px_rgba(56,189,248,0.65)]" />
                      {visibleGhostCards.map(({ vItem, state }) => (
                        <div
                          key={`ghost-photo-${ghost.col.dayKey}-v${vItem.virtualIndex}-${vItem.photo.id}`}
                          className="absolute left-2 right-2 overflow-hidden rounded-xl border border-sky-400/40 bg-slate-900/65"
                          style={{
                            height: Math.max(88, activeTransition.prevCardSlotHeightPx - 16),
                            transform: `translate3d(0, ${state.y}px, 0) scale(${state.scale})`,
                            opacity: Number((state.opacity * 0.85).toFixed(3)),
                          }}
                        >
                          <img
                            src={vItem.photo.url}
                            alt={vItem.photo.fileName}
                            loading="lazy"
                            draggable={false}
                            className="h-full w-full object-cover opacity-75"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {columns.map((col, colIndex) => {
            const phaseOffset = columnPhasesRef.current[col.dayKey] || 0;
            const { items: virtualItems } = buildVirtualStringItems(
              col.photos,
              stringViewportHeight,
              zoomMetrics.cardSlotHeightPx
            );
            const activeEndDirection =
              hoveredStringEnd?.dayKey === col.dayKey ? hoveredStringEnd.direction : null;
            const activeSwipeBoost = stringMomentumRef.current[col.dayKey] || 0;
            const effectiveSpeed = Number((col.speedPxPerSec * speedMultiplier).toFixed(1));
            const activeVelocity = computeStringFlowVelocity(col.speedPxPerSec, speedMultiplier, {
              isFlowing,
              isColumnHovered: hoveredDayKey === col.dayKey,
              isPhotoHovered: Boolean(hoveredPhotoId),
              endHoverDirection: activeEndDirection,
              swipeBoostPxPerSec: activeSwipeBoost,
            });
            const flowMode =
              activeSwipeBoost <= -1.5 || activeEndDirection === 'backward'
                ? 'fast-backward'
                : activeSwipeBoost >= 1.5 || activeEndDirection === 'forward'
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

            const enteringInfo = activeTransition?.enteringByKey[col.dayKey];
            const mergeDeltaXPx = enteringInfo?.deltaXPx ?? 0;
            const mergeSourceCount = enteringInfo?.mergedCount ?? 1;
            const transitionMode = activeTransition?.mode ?? 'steady';
            const columnEnterAnimClass =
              transitionMode === 'merge'
                ? 'timeline-column-merge-enter'
                : transitionMode === 'unmerge'
                  ? 'timeline-column-unmerge-enter'
                  : '';
            const timeCardMergeGlowClass =
              transitionMode === 'merge' ? 'timeline-merge-card-pulse' : '';

            return (
              <React.Fragment key={col.dayKey}>
                {/* Proportional Time Gap Badge between columns */}
                {prevCol && col.gapLabel && gapWidth >= 44 && (
                  <div
                    className="pointer-events-none absolute flex items-center justify-center transition-all duration-300 ease-out"
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
                  className={`absolute top-0 flex flex-col items-center transition-[left,width] duration-300 ease-out ${columnEnterAnimClass}`}
                  style={
                    {
                      left: col.xOffsetPx,
                      width: zoomMetrics.columnWidthPx,
                      '--merge-delta-x': `${mergeDeltaXPx}px`,
                    } as React.CSSProperties
                  }
                  onMouseEnter={() => setHoveredDayKey(col.dayKey)}
                  onMouseLeave={() => {
                    setHoveredDayKey(null);
                    setHoveredPhotoId(null);
                    clearStringEndHover(col.dayKey);
                  }}
                  data-testid={`timeline-day-column-${col.dayKey}`}
                  data-day-key={col.dayKey}
                  data-granularity={zoomMetrics.granularity}
                  data-transition-mode={transitionMode}
                  data-merge-delta-x={mergeDeltaXPx}
                  data-merge-source-count={mergeSourceCount}
                  data-card-slot-height={zoomMetrics.cardSlotHeightPx}
                  data-speed={effectiveSpeed}
                  data-base-speed={col.speedPxPerSec}
                  data-flow-mode={flowMode}
                  data-flow-velocity={Number(activeVelocity.toFixed(2))}
                  data-swipe-boost={Number(activeSwipeBoost.toFixed(2))}
                  data-phase={Number(phaseOffset.toFixed(2))}
                >
                  {/* Column Time Card on top of the string (resizes natively in place without blurry transform: scale) */}
                  <div
                    data-no-drag="true"
                    data-testid={`timeline-time-card-${col.dayKey}`}
                    data-card-width={zoomMetrics.columnWidthPx}
                    data-card-height={zoomMetrics.cardHeightPx}
                    data-card-scale={zoomMetrics.cardScale}
                    style={{
                      width: zoomMetrics.columnWidthPx,
                      height: zoomMetrics.cardHeightPx,
                      borderRadius: `${Math.round(12 * zoomMetrics.cardScale)}px`,
                      padding: `${Math.round(8 * zoomMetrics.cardScale)}px ${Math.round(12 * zoomMetrics.cardScale)}px`,
                    }}
                    className={`group relative z-10 flex shrink-0 items-center justify-between overflow-hidden border backdrop-blur-md transition-all duration-300 ease-out ${timeCardMergeGlowClass} ${
                      allSelectedInDay
                        ? 'border-sky-400/80 bg-sky-950/80 shadow-[0_0_20px_rgba(56,189,248,0.25)]'
                        : someSelectedInDay
                          ? 'border-sky-500/50 bg-slate-900/90'
                          : 'border-slate-800/90 bg-slate-900/85 hover:border-slate-700'
                    }`}
                  >
                    <div
                      className="min-w-0 transition-all duration-300 ease-out"
                      style={{ paddingRight: `${Math.round(6 * zoomMetrics.cardScale)}px` }}
                    >
                      <div
                        className="flex items-center transition-all duration-300 ease-out"
                        style={{ gap: `${Math.round(6 * zoomMetrics.cardScale)}px` }}
                      >
                        <span
                          className="truncate font-semibold tracking-tight text-slate-100 transition-all duration-300 ease-out"
                          style={{
                            fontSize: `${Number((12 * zoomMetrics.cardScale).toFixed(2))}px`,
                            lineHeight: 1.2,
                          }}
                        >
                          {col.displayDate}
                        </span>
                        <span
                          className="shrink-0 bg-slate-800/90 font-mono font-medium text-sky-300 transition-all duration-300 ease-out"
                          style={{
                            fontSize: `${Number((10 * zoomMetrics.cardScale).toFixed(2))}px`,
                            lineHeight: 1.2,
                            padding: `${Math.round(2 * zoomMetrics.cardScale)}px ${Math.round(6 * zoomMetrics.cardScale)}px`,
                            borderRadius: `${Math.round(6 * zoomMetrics.cardScale)}px`,
                          }}
                        >
                          {col.photos.length}
                        </span>
                      </div>
                      <div
                        className="flex items-center text-slate-400 transition-all duration-300 ease-out"
                        style={{
                          marginTop: `${Math.round(2 * zoomMetrics.cardScale)}px`,
                          gap: `${Math.round(6 * zoomMetrics.cardScale)}px`,
                          fontSize: `${Number((10 * zoomMetrics.cardScale).toFixed(2))}px`,
                          lineHeight: 1.2,
                        }}
                      >
                        <span className="truncate">{col.weekday}</span>
                        <span>•</span>
                        <span
                          className={`shrink-0 font-mono ${
                            flowMode === 'fast-backward'
                              ? 'text-amber-300 font-semibold'
                              : flowMode === 'fast-forward'
                                ? 'text-sky-300 font-semibold'
                                : !isFlowing
                                  ? 'text-amber-400/80'
                                  : 'text-slate-500'
                          }`}
                          title="String flow speed"
                          data-testid={`timeline-speed-label-${col.dayKey}`}
                        >
                          {flowMode === 'fast-backward'
                            ? `↑↑ ${Math.abs(Math.round(activeVelocity))}px/s`
                            : flowMode === 'fast-forward'
                              ? `↓↓ ${Math.abs(Math.round(activeVelocity))}px/s`
                              : !isFlowing
                                ? '⏸ 0px/s'
                                : `↓ ${effectiveSpeed}px/s`}
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
                      style={{
                        width: `${Math.round(24 * zoomMetrics.cardScale)}px`,
                        height: `${Math.round(24 * zoomMetrics.cardScale)}px`,
                        borderRadius: `${Math.round(8 * zoomMetrics.cardScale)}px`,
                      }}
                      className={`flex shrink-0 items-center justify-center border transition-all duration-300 ease-out ${
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
                      <Check
                        className="transition-all duration-300 ease-out"
                        style={{
                          width: `${Number((14 * zoomMetrics.cardScale).toFixed(2))}px`,
                          height: `${Number((14 * zoomMetrics.cardScale).toFixed(2))}px`,
                        }}
                      />
                    </button>
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
                    className="relative w-full overflow-hidden transition-[height] duration-300 ease-out"
                    style={{
                      height: stringViewportHeight,
                      WebkitMaskImage:
                        'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.96) 11%, rgba(0,0,0,0.96) 89%, transparent 100%)',
                      maskImage:
                        'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.96) 11%, rgba(0,0,0,0.96) 89%, transparent 100%)',
                    }}
                    data-testid={`timeline-string-viewport-${col.dayKey}`}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      if ((e.target as HTMLElement).closest('button')) return;
                      dragStartRef.current.moved = false;
                      stringSwipeRef.current = {
                        dayKey: col.dayKey,
                        startX: e.clientX,
                        startY: e.clientY,
                        lastY: e.clientY,
                        lastTime: performance.now(),
                        active: false,
                      };
                    }}
                    onMouseMove={(e) => {
                      if (stringSwipeRef.current?.active || Math.abs(activeSwipeBoost) >= 1.5) {
                        return;
                      }
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
                            if (dragStartRef.current.moved) {
                              dragStartRef.current.moved = false;
                              return;
                            }
                            if (e.shiftKey || e.metaKey || e.ctrlKey) {
                              onToggleSelect(photo.id, e);
                            } else {
                              onOpenPhoto(photo);
                            }
                          }}
                          className="group/card absolute left-2 right-2 cursor-pointer will-change-transform transition-[height] duration-300 ease-out"
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
