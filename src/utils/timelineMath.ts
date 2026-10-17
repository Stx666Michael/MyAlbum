import type { PhotoItem } from '../types/photo.ts';

export type TimelineGranularity = 'day' | 'week' | 'month' | 'year';

export interface DayColumnGroup {
  dayKey: string;       // Bucket key: "YYYY-MM-DD" | "YYYY-Www" | "YYYY-MM" | "YYYY"
  displayDate: string;  // e.g. "Mar 14, 2025" | "Mar 10–16, 2025" | "Mar 2025" | "2025"
  weekday: string;      // e.g. "Friday" | "Week 11 • 2 days" | "Monthly • 2 days" | "Yearly • 5 mos (7d)"
  epochDay: number;     // Days since 1970-01-01 UTC (start of bucket)
  photos: PhotoItem[];  // Sorted oldest (top) to newest (bottom)
  speedPxPerSec: number;
  xOffsetPx: number;
  daysSincePrev: number;
  granularity?: TimelineGranularity;
  unitGapSincePrev?: number;
  gapLabel?: string;
  activeDaysCount?: number;
}

export interface TimelineZoomMetrics {
  zoom: number;
  granularity: TimelineGranularity;
  cardScale: number;
  columnWidthPx: number;
  columnStepPx: number;
  cardHeightPx: number;
  cardSlotHeightPx: number;
  rawDailyCardWidthPx: number;
  minCardWidthPx: number;
}

export const MIN_TIMELINE_ZOOM = 0.15;
export const MAX_TIMELINE_ZOOM = 2.25;
export const BASE_TIME_CARD_WIDTH_PX = 216;
export const BASE_TIME_CARD_HEIGHT_PX = 56;
export const MIN_TIME_CARD_WIDTH_PX = 146;
export const BASE_PHOTO_CARD_SLOT_HEIGHT_PX = 192;

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function getWallClockParts(isoTimestamp: string): {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
  dayKey: string;
  timeLabel: string;
  dateTimeInputValue: string;
} {
  const d = new Date(isoTimestamp);
  const valid = !Number.isNaN(d.getTime()) ? d : new Date(0);
  const year = valid.getUTCFullYear();
  const month = valid.getUTCMonth() + 1;
  const day = valid.getUTCDate();
  const hours = valid.getUTCHours();
  const minutes = valid.getUTCMinutes();
  const seconds = valid.getUTCSeconds();

  const pad = (n: number) => String(n).padStart(2, '0');
  const dayKey = `${year}-${pad(month)}-${pad(day)}`;
  const timeLabel = `${pad(hours)}:${pad(minutes)}`;
  const dateTimeInputValue = `${dayKey}T${pad(hours)}:${pad(minutes)}`;

  return {
    year,
    month,
    day,
    hours,
    minutes,
    seconds,
    dayKey,
    timeLabel,
    dateTimeInputValue,
  };
}

export function formatWallClockDate(isoTimestamp: string): string {
  const { year, month, day } = getWallClockParts(isoTimestamp);
  return `${MONTHS_SHORT[month - 1]} ${day}, ${year}`;
}

