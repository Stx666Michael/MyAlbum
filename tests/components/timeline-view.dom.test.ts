import { describe, it, expect } from 'vitest';
import request from 'supertest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
// @ts-expect-error jsdom package has no bundled type declarations
import { JSDOM } from 'jsdom';
import { createApiApp } from '../../server/app.ts';
import {
  BASE_TIME_CARD_HEIGHT_PX,
  BASE_TIME_CARD_WIDTH_PX,
  FAST_STRING_FLOW_MULTIPLIER,
  MAX_TIMELINE_ZOOM,
  computeCenteredTimelinePanX,
  getTimelineZoomMetrics,
} from '../../src/utils/timelineMath.ts';
import { TimelineView } from '../../src/components/TimelineView.tsx';

describe('TimelineView: DOM behavior', () => {
  const app = createApiApp();

  it('enforces horizontal-only panning, keeps time cards pinned at the top while resizing natively on zoom without blurry scale transform, right-aligns view options, and merges strings in TimelineView DOM', async () => {
    const demoRes = await request(app).post('/api/demo').send({});
    const photos = demoRes.body.photos;

    // Set up JSDOM environment for React component rendering
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost:5173/',
    });
    const prevWindow = (globalThis as any).window;
    const prevDocument = (globalThis as any).document;
    const prevNavigator = (globalThis as any).navigator;
    const prevHTMLElement = (globalThis as any).HTMLElement;
    const prevElement = (globalThis as any).Element;
    const prevNode = (globalThis as any).Node;
    const prevResizeObserver = (globalThis as any).ResizeObserver;
    const prevRaf = (globalThis as any).requestAnimationFrame;
    const prevCaf = (globalThis as any).cancelAnimationFrame;
    const prevActEnv = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;

    (globalThis as any).window = dom.window;
    (globalThis as any).document = dom.window.document;
    Object.defineProperty(globalThis, 'navigator', {
      value: dom.window.navigator,
      configurable: true,
      writable: true,
    });
    (globalThis as any).HTMLElement = dom.window.HTMLElement;
    (globalThis as any).Element = dom.window.Element;
    (globalThis as any).Node = dom.window.Node;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    let latestRafCallback: ((now: number) => void) | null = null;
    (globalThis as any).requestAnimationFrame = (cb: (now: number) => void) => {
      latestRafCallback = cb;
      return 1;
    };
    (globalThis as any).cancelAnimationFrame = () => {};

    const container = dom.window.document.getElementById('root')!;
    const root = createRoot(container);

    const openedPhotoIds: string[] = [];
    const StatefulTimelineWrapper: React.FC = () => {
      const [mode, setMode] = React.useState<'compact' | 'proportional'>('compact');
      return React.createElement(TimelineView, {
        photos,
        selectedIds: new Set<string>(),
        onToggleSelect: () => {},
        onSelectGroup: () => {},
        onOpenPhoto: (photo) => {
          openedPhotoIds.push(photo.id);
        },
        spacingMode: mode,
        onChangeSpacingMode: setMode,
      });
    };

    try {
      await act(async () => {
        root.render(React.createElement(StatefulTimelineWrapper));
      });

      const canvas = container.querySelector('[data-testid="timeline-canvas"]') as HTMLElement;
      const transformLayer = container.querySelector(
        '[data-testid="timeline-transform-layer"]'
      ) as HTMLElement;
      expect(canvas).toBeTruthy();
      expect(transformLayer).toBeTruthy();

      // Verify orientation direction legend is removed and view options bar is right-aligned, collapsed by default, and overlaps top time cards
      expect(canvas.textContent).not.toContain('Oldest (L)');
      expect(canvas.textContent).not.toContain('Strings:');
      const topOverlay = container.querySelector('[data-testid="timeline-top-overlay"]') as HTMLElement;
      const optionsBar = container.querySelector('[data-testid="timeline-view-options-bar"]') as HTMLElement;
      const optionsPanel = container.querySelector('[data-testid="timeline-options-panel"]') as HTMLElement;
      const settingsBtn = container.querySelector('[data-testid="timeline-settings-btn"]') as HTMLElement;
      expect(topOverlay).toBeTruthy();
      expect(topOverlay.className).toContain('justify-end');
      expect(topOverlay.className).toContain('z-40');
      expect(optionsBar).toBeTruthy();
      expect(optionsBar.className).toContain('justify-end');
      expect(optionsBar.className).toContain('ml-auto');
      expect(optionsPanel).toBeTruthy();
      expect(settingsBtn).toBeTruthy();

      // Collapsed by default: settings button is shown, options panel is collapsed (max-w-0 opacity-0)
      expect(optionsBar.getAttribute('data-expanded')).toBe('false');
      expect(settingsBtn.getAttribute('aria-expanded')).toBe('false');
      expect(settingsBtn.className).toContain('gap-1.5');
      expect(optionsPanel.className).toContain('transition-all');
      expect(optionsPanel.className).toContain('duration-300');
      expect(optionsPanel.className).toContain('ease-out');
      expect(optionsPanel.className).toContain('max-w-0');
      expect(optionsPanel.className).toContain('opacity-0');
      expect(optionsPanel.className).toContain('scale-95');
      expect(optionsPanel.className).toContain('translate-x-3');
      expect(optionsPanel.className).toContain('pointer-events-none');

      // Hovering settings button / options bar expands the options bar with natural transitions
      await act(async () => {
        settingsBtn.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
      });
      expect(optionsBar.getAttribute('data-expanded')).toBe('true');
      expect(settingsBtn.getAttribute('aria-expanded')).toBe('true');
      expect(settingsBtn.className).toContain('gap-0');
      expect(optionsPanel.className).toContain('opacity-100');
      expect(optionsPanel.className).toContain('scale-100');
      expect(optionsPanel.className).toContain('translate-x-0');
      expect(optionsPanel.className).toContain('max-w-[90vw]');
      expect(optionsPanel.className).toContain('pointer-events-auto');

      // Clicking the settings button after hovering it (or tapping on hybrid devices) must keep the bar expanded
      await act(async () => {
        settingsBtn.click();
      });
      expect(optionsBar.getAttribute('data-expanded')).toBe('true');
      expect(settingsBtn.getAttribute('aria-expanded')).toBe('true');

      // Unhovering the options bar collapses it back with transitions
      await act(async () => {
        optionsBar.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true }));
      });
      expect(optionsBar.getAttribute('data-expanded')).toBe('false');
      expect(settingsBtn.getAttribute('aria-expanded')).toBe('false');
      expect(settingsBtn.className).toContain('gap-1.5');
      expect(optionsPanel.className).toContain('max-w-0');
      expect(optionsPanel.className).toContain('opacity-0');

      // Verify transform layer sits near the top (top-4, z-10) so top time cards (z-10) overlap cleanly beneath floating settings bar (top-3.5, z-40)
      expect(topOverlay.className).toContain('top-3.5');
      expect(transformLayer.className).toContain('top-4');
      expect(transformLayer.className).toContain('z-10');

      // 1. Initial state at 100% zoom: Daily strings (9 columns), pan.y = 0, centered pan.x, time card size = 216x56
      expect(canvas.getAttribute('data-granularity')).toBe('day');
      expect(transformLayer.getAttribute('data-pan-y')).toBe('0');
      expect(transformLayer.style.transform).toContain('0px, 0');

      const initialDayCols = container.querySelectorAll('[data-testid^="timeline-day-column-"]');
      expect(initialDayCols.length).toBe(9);

      // Verify timeline is centered on the 1280px screen instead of left-aligned:
      // 9 compact columns at 100% zoom -> total width = 8 * 256 + 216 = 2264px -> centered pan.x = (1280 - 2264) / 2 = -492px
      const expectedCenteredPanX = computeCenteredTimelinePanX(8 * 256 + BASE_TIME_CARD_WIDTH_PX, 1280);
      expect(expectedCenteredPanX).toBe(-492);
      expect(Number(transformLayer.getAttribute('data-pan-x'))).toBe(expectedCenteredPanX);

      const firstTimeCard = container.querySelector(
        '[data-testid^="timeline-time-card-"]'
      ) as HTMLElement;
      const firstDayCol = container.querySelector(
        '[data-testid^="timeline-day-column-"]'
      ) as HTMLElement;
      const firstStringViewport = container.querySelector(
        '[data-testid^="timeline-string-viewport-"]'
      ) as HTMLElement;
      const firstPhotoCard = container.querySelector(
        '[data-testid^="timeline-photo-card-"]'
      ) as HTMLElement;
      expect(firstTimeCard).toBeTruthy();
      expect(firstDayCol).toBeTruthy();
      expect(firstStringViewport).toBeTruthy();
      expect(firstPhotoCard).toBeTruthy();
      expect(Number(firstTimeCard.getAttribute('data-card-width'))).toBe(BASE_TIME_CARD_WIDTH_PX);
      expect(Number(firstTimeCard.getAttribute('data-card-height'))).toBe(BASE_TIME_CARD_HEIGHT_PX);
      expect(firstTimeCard.style.transform).toBe('');
      expect(firstTimeCard.innerHTML).not.toContain('scale(');

      // Verify smooth zoom/pan transition classes when not dragging
      expect(transformLayer.className).toContain('transition-transform');
      expect(transformLayer.className).toContain('duration-300');
      expect(transformLayer.className).toContain('ease-out');
      expect(firstDayCol.className).toContain('transition-[left,width]');
      expect(firstDayCol.className).toContain('duration-300');
      expect(firstDayCol.className).toContain('ease-out');
      expect(firstTimeCard.className).toContain('transition-all');
      expect(firstTimeCard.className).toContain('duration-300');
      expect(firstTimeCard.className).toContain('ease-out');
      expect(firstStringViewport.className).toContain('duration-300');
      expect(firstStringViewport.className).toContain('ease-out');
      expect(firstPhotoCard.className).toContain('transition-[height]');
      expect(firstPhotoCard.className).toContain('duration-300');
      expect(firstPhotoCard.className).toContain('ease-out');

      // Verify zooming in (e.g. 100% -> 130%) scales the time card natively via layout width/height/fontSize without CSS transform: scale(...)
      const zoomInBtn = container.querySelector('[data-testid="timeline-zoom-in"]') as HTMLElement;
      await act(async () => {
        zoomInBtn.click(); // 1.15
        zoomInBtn.click(); // 1.30
      });
      const zoomedInTimeCard = container.querySelector(
        '[data-testid^="timeline-time-card-"]'
      ) as HTMLElement;
      const zoomedInDayCol = container.querySelector(
        '[data-testid^="timeline-day-column-"]'
      ) as HTMLElement;
      const widthAt130 = Number(zoomedInTimeCard.getAttribute('data-card-width'));
      const heightAt130 = Number(zoomedInTimeCard.getAttribute('data-card-height'));
      expect(widthAt130).toBeGreaterThan(BASE_TIME_CARD_WIDTH_PX);
      expect(heightAt130).toBeGreaterThan(BASE_TIME_CARD_HEIGHT_PX);
      expect(zoomedInTimeCard.style.width).toBe(`${widthAt130}px`);
      expect(zoomedInTimeCard.style.height).toBe(`${heightAt130}px`);
      expect(zoomedInTimeCard.style.transform).toBe('');
      expect(zoomedInTimeCard.innerHTML).not.toContain('scale(');
      expect(zoomedInDayCol.className).toContain('duration-300');
      expect(zoomedInDayCol.className).toContain('ease-out');
      expect(zoomedInTimeCard.className).toContain('duration-300');
      expect(zoomedInTimeCard.className).toContain('ease-out');

      // Verify zooming all the way to MAX_TIMELINE_ZOOM (225%) keeps native layout dimensions (486x126) with no scale(...)
      await act(async () => {
        for (let step = 0; step < 10; step++) {
          zoomInBtn.click();
        }
      });
      const maxZoomTimeCard = container.querySelector(
        '[data-testid^="timeline-time-card-"]'
      ) as HTMLElement;
      const metricsMax = getTimelineZoomMetrics(MAX_TIMELINE_ZOOM);
      expect(Number(maxZoomTimeCard.getAttribute('data-card-width'))).toBe(metricsMax.columnWidthPx);
      expect(Number(maxZoomTimeCard.getAttribute('data-card-height'))).toBe(metricsMax.cardHeightPx);
      expect(maxZoomTimeCard.style.width).toBe(`${metricsMax.columnWidthPx}px`);
      expect(maxZoomTimeCard.style.height).toBe(`${metricsMax.cardHeightPx}px`);
      expect(maxZoomTimeCard.style.transform).toBe('');
      expect(maxZoomTimeCard.innerHTML).not.toContain('scale(');

      // Reset back to 100% zoom before testing drag and zoom-out
      const resetViewBtnInitial = container.querySelector('[data-testid="timeline-reset-view"]') as HTMLElement;
      await act(async () => {
        resetViewBtnInitial.click();
      });

      // 2. Pointer dragging with large vertical delta (+320px Y and -150px X) ONLY moves horizontally; pan.y stays 0
      // During active drag, transform transition is disabled ('transition-none') for instant 1:1 tracking
      const panXBeforeDrag = Number(transformLayer.getAttribute('data-pan-x'));
      await act(async () => {
        canvas.dispatchEvent(
          new dom.window.MouseEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: 500,
            clientY: 200,
          })
        );
      });
      expect(transformLayer.className).toContain('transition-none');
      expect(transformLayer.className).not.toContain('transition-transform');
      await act(async () => {
        canvas.dispatchEvent(
          new dom.window.MouseEvent('pointermove', {
            bubbles: true,
            button: 0,
            clientX: 350,
            clientY: 520, // +320px vertical drag attempt
          })
        );
      });
      await act(async () => {
        canvas.dispatchEvent(
          new dom.window.MouseEvent('pointerup', {
            bubbles: true,
            button: 0,
          })
        );
      });
      expect(transformLayer.className).toContain('transition-transform');
      expect(transformLayer.className).toContain('duration-300');
      expect(transformLayer.className).toContain('ease-out');

      const panXAfterDrag = Number(transformLayer.getAttribute('data-pan-x'));
      expect(panXAfterDrag).toBeLessThan(panXBeforeDrag);
      expect(transformLayer.getAttribute('data-pan-y')).toBe('0');
      expect(transformLayer.style.transform).toBe(`translate3d(${panXAfterDrag}px, 0px, 0)`);

      // 3. Zooming out slightly (100% -> 85% -> 70%) resizes time cards in place without moving them vertically or changing granularity yet
      const zoomOutBtn = container.querySelector('[data-testid="timeline-zoom-out"]') as HTMLElement;
      await act(async () => {
        zoomOutBtn.click(); // 0.85
      });
      expect(canvas.getAttribute('data-granularity')).toBe('day');
      expect(transformLayer.getAttribute('data-pan-y')).toBe('0');

      const resizedTimeCard = container.querySelector(
        '[data-testid^="timeline-time-card-"]'
      ) as HTMLElement;
      const widthAt85 = Number(resizedTimeCard.getAttribute('data-card-width'));
      const heightAt85 = Number(resizedTimeCard.getAttribute('data-card-height'));
      expect(widthAt85).toBeLessThan(BASE_TIME_CARD_WIDTH_PX);
      expect(heightAt85).toBeLessThan(BASE_TIME_CARD_HEIGHT_PX);
      expect(resizedTimeCard.style.transform).toBe('');
      expect(resizedTimeCard.innerHTML).not.toContain('scale(');
      expect(resizedTimeCard.className).toContain('duration-300');
      expect(resizedTimeCard.className).toContain('ease-out');
      // Column remains anchored at top: 0 and scales card slot height proportionally
      const firstColEl = container.querySelector(
        '[data-testid^="timeline-day-column-"]'
      ) as HTMLElement;
      expect(firstColEl.className).toContain('top-0');
      expect(firstColEl.className).toContain('duration-300');
      expect(firstColEl.className).toContain('ease-out');
      expect(Number(firstColEl.getAttribute('data-card-slot-height'))).toBeLessThan(192);

      // 4. Zooming out further triggers automatic merging: Daily (9) -> Weekly (7) -> Monthly (7) -> Yearly (2)
      await act(async () => {
        zoomOutBtn.click(); // 0.70 (still 'day')
      });
      expect(canvas.getAttribute('data-granularity')).toBe('day');
      expect(canvas.getAttribute('data-transition-mode')).toBe('steady');
      expect(container.querySelector('[data-testid="timeline-merge-ghosts-layer"]')).toBeNull();

      const day14BeforeMerge = container.querySelector(
        '[data-testid="timeline-day-column-2025-03-14"]'
      ) as HTMLElement;
      const day15BeforeMerge = container.querySelector(
        '[data-testid="timeline-day-column-2025-03-15"]'
      ) as HTMLElement;
      const day14PhaseBefore = Number(day14BeforeMerge.getAttribute('data-phase'));
      const day15PhaseBefore = Number(day15BeforeMerge.getAttribute('data-phase'));
      const expectedMergedPhase = Number(((day14PhaseBefore + day15PhaseBefore) / 2).toFixed(2));

      await act(async () => {
        zoomOutBtn.click(); // 0.55 -> merges to 'week'
      });
      expect(canvas.getAttribute('data-granularity')).toBe('week');
      expect(canvas.getAttribute('data-transition-mode')).toBe('merge');
      const weekDomCols = container.querySelectorAll('[data-testid^="timeline-day-column-"]');
      expect(weekDomCols.length).toBe(7);
      expect(transformLayer.getAttribute('data-pan-y')).toBe('0');

      const mergedWeekColEl = container.querySelector(
        '[data-testid="timeline-day-column-2025-W11"]'
      ) as HTMLElement;
      expect(mergedWeekColEl).toBeTruthy();
      expect(mergedWeekColEl.getAttribute('data-transition-mode')).toBe('merge');
      expect(mergedWeekColEl.className).toContain('timeline-column-merge-enter');
      expect(Number(mergedWeekColEl.getAttribute('data-merge-source-count'))).toBe(2);
      expect(Number(mergedWeekColEl.getAttribute('data-merge-delta-x'))).toBeGreaterThan(0);
      expect(mergedWeekColEl.style.getPropertyValue('--merge-delta-x')).toContain('px');
      // Phase continuity on merge: 2025-W11 inherits average phase of 2025-03-14 and 2025-03-15 on the first frame
      expect(Number(mergedWeekColEl.getAttribute('data-phase'))).toBeCloseTo(expectedMergedPhase, 1);

      const ghostsLayer = container.querySelector(
        '[data-testid="timeline-merge-ghosts-layer"]'
      ) as HTMLElement;
      expect(ghostsLayer).toBeTruthy();
      const ghostCols = container.querySelectorAll('[data-testid^="timeline-merge-ghost-"]');
      expect(ghostCols.length).toBe(9);
      const ghost2025_03_15 = container.querySelector(
        '[data-testid="timeline-merge-ghost-2025-03-15"]'
      ) as HTMLElement;
      expect(ghost2025_03_15).toBeTruthy();
      expect(ghost2025_03_15.className).toContain('timeline-ghost-converge');
      expect(ghost2025_03_15.getAttribute('data-target-key')).toBe('2025-W11');
      expect(Number(ghost2025_03_15.getAttribute('data-delta-x'))).toBeLessThan(0);

      // Advance phase while in 'week' mode via bottom-end fast-forward on 2025-W11
      const week11BottomEnd = container.querySelector(
        '[data-testid="string-bottom-end-2025-W11"]'
      ) as HTMLElement;
      await act(async () => {
        week11BottomEnd.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
      });
      const week11AdvancedPhase = Number(mergedWeekColEl.getAttribute('data-phase'));
      expect(week11AdvancedPhase).toBeGreaterThan(expectedMergedPhase + 2);

      // Toggling spacingMode ('compact' -> 'proportional' -> 'compact') mid-transition keeps ghost & column deltas synced
      const propBtnMid = container.querySelector('[data-testid="spacing-proportional-btn"]') as HTMLElement;
      const compactBtnMid = container.querySelector('[data-testid="spacing-compact-btn"]') as HTMLElement;
      const ghostLaterDay = container.querySelector(
        '[data-testid="timeline-merge-ghost-2025-05-20"]'
      ) as HTMLElement;
      const compactGhostDelta = Number(ghostLaterDay.getAttribute('data-delta-x'));
      await act(async () => {
        propBtnMid.click();
      });
      const propGhostDelta = Number(ghostLaterDay.getAttribute('data-delta-x'));
      expect(propGhostDelta).not.toBe(compactGhostDelta);
      await act(async () => {
        compactBtnMid.click();
      });
      expect(Number(ghostLaterDay.getAttribute('data-delta-x'))).toBe(compactGhostDelta);

      // Zooming back in across threshold (0.55 'week' -> 0.70 'day') triggers 'unmerge' fan-out transition
      // and inherits the updated 2025-W11 phase into both unmerged child daily columns
      await act(async () => {
        zoomInBtn.click(); // 0.70 -> unmerges back to 'day'
      });
      expect(canvas.getAttribute('data-granularity')).toBe('day');
      expect(canvas.getAttribute('data-transition-mode')).toBe('unmerge');
      const unmergedDay14El = container.querySelector(
        '[data-testid="timeline-day-column-2025-03-14"]'
      ) as HTMLElement;
      const unmergedDayColEl = container.querySelector(
        '[data-testid="timeline-day-column-2025-03-15"]'
      ) as HTMLElement;
      expect(unmergedDayColEl.getAttribute('data-transition-mode')).toBe('unmerge');
      expect(unmergedDayColEl.className).toContain('timeline-column-unmerge-enter');
      expect(Number(unmergedDayColEl.getAttribute('data-merge-delta-x'))).toBeLessThan(0);
      expect(Number(unmergedDay14El.getAttribute('data-phase'))).toBeCloseTo(week11AdvancedPhase, 1);
      expect(Number(unmergedDayColEl.getAttribute('data-phase'))).toBeCloseTo(week11AdvancedPhase, 1);
      expect(
        container.querySelectorAll('[data-testid^="timeline-merge-ghost-"]').length
      ).toBe(7);

      // Verify transition auto-clears back to 'steady' and removes ghost layer after 380ms timeout
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 410));
      });
      expect(canvas.getAttribute('data-transition-mode')).toBe('steady');
      expect(container.querySelector('[data-testid="timeline-merge-ghosts-layer"]')).toBeNull();

      // Zoom back out through week -> month -> year
      await act(async () => {
        zoomOutBtn.click(); // 0.55 -> merges to 'week'
      });
      expect(canvas.getAttribute('data-granularity')).toBe('week');

      await act(async () => {
        zoomOutBtn.click(); // 0.40 -> merges to 'month'
      });
      expect(canvas.getAttribute('data-granularity')).toBe('month');
      expect(canvas.getAttribute('data-transition-mode')).toBe('merge');
      const monthDomCols = container.querySelectorAll('[data-testid^="timeline-day-column-"]');
      expect(monthDomCols.length).toBe(7);
      expect(monthDomCols[0].getAttribute('data-day-key')).toBe('2025-03');

      await act(async () => {
        zoomOutBtn.click(); // 0.25 -> merges to 'year'
      });
      expect(canvas.getAttribute('data-granularity')).toBe('year');
      expect(canvas.getAttribute('data-transition-mode')).toBe('merge');
      const yearDomCols = container.querySelectorAll('[data-testid^="timeline-day-column-"]');
      expect(yearDomCols.length).toBe(2);
      expect(yearDomCols[0].getAttribute('data-day-key')).toBe('2025');
      expect(yearDomCols[1].getAttribute('data-day-key')).toBe('2026');
      expect(transformLayer.getAttribute('data-pan-y')).toBe('0');
      // When zoomed out to 2 yearly strings (total width narrower than the 1280px screen), timeline centers horizontally
      const yearlyPanX = Number(transformLayer.getAttribute('data-pan-x'));
      const metricsAt25 = getTimelineZoomMetrics(0.25);
      const yearlyTimelineWidth = metricsAt25.columnStepPx + metricsAt25.columnWidthPx;
      expect(yearlyPanX).toBe(computeCenteredTimelinePanX(yearlyTimelineWidth, 1280));
      expect(yearlyPanX).toBeGreaterThan(400);

      // 5. Reset view restores 100% zoom, Daily strings (9 columns), centered pan.x, pan.y = 0, and clears active transition
      const resetBtn = container.querySelector('[data-testid="timeline-reset-view"]') as HTMLElement;
      await act(async () => {
        resetBtn.click();
      });
      expect(canvas.getAttribute('data-granularity')).toBe('day');
      expect(canvas.getAttribute('data-transition-mode')).toBe('steady');
      expect(container.querySelector('[data-testid="timeline-merge-ghosts-layer"]')).toBeNull();
      expect(container.querySelectorAll('[data-testid^="timeline-day-column-"]').length).toBe(9);
      expect(Number(transformLayer.getAttribute('data-pan-x'))).toBe(expectedCenteredPanX);
      expect(transformLayer.getAttribute('data-pan-y')).toBe('0');

      // 6. Fast-backward and fast-forward when hovering on the two ends of a string
      const col2025_03_14 = container.querySelector(
        '[data-testid="timeline-day-column-2025-03-14"]'
      ) as HTMLElement;
      const topEndEl = container.querySelector(
        '[data-testid="string-top-end-2025-03-14"]'
      ) as HTMLElement;
      const bottomEndEl = container.querySelector(
        '[data-testid="string-bottom-end-2025-03-14"]'
      ) as HTMLElement;
      expect(col2025_03_14).toBeTruthy();
      expect(topEndEl).toBeTruthy();
      expect(bottomEndEl).toBeTruthy();

      const baseSpeed = Number(col2025_03_14.getAttribute('data-speed'));
      const phaseInitial = Number(col2025_03_14.getAttribute('data-phase'));
      expect(col2025_03_14.getAttribute('data-flow-mode')).toBe('normal');
      expect(Number(col2025_03_14.getAttribute('data-flow-velocity'))).toBe(baseSpeed);

      // Hover top end of string -> fast-backward (negative velocity, phase rewinds upwards)
      await act(async () => {
        topEndEl.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
      });
      const phaseAfterTopHover = Number(col2025_03_14.getAttribute('data-phase'));
      expect(col2025_03_14.getAttribute('data-flow-mode')).toBe('fast-backward');
      expect(Number(col2025_03_14.getAttribute('data-flow-velocity'))).toBeCloseTo(
        -baseSpeed * FAST_STRING_FLOW_MULTIPLIER,
        1
      );
      expect(phaseAfterTopHover).toBeLessThan(phaseInitial);

      // Leave top end -> returns to normal/slow column flow
      await act(async () => {
        topEndEl.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true }));
      });
      expect(col2025_03_14.getAttribute('data-flow-mode')).not.toBe('fast-backward');

      // Hover bottom end of string -> fast-forward (positive +4.5x velocity, phase advances downwards)
      await act(async () => {
        bottomEndEl.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
      });
      const phaseAfterBottomHover = Number(col2025_03_14.getAttribute('data-phase'));
      expect(col2025_03_14.getAttribute('data-flow-mode')).toBe('fast-forward');
      expect(Number(col2025_03_14.getAttribute('data-flow-velocity'))).toBeCloseTo(
        baseSpeed * FAST_STRING_FLOW_MULTIPLIER,
        1
      );
      expect(phaseAfterBottomHover).toBeGreaterThan(phaseAfterTopHover);

      // 7. Zooming across granularity boundaries while hovering a daily string end clears stale hover state cleanly
      await act(async () => {
        zoomOutBtn.click(); // 0.85
        zoomOutBtn.click(); // 0.70
        zoomOutBtn.click(); // 0.55 -> 'week' (2025-03-14 unmounts into 2025-W11)
      });
      expect(canvas.getAttribute('data-granularity')).toBe('week');
      const weekCol0 = container.querySelector(
        '[data-testid="timeline-day-column-2025-W11"]'
      ) as HTMLElement;
      expect(weekCol0).toBeTruthy();
      expect(weekCol0.getAttribute('data-flow-mode')).toBe('normal');

      await act(async () => {
        resetBtn.click();
      });

      // 8. Speed slider, flow pause toggle, and reset button update string flow speed & settings in real time
      const speedSlider = container.querySelector(
        '[data-testid="timeline-speed-slider"]'
      ) as HTMLInputElement;
      const speedValue = container.querySelector(
        '[data-testid="timeline-speed-value"]'
      ) as HTMLElement;
      const toggleFlowBtn = container.querySelector(
        '[data-testid="toggle-flow-btn"]'
      ) as HTMLElement;
      const propSpacingBtn = container.querySelector(
        '[data-testid="spacing-proportional-btn"]'
      ) as HTMLElement;
      const colAfterReset = container.querySelector(
        '[data-testid="timeline-day-column-2025-03-14"]'
      ) as HTMLElement;
      const speedLabel = container.querySelector(
        '[data-testid="timeline-speed-label-2025-03-14"]'
      ) as HTMLElement;

      expect(speedSlider).toBeTruthy();
      expect(speedValue).toBeTruthy();
      expect(toggleFlowBtn).toBeTruthy();
      expect(colAfterReset).toBeTruthy();
      expect(speedLabel).toBeTruthy();
      expect(speedSlider.value).toBe('1');
      expect(speedValue.textContent).toBe('1.0x');
      expect(Number(colAfterReset.getAttribute('data-base-speed'))).toBe(baseSpeed);
      expect(Number(colAfterReset.getAttribute('data-speed'))).toBe(baseSpeed);
      expect(Number(colAfterReset.getAttribute('data-flow-velocity'))).toBe(baseSpeed);
      expect(speedLabel.textContent).toBe(`↓ ${baseSpeed}px/s`);

      // Change speed slider to 1.25x (quarter-step formatting) and then 2x
      await act(async () => {
        speedSlider.value = '1.25';
        speedSlider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
      const expectedSpeed125 = Number((baseSpeed * 1.25).toFixed(1));
      expect(speedSlider.value).toBe('1.25');
      expect(speedValue.textContent).toBe('1.25x');
      expect(Number(colAfterReset.getAttribute('data-speed'))).toBe(expectedSpeed125);
      expect(speedLabel.textContent).toBe(`↓ ${expectedSpeed125}px/s`);

      await act(async () => {
        speedSlider.value = '2';
        speedSlider.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      });
      const expectedSpeed2x = Number((baseSpeed * 2).toFixed(1));
      expect(speedSlider.value).toBe('2');
      expect(speedValue.textContent).toBe('2.0x');
      expect(Number(colAfterReset.getAttribute('data-speed'))).toBe(expectedSpeed2x);
      expect(Number(colAfterReset.getAttribute('data-flow-velocity'))).toBeCloseTo(
        baseSpeed * 2,
        1
      );
      expect(speedLabel.textContent).toBe(`↓ ${expectedSpeed2x}px/s`);

      // Verify requestAnimationFrame tick advances phase using the updated 2x speedMultiplier
      const phaseBeforeTick = Number(colAfterReset.getAttribute('data-phase'));
      await act(async () => {
        latestRafCallback?.(performance.now() + 50);
      });
      const phaseAfterTick = Number(colAfterReset.getAttribute('data-phase'));
      expect(phaseAfterTick).toBeGreaterThan(phaseBeforeTick);

      // Pause flow -> velocity drops to 0 and time card label shows paused state
      await act(async () => {
        toggleFlowBtn.click();
      });
      expect(colAfterReset.getAttribute('data-flow-mode')).toBe('paused');
      expect(Number(colAfterReset.getAttribute('data-flow-velocity'))).toBe(0);
      expect(speedLabel.textContent).toBe('⏸ 0px/s');

      // Also switch spacing mode to proportional and zoom in before clicking reset
      await act(async () => {
        propSpacingBtn.click();
        zoomInBtn.click();
      });
      expect(Number(transformLayer.getAttribute('data-zoom'))).toBeGreaterThan(1);

      // Clicking reset restores speed slider back to 1 (1.0x), resumes flow, resets spacing mode & zoom, and restores 1x column speed
      await act(async () => {
        resetBtn.click();
      });
      expect(speedSlider.value).toBe('1');
      expect(speedValue.textContent).toBe('1.0x');
      expect(colAfterReset.getAttribute('data-flow-mode')).toBe('normal');
      expect(Number(colAfterReset.getAttribute('data-speed'))).toBe(baseSpeed);
      expect(Number(colAfterReset.getAttribute('data-flow-velocity'))).toBe(baseSpeed);
      expect(speedLabel.textContent).toBe(`↓ ${baseSpeed}px/s`);
      expect(Number(transformLayer.getAttribute('data-zoom'))).toBe(1);
      expect(Number(transformLayer.getAttribute('data-pan-x'))).toBe(expectedCenteredPanX);

      // 8b. Vertical drag/swipe on a string fast-forwards (downward swipe) or fast-backwards (upward swipe) with smooth decay back to normal speed
      const stringViewport14 = container.querySelector(
        '[data-testid="timeline-string-viewport-2025-03-14"]'
      ) as HTMLElement;
      const photoCardIn14 = stringViewport14.querySelector(
        '[data-testid^="timeline-photo-card-"]'
      ) as HTMLElement;
      expect(stringViewport14).toBeTruthy();
      expect(photoCardIn14).toBeTruthy();
      expect(Number(colAfterReset.getAttribute('data-swipe-boost'))).toBe(0);

      // Multi-step downward vertical drag/swipe starting with small initial move (+3px Y, +2px X) followed by (+90px Y, +2px X) on string 2025-03-14
      const phaseBeforeDownSwipe = Number(colAfterReset.getAttribute('data-phase'));
      await act(async () => {
        stringViewport14.dispatchEvent(
          new dom.window.MouseEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: 200,
            clientY: 200,
          })
        );
      });
      await act(async () => {
        canvas.dispatchEvent(
          new dom.window.MouseEvent('pointermove', {
            bubbles: true,
            button: 0,
            clientX: 202,
            clientY: 203,
          })
        );
      });
      // Even during the sub-threshold disambiguation step (dy=3, dx=2), horizontal canvas pan must NOT drift
      expect(Number(transformLayer.getAttribute('data-pan-x'))).toBe(expectedCenteredPanX);
      await act(async () => {
        canvas.dispatchEvent(
          new dom.window.MouseEvent('pointermove', {
            bubbles: true,
            button: 0,
            clientX: 202,
            clientY: 290,
          })
        );
      });
      await act(async () => {
        canvas.dispatchEvent(
          new dom.window.MouseEvent('pointerup', {
            bubbles: true,
            button: 0,
          })
        );
      });

      // Horizontal canvas pan must remain unchanged during a vertical string swipe
      expect(Number(transformLayer.getAttribute('data-pan-x'))).toBe(expectedCenteredPanX);
      const phaseAfterDownSwipe = Number(colAfterReset.getAttribute('data-phase'));
      const boostAfterDownSwipe = Number(colAfterReset.getAttribute('data-swipe-boost'));
      const velocityAfterDownSwipe = Number(colAfterReset.getAttribute('data-flow-velocity'));
      expect(phaseAfterDownSwipe).toBeGreaterThanOrEqual(phaseBeforeDownSwipe + 85);
      expect(boostAfterDownSwipe).toBeGreaterThan(150);
      expect(velocityAfterDownSwipe).toBeCloseTo(baseSpeed + boostAfterDownSwipe, 1);
      expect(colAfterReset.getAttribute('data-flow-mode')).toBe('fast-forward');
      expect(speedLabel.textContent).toContain('↓↓');

      // Step 1 animation frame -> momentum boost decays smoothly (still positive, strictly less than initial boost)
      let simTime = performance.now() + 80;
      await act(async () => {
        latestRafCallback?.(simTime);
      });
      const boostFrame1 = Number(colAfterReset.getAttribute('data-swipe-boost'));
      const velocityFrame1 = Number(colAfterReset.getAttribute('data-flow-velocity'));
      const phaseFrame1 = Number(colAfterReset.getAttribute('data-phase'));
      expect(boostFrame1).toBeGreaterThan(0);
      expect(boostFrame1).toBeLessThan(boostAfterDownSwipe);
      expect(velocityFrame1).toBeCloseTo(baseSpeed + boostFrame1, 1);
      expect(velocityFrame1).toBeGreaterThan(baseSpeed);
      expect(velocityFrame1).toBeLessThan(velocityAfterDownSwipe);
      expect(phaseFrame1).toBeGreaterThan(phaseAfterDownSwipe);

      // Step subsequent animation frames -> momentum smoothly decays all the way back to 0 (normal speed)
      await act(async () => {
        for (let step = 0; step < 35; step++) {
          simTime += 80;
          latestRafCallback?.(simTime);
        }
      });
      expect(Number(colAfterReset.getAttribute('data-swipe-boost'))).toBe(0);
      expect(Number(colAfterReset.getAttribute('data-flow-velocity'))).toBe(baseSpeed);
      expect(colAfterReset.getAttribute('data-flow-mode')).toBe('normal');
      expect(speedLabel.textContent).toBe(`↓ ${baseSpeed}px/s`);

      // Upward vertical drag/swipe (-110px Y) initiated directly on a photo card, crossing string-bottom-end, and released on window:
      // 1) Fast-backwards with negative momentum boost
      // 2) Crossing string-bottom-end during swipe does NOT latch end-hover
      // 3) Synthetic click upon swipe release does NOT open the photo modal
      // 4) Subsequent intentional click on a photo card DOES open the photo modal
      const phaseBeforeUpSwipe = Number(colAfterReset.getAttribute('data-phase'));
      const bottomEndZone14 = container.querySelector(
        '[data-testid="string-bottom-end-2025-03-14"]'
      ) as HTMLElement;
      const photoCardForSwipe = stringViewport14.querySelector(
        '[data-testid^="timeline-photo-card-"]'
      ) as HTMLElement;
      expect(bottomEndZone14).toBeTruthy();
      expect(photoCardForSwipe).toBeTruthy();
      await act(async () => {
        photoCardForSwipe.dispatchEvent(
          new dom.window.MouseEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: 200,
            clientY: 360,
          })
        );
      });
      await act(async () => {
        canvas.dispatchEvent(
          new dom.window.MouseEvent('pointermove', {
            bubbles: true,
            button: 0,
            clientX: 199,
            clientY: 250,
          })
        );
        // Simulate pointer crossing bottom end zone while swipe is active
        bottomEndZone14.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
      });
      await act(async () => {
        // Release pointer on window (simulating release outside canvas) followed by synthetic click on photo card
        dom.window.dispatchEvent(
          new dom.window.MouseEvent('pointerup', {
            bubbles: true,
            button: 0,
          })
        );
        photoCardForSwipe.dispatchEvent(
          new dom.window.MouseEvent('click', {
            bubbles: true,
            button: 0,
          })
        );
      });
      expect(openedPhotoIds.length).toBe(0);

      const phaseAfterUpSwipe = Number(colAfterReset.getAttribute('data-phase'));
      const boostAfterUpSwipe = Number(colAfterReset.getAttribute('data-swipe-boost'));
      const velocityAfterUpSwipe = Number(colAfterReset.getAttribute('data-flow-velocity'));
      expect(phaseAfterUpSwipe).toBeLessThanOrEqual(phaseBeforeUpSwipe - 105);
      expect(boostAfterUpSwipe).toBeLessThan(-150);
      expect(velocityAfterUpSwipe).toBeLessThan(0);
      expect(velocityAfterUpSwipe).toBeCloseTo(baseSpeed + boostAfterUpSwipe, 1);
      expect(colAfterReset.getAttribute('data-flow-mode')).toBe('fast-backward');
      expect(speedLabel.textContent).toContain('↑↑');

      // Step 1 animation frame -> upward momentum decays smoothly toward 0 while still rewinding
      simTime += 80;
      await act(async () => {
        latestRafCallback?.(simTime);
      });
      const upBoostFrame1 = Number(colAfterReset.getAttribute('data-swipe-boost'));
      expect(upBoostFrame1).toBeLessThan(0);
      expect(upBoostFrame1).toBeGreaterThan(boostAfterUpSwipe);

      // Step remaining frames -> upward momentum finishes decaying smoothly (not stuck in bottom end fast-forward hover)
      await act(async () => {
        for (let step = 0; step < 35; step++) {
          simTime += 80;
          latestRafCallback?.(simTime);
        }
      });
      expect(Number(colAfterReset.getAttribute('data-swipe-boost'))).toBe(0);
      expect(colAfterReset.getAttribute('data-flow-mode')).not.toBe('fast-forward');
      await act(async () => {
        colAfterReset.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true }));
      });
      expect(Number(colAfterReset.getAttribute('data-flow-velocity'))).toBe(baseSpeed);
      expect(colAfterReset.getAttribute('data-flow-mode')).toBe('normal');
      expect(speedLabel.textContent).toBe(`↓ ${baseSpeed}px/s`);

      // Subsequent intentional click on a visible photo card must open the photo normally
      const photoCardForClick = stringViewport14.querySelector(
        '[data-testid^="timeline-photo-card-"]'
      ) as HTMLElement;
      expect(photoCardForClick).toBeTruthy();
      await act(async () => {
        photoCardForClick.dispatchEvent(
          new dom.window.MouseEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: 200,
            clientY: 260,
          })
        );
        photoCardForClick.dispatchEvent(
          new dom.window.MouseEvent('pointerup', {
            bubbles: true,
            button: 0,
            clientX: 200,
            clientY: 260,
          })
        );
        photoCardForClick.dispatchEvent(
          new dom.window.MouseEvent('click', {
            bubbles: true,
            button: 0,
          })
        );
      });
      expect(openedPhotoIds.length).toBe(1);

      // Swiping a string while global flow is paused temporarily fast-forwards and smoothly decays back to paused (0px/s)
      await act(async () => {
        toggleFlowBtn.click();
      });
      expect(colAfterReset.getAttribute('data-flow-mode')).toBe('paused');
      await act(async () => {
        stringViewport14.dispatchEvent(
          new dom.window.MouseEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: 200,
            clientY: 200,
          })
        );
        canvas.dispatchEvent(
          new dom.window.MouseEvent('pointermove', {
            bubbles: true,
            button: 0,
            clientX: 200,
            clientY: 280,
          })
        );
        canvas.dispatchEvent(
          new dom.window.MouseEvent('pointerup', {
            bubbles: true,
            button: 0,
          })
        );
      });
      expect(colAfterReset.getAttribute('data-flow-mode')).toBe('fast-forward');
      expect(Number(colAfterReset.getAttribute('data-flow-velocity'))).toBeGreaterThan(100);
      await act(async () => {
        for (let step = 0; step < 35; step++) {
          simTime += 80;
          latestRafCallback?.(simTime);
        }
      });
      expect(Number(colAfterReset.getAttribute('data-swipe-boost'))).toBe(0);
      expect(Number(colAfterReset.getAttribute('data-flow-velocity'))).toBe(0);
      expect(colAfterReset.getAttribute('data-flow-mode')).toBe('paused');
      await act(async () => {
        toggleFlowBtn.click();
      });
      expect(colAfterReset.getAttribute('data-flow-mode')).toBe('normal');

      // 9. Wheel events (both vertical wheel zoom and horizontal trackpad scroll) never shift pan.y from 0
      await act(async () => {
        canvas.dispatchEvent(
          new dom.window.WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            deltaX: 120,
            deltaY: 10,
          })
        );
      });
      expect(transformLayer.getAttribute('data-pan-y')).toBe('0');

      await act(async () => {
        canvas.dispatchEvent(
          new dom.window.WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            deltaX: 0,
            deltaY: 200,
          })
        );
      });
      expect(transformLayer.getAttribute('data-pan-y')).toBe('0');
      expect(Number(transformLayer.getAttribute('data-zoom'))).toBeLessThan(1);
    } finally {
      await act(async () => {
        root.unmount();
      });
      (globalThis as any).window = prevWindow;
      (globalThis as any).document = prevDocument;
      Object.defineProperty(globalThis, 'navigator', {
        value: prevNavigator,
        configurable: true,
        writable: true,
      });
      (globalThis as any).HTMLElement = prevHTMLElement;
      (globalThis as any).Element = prevElement;
      (globalThis as any).Node = prevNode;
      (globalThis as any).ResizeObserver = prevResizeObserver;
      (globalThis as any).requestAnimationFrame = prevRaf;
      (globalThis as any).cancelAnimationFrame = prevCaf;
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = prevActEnv;
    }
  });
});
