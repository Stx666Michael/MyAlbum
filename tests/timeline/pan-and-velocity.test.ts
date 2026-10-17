import { describe, it, expect } from 'vitest';
import {
  FAST_STRING_FLOW_MULTIPLIER,
  STRING_END_ZONE_HEIGHT_PX,
  clampTimelinePanX,
  computeCenteredTimelinePanX,
  computeFlowingCardState,
  computeStringFlowVelocity,
  computeSwipeVelocityBoost,
  decayStringSwipeMomentum,
  resolveStringEndHoverDirection,
} from '../../src/utils/timelineMath.ts';

describe('Timeline: pan clamping and string end velocity', () => {
  it('computes centered timeline pan coordinates and string top/bottom end fast-forward/backward velocities accurately', () => {
    // 1. Centering math for both wider-than-screen and narrower-than-screen timelines
    expect(computeCenteredTimelinePanX(2264, 1280)).toBe(-492);
    expect(computeCenteredTimelinePanX(420, 1280)).toBe(430);
    expect(computeCenteredTimelinePanX(0, 1280)).toBe(640);

    // Clamping preserves the centered position when timeline is narrower than viewport
    expect(clampTimelinePanX(430, 420, 1280)).toBe(430);
    expect(clampTimelinePanX(Number.NaN, 2264, 1280)).toBe(-492);
    // Clamping prevents panning a wide timeline completely off-screen
    expect(clampTimelinePanX(-99999, 2264, 1280)).toBeGreaterThan(-2500);
    expect(clampTimelinePanX(99999, 2264, 1280)).toBeLessThan(300);

    // 2. String end hover zone detection (top end -> 'backward', bottom end -> 'forward', middle -> null)
    expect(resolveStringEndHoverDirection(0, 600, STRING_END_ZONE_HEIGHT_PX)).toBe('backward');
    expect(resolveStringEndHoverDirection(40, 600, STRING_END_ZONE_HEIGHT_PX)).toBe('backward');
    expect(resolveStringEndHoverDirection(300, 600, STRING_END_ZONE_HEIGHT_PX)).toBeNull();
    expect(resolveStringEndHoverDirection(560, 600, STRING_END_ZONE_HEIGHT_PX)).toBe('forward');
    expect(resolveStringEndHoverDirection(600, 600, STRING_END_ZONE_HEIGHT_PX)).toBe('forward');
    expect(resolveStringEndHoverDirection(10, 0, STRING_END_ZONE_HEIGHT_PX)).toBeNull();

    // 3. String flow velocity calculation across normal, slow hover, paused, fast-forward, and fast-backward modes
    const baseSpeed = 30;
    expect(
      computeStringFlowVelocity(baseSpeed, 1, {
        isFlowing: true,
        isColumnHovered: false,
        isPhotoHovered: false,
        endHoverDirection: null,
      })
    ).toBe(30);

    // Fast-backward on top end hover moves upwards (negative velocity) even when global flow is paused
    expect(
      computeStringFlowVelocity(baseSpeed, 1, {
        isFlowing: false,
        isColumnHovered: true,
        isPhotoHovered: false,
        endHoverDirection: 'backward',
      })
    ).toBe(-30 * FAST_STRING_FLOW_MULTIPLIER);

    // Fast-forward on bottom end hover moves downwards at +4.5x speed
    expect(
      computeStringFlowVelocity(baseSpeed, 1, {
        isFlowing: true,
        isColumnHovered: true,
        isPhotoHovered: false,
        endHoverDirection: 'forward',
      })
    ).toBe(30 * FAST_STRING_FLOW_MULTIPLIER);

    // 4. Vertical drag/swipe velocity boost and smooth exponential momentum decay
    const downBoost = computeSwipeVelocityBoost(48, 32, 0);
    const upBoost = computeSwipeVelocityBoost(-48, 32, 0);
    expect(downBoost).toBeGreaterThan(200);
    expect(upBoost).toBeLessThan(-200);
    expect(upBoost).toBe(-downBoost);
    expect(computeSwipeVelocityBoost(0, 32, 120)).toBe(120);
    expect(computeSwipeVelocityBoost(0, 32, 1.0)).toBe(0);
    expect(computeSwipeVelocityBoost(50000, 8, 0)).toBe(960);
    expect(computeSwipeVelocityBoost(-50000, 8, 0)).toBe(-960);

    //Swipe boost adds directly to steady velocity and overrides hover slowdown while active
    expect(
      computeStringFlowVelocity(baseSpeed, 1, {
        isFlowing: true,
        isColumnHovered: true,
        isPhotoHovered: true,
        endHoverDirection: null,
        swipeBoostPxPerSec: 180,
      })
    ).toBe(210);
    expect(
      computeStringFlowVelocity(baseSpeed, 1, {
        isFlowing: true,
        isColumnHovered: true,
        isPhotoHovered: false,
        endHoverDirection: null,
        swipeBoostPxPerSec: -180,
      })
    ).toBe(-150);

    // Exponential decay reduces boost smoothly frame-over-frame and snaps cleanly to 0 below threshold
    const d1 = decayStringSwipeMomentum(300, 0.1);
    const d2 = decayStringSwipeMomentum(d1, 0.1);
    expect(d1).toBeGreaterThan(0);
    expect(d1).toBeLessThan(300);
    expect(d2).toBeGreaterThan(0);
    expect(d2).toBeLessThan(d1);
    expect(decayStringSwipeMomentum(-300, 0.1)).toBe(-d1);
    expect(decayStringSwipeMomentum(1.0, 0.1)).toBe(0);
    expect(decayStringSwipeMomentum(Number.NaN, 0.1)).toBe(0);

    // Negative phase offsets (from rewinding/fast-backward) wrap cleanly in computeFlowingCardState
    const cardAtNegPhase = computeFlowingCardState(0, 6, -120, 640, 192);
    expect(Number.isFinite(cardAtNegPhase.y)).toBe(true);
    expect(cardAtNegPhase.y).toBeGreaterThanOrEqual(-192);
  });
});