export function formatWallClockDateTime(isoTimestamp: string): string {
  const { year, month, day, hours, minutes, seconds } = getWallClockParts(isoTimestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${MONTHS_SHORT[month - 1]} ${day}, ${year} • ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export function computeColumnFlowSpeed(columnIndex: number, dayKey: string): number {
  let hash = (columnIndex + 1) * 2654435761;
  for (let i = 0; i < dayKey.length; i++) {
    hash = (hash ^ dayKey.charCodeAt(i)) * 16777619;
  }
  const normalized = ((hash >>> 0) % 1000) / 1000;
  const parityBand = columnIndex % 2 === 0 ? 0 : 0.45;
  const bandNormalized = (normalized * 0.55 + parityBand) % 1;
  return Math.round((22 + bandNormalized * 26) * 10) / 10;
}

/**
 * Determines which time bucket granularity to use based on zoom level.
 * When zooming out makes the time card smaller than minCardWidthPx, strings
 * progressively merge from daily -> weekly -> monthly -> yearly.
 */
export function resolveTimelineGranularity(
  zoom: number,
  baseColumnWidthPx = BASE_TIME_CARD_WIDTH_PX,
  minCardWidthPx = MIN_TIME_CARD_WIDTH_PX
): TimelineGranularity {
  const safeZoom = Number.isFinite(zoom) ? zoom : 1;
  const clampedZoom = Math.max(MIN_TIMELINE_ZOOM, Math.min(MAX_TIMELINE_ZOOM, safeZoom));
  const dailyWidth = baseColumnWidthPx * clampedZoom;
  if (dailyWidth >= minCardWidthPx) {
    return 'day';
  }
  const weeklyWidth = baseColumnWidthPx * clampedZoom * 1.44;
  if (weeklyWidth >= minCardWidthPx) {
    return 'week';
  }
  const monthlyWidth = baseColumnWidthPx * clampedZoom * 2.3;
  if (monthlyWidth >= minCardWidthPx) {
    return 'month';
  }
  return 'year';
}

export function getTimelineZoomMetrics(
  zoom: number,
  baseColumnWidthPx = BASE_TIME_CARD_WIDTH_PX,
  baseColumnStepPx = 256,
  minCardWidthPx = MIN_TIME_CARD_WIDTH_PX
): TimelineZoomMetrics {
  const safeZoom = Number.isFinite(zoom) ? zoom : 1;
  const clampedZoom = Math.max(MIN_TIMELINE_ZOOM, Math.min(MAX_TIMELINE_ZOOM, safeZoom));
  const granularity = resolveTimelineGranularity(clampedZoom, baseColumnWidthPx, minCardWidthPx);

  let cardScale = clampedZoom;
  if (granularity === 'week') {
    cardScale = Number((clampedZoom * 1.44).toFixed(3));
  } else if (granularity === 'month') {
    cardScale = Number((clampedZoom * 2.3).toFixed(3));
  } else if (granularity === 'year') {
    cardScale = Number(Math.max(minCardWidthPx / baseColumnWidthPx, clampedZoom * 3.5).toFixed(3));
  }

  const columnWidthPx = Math.round(baseColumnWidthPx * cardScale);
  const columnStepPx = Math.round(baseColumnStepPx * cardScale);
  const cardHeightPx = Math.round(BASE_TIME_CARD_HEIGHT_PX * cardScale);
  const cardSlotHeightPx = Math.round(BASE_PHOTO_CARD_SLOT_HEIGHT_PX * cardScale);

  return {
    zoom: clampedZoom,
    granularity,
    cardScale,
    columnWidthPx,
    columnStepPx,
    cardHeightPx,
    cardSlotHeightPx,
    rawDailyCardWidthPx: Math.round(baseColumnWidthPx * clampedZoom),
    minCardWidthPx,
  };
}

function getIsoWeekMetadata(year: number, month: number, day: number): {
  weekKey: string;
  isoWeekYear: number;
  isoWeekNum: number;
  mondayEpochDay: number;
  displayRange: string;
} {
  const utcMs = Date.UTC(year, month - 1, day);
  const dow = new Date(utcMs).getUTCDay(); // 0=Sun..6=Sat
  const mondayOffset = (dow + 6) % 7; // 0=Mon..6=Sun
  const mondayMs = utcMs - mondayOffset * 86400000;
  const sundayMs = mondayMs + 6 * 86400000;
  const thursdayMs = mondayMs + 3 * 86400000;

  const thursdayDate = new Date(thursdayMs);
  const isoWeekYear = thursdayDate.getUTCFullYear();
  const jan4Ms = Date.UTC(isoWeekYear, 0, 4);
  const jan4Dow = new Date(jan4Ms).getUTCDay();
  const week1MondayMs = jan4Ms - ((jan4Dow + 6) % 7) * 86400000;
  const isoWeekNum = Math.round((mondayMs - week1MondayMs) / (7 * 86400000)) + 1;

  const monDate = new Date(mondayMs);
  const sunDate = new Date(sundayMs);
  const y1 = monDate.getUTCFullYear();
  const m1 = monDate.getUTCMonth() + 1;
  const d1 = monDate.getUTCDate();
  const y2 = sunDate.getUTCFullYear();
  const m2 = sunDate.getUTCMonth() + 1;
  const d2 = sunDate.getUTCDate();

  let displayRange: string;
  if (y1 === y2 && m1 === m2) {
    displayRange = `${MONTHS_SHORT[m1 - 1]} ${d1}–${d2}, ${y1}`;
  } else if (y1 === y2) {
    displayRange = `${MONTHS_SHORT[m1 - 1]} ${d1} – ${MONTHS_SHORT[m2 - 1]} ${d2}, ${y1}`;
  } else {
    displayRange = `${MONTHS_SHORT[m1 - 1]} ${d1}, ${y1} – ${MONTHS_SHORT[m2 - 1]} ${d2}, ${y2}`;
  }

  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    weekKey: `${isoWeekYear}-W${pad(isoWeekNum)}`,
    isoWeekYear,
    isoWeekNum,
    mondayEpochDay: Math.round(mondayMs / 86400000),
    displayRange,
  };
}

export function buildTimelineDayColumns(
  photos: PhotoItem[],
  spacingMode: 'compact' | 'proportional',
  baseColumnStepPx = 248,
  granularity: TimelineGranularity = 'day'
): DayColumnGroup[] {
  if (photos.length === 0) return [];

  interface BucketAccumulator {
    bucketKey: string;
    displayDate: string;
    weekdayLabel: string;
    epochDay: number;
    unitIndex: number; // epochDay for day, week index for week, month index for month, year for year
    photos: PhotoItem[];
    dayKeys: Set<string>;
    monthKeys: Set<string>;
    isoWeekNum?: number;
  }

  const byBucket = new Map<string, BucketAccumulator>();
  const pad = (n: number) => String(n).padStart(2, '0');

  for (const photo of photos) {
    const { year, month, day, dayKey } = getWallClockParts(photo.timestamp);
    const monthKey = `${year}-${pad(month)}`;

    let bucketKey = dayKey;
    let displayDate = `${MONTHS_SHORT[month - 1]} ${day}, ${year}`;
    let weekdayLabel = '';
    let epochDay = Math.round(Date.UTC(year, month - 1, day) / 86400000);
    let unitIndex = epochDay;
    let isoWeekNum: number | undefined;

    if (granularity === 'day') {
      const dateObj = new Date(Date.UTC(year, month - 1, day));
      weekdayLabel = WEEKDAYS[dateObj.getUTCDay()];
    } else if (granularity === 'week') {
      const wk = getIsoWeekMetadata(year, month, day);
      bucketKey = wk.weekKey;
      displayDate = wk.displayRange;
      epochDay = wk.mondayEpochDay;
      unitIndex = Math.round(wk.mondayEpochDay / 7);
      isoWeekNum = wk.isoWeekNum;
    } else if (granularity === 'month') {
      bucketKey = monthKey;
      displayDate = `${MONTHS_SHORT[month - 1]} ${year}`;
      epochDay = Math.round(Date.UTC(year, month - 1, 1) / 86400000);
      unitIndex = year * 12 + (month - 1);
    } else {
      bucketKey = `${year}`;
      displayDate = `${year}`;
      epochDay = Math.round(Date.UTC(year, 0, 1) / 86400000);
      unitIndex = year;
    }

    const existing = byBucket.get(bucketKey);
    if (existing) {
      existing.photos.push(photo);
      existing.dayKeys.add(dayKey);
      existing.monthKeys.add(monthKey);
    } else {
      byBucket.set(bucketKey, {
        bucketKey,
        displayDate,
        weekdayLabel,
        epochDay,
        unitIndex,
        photos: [photo],
        dayKeys: new Set([dayKey]),
        monthKeys: new Set([monthKey]),
        isoWeekNum,
      });
    }
  }

  // Sort buckets chronologically (oldest left -> newest right)
  const sortedBuckets = Array.from(byBucket.values()).sort((a, b) =>
    a.epochDay !== b.epochDay ? a.epochDay - b.epochDay : a.bucketKey.localeCompare(b.bucketKey)
  );

  const scaleFactor = baseColumnStepPx / 256;
  const columns: DayColumnGroup[] = [];
  let currentX = 0;

  sortedBuckets.forEach((bucket, index) => {
    const sortedPhotos = bucket.photos.slice().sort((a, b) => {
      const diff = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      return diff !== 0 ? diff : a.fileName.localeCompare(b.fileName);
    });

    const activeDaysCount = bucket.dayKeys.size;
    const activeMonthsCount = bucket.monthKeys.size;

    let weekday = bucket.weekdayLabel;
    if (granularity === 'week') {
      weekday = `Week ${bucket.isoWeekNum} • ${activeDaysCount} ${activeDaysCount === 1 ? 'day' : 'days'}`;
    } else if (granularity === 'month') {
      weekday = `Monthly • ${activeDaysCount} ${activeDaysCount === 1 ? 'day' : 'days'}`;
    } else if (granularity === 'year') {
      weekday = `Yearly • ${activeMonthsCount} ${activeMonthsCount === 1 ? 'mo' : 'mos'} (${activeDaysCount}d)`;
    }

    let daysSincePrev = 0;
    let unitGapSincePrev = 0;
    let gapLabel: string | undefined;

    if (index > 0) {
      const prevBucket = sortedBuckets[index - 1];
      daysSincePrev = Math.max(1, bucket.epochDay - prevBucket.epochDay);
      unitGapSincePrev = Math.max(1, bucket.unitIndex - prevBucket.unitIndex);

      if (granularity === 'day') {
        if (daysSincePrev > 1) gapLabel = `+${daysSincePrev}d gap`;
      } else if (granularity === 'week') {
        if (unitGapSincePrev > 1) gapLabel = `+${unitGapSincePrev}w gap`;
      } else if (granularity === 'month') {
        if (unitGapSincePrev > 1) gapLabel = `+${unitGapSincePrev}mo gap`;
      } else if (granularity === 'year') {
        if (unitGapSincePrev > 1) gapLabel = `+${unitGapSincePrev}yr gap`;
      }

      if (spacingMode === 'compact') {
        currentX += baseColumnStepPx;
      } else {
        const extraUnits = unitGapSincePrev - 1;
        const perUnitPx =
          granularity === 'day'
            ? 28
            : granularity === 'week'
              ? 44
              : granularity === 'month'
                ? 64
                : 96;
        const maxExtraPx = Math.round(720 * scaleFactor);
        const proportionalExtra = Math.min(Math.round(extraUnits * perUnitPx * scaleFactor), maxExtraPx);
        currentX += baseColumnStepPx + proportionalExtra;
      }
    }

    columns.push({
      dayKey: bucket.bucketKey,
      displayDate: bucket.displayDate,
      weekday,
      epochDay: bucket.epochDay,
      photos: sortedPhotos,
      speedPxPerSec: computeColumnFlowSpeed(index, bucket.bucketKey),
      xOffsetPx: currentX,
      daysSincePrev,
      granularity,
      unitGapSincePrev,
      gapLabel,
      activeDaysCount,
    });
  });

  return columns;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export interface FlowingCardPosition {
  y: number;
  opacity: number;
  scale: number;
  isVisible: boolean;
}

export interface VirtualStringItem {
  virtualIndex: number;
  photoIndex: number;
  cycleIndex: number;
  photo: PhotoItem;
}

export function buildVirtualStringItems(
  photos: PhotoItem[],
  visibleHeightPx: number,
  cardSlotHeightPx = 196
): { items: VirtualStringItem[]; cycleHeightPx: number } {
  if (photos.length === 0) {
    return { items: [], cycleHeightPx: visibleHeightPx };
  }
  const safeVisibleHeight = Math.max(320, visibleHeightPx);
  const minRequiredSlots = Math.ceil((safeVisibleHeight + cardSlotHeightPx * 1.4) / cardSlotHeightPx);
  const repeatCycles = Math.max(1, Math.ceil(minRequiredSlots / photos.length));
  const totalVirtualSlots = photos.length * repeatCycles;
  const cycleHeightPx = totalVirtualSlots * cardSlotHeightPx;

  const items: VirtualStringItem[] = [];
  for (let c = 0; c < repeatCycles; c++) {
    for (let i = 0; i < photos.length; i++) {
      items.push({
        virtualIndex: c * photos.length + i,
        photoIndex: i,
        cycleIndex: c,
        photo: photos[i],
      });
    }
  }

  return { items, cycleHeightPx };
}

/**
 * Computes the vertical position and natural top/bottom edge transition
 * for a photo card inside a downward-flowing infinite-loop day string.
 */
export function computeFlowingCardState(
  virtualIndex: number,
  totalVirtualSlots: number,
  phaseOffsetPx: number,
  visibleHeightPx: number,
  cardSlotHeightPx = 196
): FlowingCardPosition {
  const safeVisibleHeight = Math.max(320, visibleHeightPx);
  const cycleHeight = Math.max(
    safeVisibleHeight + cardSlotHeightPx * 1.25,
    totalVirtualSlots * cardSlotHeightPx
  );

  const entryStart = -cardSlotHeightPx * 0.45;
  const entryFull = 24;
  const exitStart = safeVisibleHeight - cardSlotHeightPx * 0.85;
  const exitGone = safeVisibleHeight - cardSlotHeightPx * 0.05;

  const rawPos = (virtualIndex + 1) * cardSlotHeightPx + entryFull + phaseOffsetPx;
  const wrappedY = (((rawPos % cycleHeight) + cycleHeight) % cycleHeight) - cardSlotHeightPx;

  if (wrappedY < entryStart || wrappedY > exitGone) {
    return {
      y: wrappedY,
      opacity: 0,
      scale: 0.86,
      isVisible: false,
    };
  }

  const enterFactor = smoothstep(entryStart, entryFull, wrappedY);
  const exitFactor = 1 - smoothstep(exitStart, exitGone, wrappedY);
  const combined = Math.max(0, Math.min(1, enterFactor * exitFactor));

  return {
    y: wrappedY,
    opacity: Number(combined.toFixed(3)),
    scale: Number((0.86 + 0.14 * combined).toFixed(3)),
    isVisible: combined > 0.01,
  };
}

export type StringEndHoverDirection = 'forward' | 'backward' | null;

export const FAST_STRING_FLOW_MULTIPLIER = 4.5;
export const STRING_END_ZONE_HEIGHT_PX = 56;

/**
 * Computes the horizontal pan X that centers the timeline on screen.
 */
export function computeCenteredTimelinePanX(
  timelineWidthPx: number,
  viewportWidthPx: number
): number {
  if (timelineWidthPx <= 0) {
    return Math.round(viewportWidthPx * 0.5);
  }
  return Math.round((viewportWidthPx - timelineWidthPx) * 0.5);
}

/**
 * Clamps horizontal pan X while ensuring the centered timeline position
 * is always reachable (even when the timeline is narrower than the screen).
 */
export function clampTimelinePanX(
  targetPanX: number,
  timelineWidthPx: number,
  viewportWidthPx: number,
  horizontalPaddingPx = 48
): number {
  if (timelineWidthPx <= 0) {
    return Math.round(viewportWidthPx * 0.5);
  }
  const centeredX = computeCenteredTimelinePanX(timelineWidthPx, viewportWidthPx);
  if (!Number.isFinite(targetPanX)) {
    return centeredX;
  }
  const boundA = horizontalPaddingPx;
  const boundB = viewportWidthPx - timelineWidthPx - horizontalPaddingPx;
  const minX = Math.min(boundA, boundB, centeredX);
  const maxX = Math.max(boundA, boundB, centeredX);
  return Math.max(minX, Math.min(maxX, Math.round(targetPanX)));
}

/**
 * Determines whether a vertical pointer offset within a string viewport
 * falls in the top end zone ('backward' rewind) or bottom end zone ('forward' fast-forward).
 */
export function resolveStringEndHoverDirection(
  offsetY: number,
  stringHeightPx: number,
  endZoneHeightPx = STRING_END_ZONE_HEIGHT_PX
): StringEndHoverDirection {
  if (stringHeightPx <= 0 || offsetY < 0 || offsetY > stringHeightPx) {
    return null;
  }
  const effectiveZone = Math.min(endZoneHeightPx, Math.floor(stringHeightPx * 0.25));
  if (offsetY <= effectiveZone) {
    return 'backward';
  }
  if (offsetY >= stringHeightPx - effectiveZone) {
    return 'forward';
  }
  return null;
}

/**
 * Computes the signed vertical flow velocity (px/sec) for a string.
 * Positive values flow downwards (forward); negative values flow upwards (backward/rewind).
 * Hovering the bottom end fast-forwards (+4.5x); hovering the top end fast-backwards (-4.5x).
 */
export function computeStringFlowVelocity(
  baseSpeedPxPerSec: number,
  speedMultiplier: number,
  options: {
    isFlowing: boolean;
    isColumnHovered: boolean;
    isPhotoHovered: boolean;
    endHoverDirection: StringEndHoverDirection;
  }
): number {
  if (options.endHoverDirection === 'forward') {
    return Number((baseSpeedPxPerSec * speedMultiplier * FAST_STRING_FLOW_MULTIPLIER).toFixed(2));
  }
  if (options.endHoverDirection === 'backward') {
    return Number((-baseSpeedPxPerSec * speedMultiplier * FAST_STRING_FLOW_MULTIPLIER).toFixed(2));
  }
  if (!options.isFlowing) {
    return 0;
  }
  if (options.isColumnHovered) {
    const slowFactor = options.isPhotoHovered ? 0.04 : 0.18;
    return Number((baseSpeedPxPerSec * speedMultiplier * slowFactor).toFixed(2));
  }
  return Number((baseSpeedPxPerSec * speedMultiplier).toFixed(2));
}

