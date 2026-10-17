import React, { useEffect, useMemo, useState } from 'react';
import {
  Clock,
  MapPin,
  X,
  Check,
  RotateCcw,
  Trash2,
  ArrowRight,
  Calendar,
  Sliders,
  Crosshair,
  Sparkles,
} from 'lucide-react';
import type {
  BatchLocationEdit,
  BatchTimeEdit,
  PhotoItem,
} from '../types/photo.ts';
import {
  formatWallClockDateTime,
  getWallClockParts,
} from '../utils/timelineMath.ts';

interface BatchEditModalProps {
  isOpen: boolean;
  initialTab: 'time' | 'location';
  selectedPhotos: PhotoItem[];
  onClose: () => void;
  onApplyBatch: (options: {
    timeEdit?: BatchTimeEdit;
    locationEdit?: BatchLocationEdit;
  }) => Promise<void>;
  onSwitchToMapPinPicker: () => void;
  onOpenAutoLocate?: () => void;
}

const WORLD_PRESETS = [
  { name: 'Shibuya Crossing, Tokyo', lat: 35.6595, lng: 139.7004 },
  { name: 'Tour Eiffel, Paris', lat: 48.8584, lng: 2.2945 },
  { name: 'Reykjavik, Iceland', lat: 64.1466, lng: -21.9426 },
  { name: 'Manhattan, New York, NY', lat: 40.7580, lng: -73.9855 },
  { name: 'Giza Pyramids, Cairo', lat: 29.9792, lng: 31.1342 },
  { name: 'Sydney Opera House, Australia', lat: -33.8568, lng: 151.2153 },
  { name: 'Westminster, London, UK', lat: 51.5007, lng: -0.1246 },
  { name: 'Golden Gate, San Francisco', lat: 37.8199, lng: -122.4783 },
];

export const BatchEditModal: React.FC<BatchEditModalProps> = ({
  isOpen,
  initialTab,
  selectedPhotos,
  onClose,
  onApplyBatch,
  onSwitchToMapPinPicker,
  onOpenAutoLocate,
}) => {
  const [activeTab, setActiveTab] = useState<'time' | 'location'>(initialTab);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Sorted selected photos chronologically
  const sortedSelected = useMemo(
    () =>
      [...selectedPhotos].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      ),
    [selectedPhotos]
  );

  const firstPhoto = sortedSelected[0];
  const defaultDateTimeVal = firstPhoto
    ? getWallClockParts(firstPhoto.timestamp).dateTimeInputValue
    : '2025-06-15T12:00';

  // Time edit state
  const [timeMode, setTimeMode] = useState<'offset' | 'exact' | 'restore'>('offset');
  const [offsetDaysInput, setOffsetDaysInput] = useState<string>('0');
  const [offsetHoursInput, setOffsetHoursInput] = useState<string>('1');
  const [offsetMinutesInput, setOffsetMinutesInput] = useState<string>('0');
  const [exactDateTime, setExactDateTime] = useState<string>(defaultDateTimeVal);
  const [stepMinutesInput, setStepMinutesInput] = useState<string>('5');

  const parseSignedNumber = (raw: string): number => {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed === '-' || trimmed === '+') return 0;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : 0;
  };

  const offsetDays = parseSignedNumber(offsetDaysInput);
  const offsetHours = parseSignedNumber(offsetHoursInput);
  const offsetMinutes = parseSignedNumber(offsetMinutesInput);
  const stepMinutes = Math.max(0, parseSignedNumber(stepMinutesInput));

  // Location edit state
  const [locMode, setLocMode] = useState<'set' | 'remove' | 'restore'>('set');
  const [latInput, setLatInput] = useState<string>(
    firstPhoto?.location ? String(firstPhoto.location.lat) : '35.6595'
  );
  const [lngInput, setLngInput] = useState<string>(
    firstPhoto?.location ? String(firstPhoto.location.lng) : '139.7004'
  );
  const [locNameInput, setLocNameInput] = useState<string>(
    firstPhoto?.location?.name || 'Shibuya Crossing, Tokyo'
  );

  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab);
      if (firstPhoto) {
        setExactDateTime(getWallClockParts(firstPhoto.timestamp).dateTimeInputValue);
        if (firstPhoto.location) {
          setLatInput(String(firstPhoto.location.lat));
          setLngInput(String(firstPhoto.location.lng));
          setLocNameInput(firstPhoto.location.name || '');
        }
      }
    }
  }, [isOpen, initialTab, firstPhoto]);

  if (!isOpen || selectedPhotos.length === 0) return null;

  const computedOffsetMs =
    ((offsetDays * 24 + offsetHours) * 60 + offsetMinutes) * 60 * 1000;

  const previewTimeItems = sortedSelected.slice(0, 6).map((photo, idx) => {
    let nextIso = photo.timestamp;
    if (timeMode === 'restore') {
      nextIso = photo.originalTimestamp;
    } else if (timeMode === 'offset') {
      const curMs = new Date(photo.timestamp).getTime();
      nextIso = new Date(curMs + computedOffsetMs).toISOString();
    } else if (timeMode === 'exact') {
      const baseIso = exactDateTime.length === 16 ? `${exactDateTime}:00.000Z` : exactDateTime;
      const baseMs = new Date(baseIso).getTime();
      if (!Number.isNaN(baseMs)) {
        nextIso = new Date(baseMs + idx * stepMinutes * 60000).toISOString();
      }
    }
    return {
      photo,
      before: formatWallClockDateTime(photo.timestamp),
      after: formatWallClockDateTime(nextIso),
    };
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      if (activeTab === 'time') {
        if (timeMode === 'restore') {
          await onApplyBatch({ timeEdit: { mode: 'restore' } });
        } else if (timeMode === 'offset') {
          await onApplyBatch({ timeEdit: { mode: 'offset', offsetMs: computedOffsetMs } });
        } else if (timeMode === 'exact') {
          const normalizedIso =
            exactDateTime.length === 16 ? `${exactDateTime}:00.000Z` : new Date(exactDateTime).toISOString();
          await onApplyBatch({
            timeEdit: {
              mode: 'exact',
              timestamp: normalizedIso,
              stepMinutes,
            },
          });
        }
      } else {
        if (locMode === 'restore') {
          await onApplyBatch({ locationEdit: { mode: 'restore' } });
        } else if (locMode === 'remove') {
          await onApplyBatch({ locationEdit: { mode: 'remove' } });
        } else {
          const lat = Number(latInput);
          const lng = Number(lngInput);
          await onApplyBatch({
            locationEdit: {
              mode: 'set',
              location: {
                lat: Number.isFinite(lat) ? lat : 0,
                lng: Number.isFinite(lng) ? lng : 0,
                name: locNameInput.trim() || undefined,
              },
            },
          });
        }
      }
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md"
      data-testid="batch-edit-modal"
    >
      <div className="relative flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-500/15 border border-sky-500/30 text-sky-400">
              <Sparkles className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-base font-semibold text-slate-50">
                Batch Edit Metadata ({selectedPhotos.length} Photo{selectedPhotos.length === 1 ? '' : 's'})
              </h2>
              <p className="text-xs text-slate-400">
                Changes are saved non-destructively to local sidecar metadata (.myalbum-overrides.json)
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            data-testid="close-batch-modal-btn"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Mode Tabs: Time vs Location */}
        <div className="flex border-b border-slate-800 bg-slate-950/50 px-6 pt-2.5 gap-2">
          <button
            type="button"
            onClick={() => setActiveTab('time')}
            className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-semibold transition ${
              activeTab === 'time'
                ? 'border-sky-400 text-sky-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
            data-testid="batch-tab-time"
          >
            <Clock className="h-4 w-4" />
            Batch Change Time
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('location')}
            className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-semibold transition ${
              activeTab === 'location'
                ? 'border-sky-400 text-sky-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
            data-testid="batch-tab-location"
          >
            <MapPin className="h-4 w-4" />
            Batch Change / Remove Location
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5 p-6 max-h-[75vh] overflow-y-auto">
          {activeTab === 'time' ? (
            <>
              {/* Time Adjustment Strategy Selector */}
              <div className="grid grid-cols-3 gap-2.5">
                <button
                  type="button"
                  onClick={() => setTimeMode('offset')}
                  className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition ${
                    timeMode === 'offset'
                      ? 'border-sky-400 bg-sky-500/15 text-slate-50'
                      : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700'
                  }`}
                  data-testid="time-mode-offset-btn"
                >
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-sky-300">
                    <Sliders className="h-3.5 w-3.5" />
                    Shift by Offset
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Add/subtract days, hours, or minutes (preserves intervals)
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setTimeMode('exact')}
                  className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition ${
                    timeMode === 'exact'
                      ? 'border-sky-400 bg-sky-500/15 text-slate-50'
                      : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700'
                  }`}
                  data-testid="time-mode-exact-btn"
                >
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-sky-300">
                    <Calendar className="h-3.5 w-3.5" />
                    Set Exact Date/Time
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Assign a specific timestamp with optional step per photo
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setTimeMode('restore')}
                  className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition ${
                    timeMode === 'restore'
                      ? 'border-amber-400 bg-amber-500/15 text-slate-50'
                      : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700'
                  }`}
                  data-testid="time-mode-restore-btn"
                >
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-300">
                    <RotateCcw className="h-3.5 w-3.5" />
                    Restore Original
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Revert selected photos to original camera EXIF time
                  </p>
                </button>
              </div>

              {/* Time Mode Specific Controls */}
              {timeMode === 'offset' && (
                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-300">
                      Relative Time Shift (positive = move forward, negative = move earlier)
                    </span>
                    <div className="flex gap-1.5">
                      {[
                        { label: '-1 Day', d: -1, h: 0, m: 0 },
                        { label: '-1 Hour', d: 0, h: -1, m: 0 },
                        { label: '+1 Hour', d: 0, h: 1, m: 0 },
                        { label: '+1 Day', d: 1, h: 0, m: 0 },
                      ].map((preset) => (
                        <button
                          key={preset.label}
                          type="button"
                          onClick={() => {
                            setOffsetDaysInput(String(preset.d));
                            setOffsetHoursInput(String(preset.h));
                            setOffsetMinutesInput(String(preset.m));
                          }}
                          className="rounded-md border border-slate-800 bg-slate-900 px-2 py-0.5 text-[11px] text-slate-300 hover:border-sky-500/40 hover:text-sky-300"
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">Days (±)</label>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={offsetDaysInput}
                        onChange={(e) => setOffsetDaysInput(e.target.value)}
                        onBlur={() => setOffsetDaysInput(String(offsetDays))}
                        className="w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-50 focus:border-sky-500 focus:outline-none"
                        data-testid="offset-days-input"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">Hours (±)</label>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={offsetHoursInput}
                        onChange={(e) => setOffsetHoursInput(e.target.value)}
                        onBlur={() => setOffsetHoursInput(String(offsetHours))}
                        className="w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-50 focus:border-sky-500 focus:outline-none"
                        data-testid="offset-hours-input"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">Minutes (±)</label>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={offsetMinutesInput}
                        onChange={(e) => setOffsetMinutesInput(e.target.value)}
                        onBlur={() => setOffsetMinutesInput(String(offsetMinutes))}
                        className="w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-50 focus:border-sky-500 focus:outline-none"
                        data-testid="offset-minutes-input"
                      />
                    </div>
                  </div>
                </div>
              )}

              {timeMode === 'exact' && (
                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1.5">
                      New Date & Time (UTC / Camera Wall Clock)
                    </label>
                    <input
                      type="datetime-local"
                      value={exactDateTime}
                      onChange={(e) => setExactDateTime(e.target.value)}
                      className="w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-50 focus:border-sky-500 focus:outline-none"
                      data-testid="exact-datetime-input"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1.5">
                      Sequential Step per Photo (minutes)
                    </label>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={stepMinutesInput}
                      onChange={(e) => setStepMinutesInput(e.target.value)}
                      onBlur={() => setStepMinutesInput(String(stepMinutes))}
                      className="w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-50 focus:border-sky-500 focus:outline-none"
                      data-testid="exact-step-minutes-input"
                    />
                    <p className="mt-1 text-[10px] text-slate-500">
                      Set to 0 to assign the exact same timestamp, or &gt;0 to keep photos ordered down the string.
                    </p>
                  </div>
                </div>
              )}

              {/* Live Before -> After Preview Table */}
              <div className="rounded-xl border border-slate-800 bg-slate-950/50 overflow-hidden">
                <div className="border-b border-slate-800/80 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Live Timestamp Preview ({selectedPhotos.length} selected)
                </div>
                <div className="divide-y divide-slate-800/60 max-h-44 overflow-y-auto">
                  {previewTimeItems.map(({ photo, before, after }) => (
                    <div
                      key={photo.id}
                      className="flex items-center justify-between px-4 py-2 text-xs"
                    >
                      <span className="truncate max-w-[180px] text-slate-300 font-medium">
                        {photo.fileName}
                      </span>
                      <div className="flex items-center gap-2 font-mono text-[11px]">
                        <span className="text-slate-500">{before}</span>
                        <ArrowRight className="h-3 w-3 text-sky-400" />
                        <span className="text-sky-300 font-semibold">{after}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            /* Location Edit Tab */
            <>
              <div className="grid grid-cols-3 gap-2.5">
                <button
                  type="button"
                  onClick={() => setLocMode('set')}
                  className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition ${
                    locMode === 'set'
                      ? 'border-sky-400 bg-sky-500/15 text-slate-50'
                      : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700'
                  }`}
                  data-testid="loc-mode-set-btn"
                >
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-sky-300">
                    <MapPin className="h-3.5 w-3.5" />
                    Add / Change Location
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Set GPS coordinates and place name for selected photos
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setLocMode('remove')}
                  className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition ${
                    locMode === 'remove'
                      ? 'border-rose-400 bg-rose-500/15 text-slate-50'
                      : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700'
                  }`}
                  data-testid="loc-mode-remove-btn"
                >
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-rose-300">
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove Location
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Clear GPS location data from all {selectedPhotos.length} selected photos
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setLocMode('restore')}
                  className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition ${
                    locMode === 'restore'
                      ? 'border-amber-400 bg-amber-500/15 text-slate-50'
                      : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700'
                  }`}
                  data-testid="loc-mode-restore-btn"
                >
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-300">
                    <RotateCcw className="h-3.5 w-3.5" />
                    Restore Original
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Revert to original camera EXIF GPS coordinates
                  </p>
                </button>
              </div>

              {onOpenAutoLocate && (
                <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                  <p className="text-[11px] text-slate-400">
                    Suggests places for unlocated photos in this view. Nothing changes until you apply.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onOpenAutoLocate();
                    }}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/15 px-2.5 py-1 text-xs font-medium text-sky-300 hover:bg-sky-500/25 transition"
                    data-testid="open-auto-locate-btn"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    Auto-locate unlocated…
                  </button>
                </div>
              )}

              {locMode === 'set' && (
                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-300">
                      Quick Destination Presets or Interactive Map Picker:
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onSwitchToMapPinPicker();
                      }}
                      className="flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/15 px-2.5 py-1 text-xs font-medium text-sky-300 hover:bg-sky-500/25 transition"
                      data-testid="switch-to-map-picker-btn"
                    >
                      <Crosshair className="h-3.5 w-3.5" />
                      Pick Visually on Globe / Map
                    </button>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {WORLD_PRESETS.map((preset) => (
                      <button
                        key={preset.name}
                        type="button"
                        onClick={() => {
                          setLatInput(String(preset.lat));
                          setLngInput(String(preset.lng));
                          setLocNameInput(preset.name);
                        }}
                        className={`rounded-lg border px-2.5 py-1 text-xs transition ${
                          locNameInput === preset.name
                            ? 'border-sky-400 bg-sky-500/20 text-sky-200'
                            : 'border-slate-800 bg-slate-900 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                        }`}
                      >
                        {preset.name}
                      </button>
                    ))}
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">Latitude (-90 to 90)</label>
                      <input
                        type="number"
                        step="0.0001"
                        value={latInput}
                        onChange={(e) => setLatInput(e.target.value)}
                        className="w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-50 focus:border-sky-500 focus:outline-none"
                        data-testid="batch-lat-input"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">Longitude (-180 to 180)</label>
                      <input
                        type="number"
                        step="0.0001"
                        value={lngInput}
                        onChange={(e) => setLngInput(e.target.value)}
                        className="w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-50 focus:border-sky-500 focus:outline-none"
                        data-testid="batch-lng-input"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">Location Name</label>
                      <input
                        type="text"
                        value={locNameInput}
                        onChange={(e) => setLocNameInput(e.target.value)}
                        placeholder="e.g. Shibuya, Tokyo"
                        className="w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-50 focus:border-sky-500 focus:outline-none"
                        data-testid="batch-locname-input"
                      />
                    </div>
                  </div>
                </div>
              )}

              {locMode === 'remove' && (
                <div className="rounded-xl border border-rose-500/30 bg-rose-950/20 p-4 text-xs text-rose-200">
                  GPS location metadata will be removed from all <strong>{selectedPhotos.length}</strong> selected photos.
                  You can always restore their original camera GPS coordinates later.
                </div>
              )}
            </>
          )}

          {/* Modal Footer */}
          <div className="flex items-center justify-end gap-2.5 border-t border-slate-800 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex items-center gap-1.5 rounded-xl bg-sky-500 px-5 py-2 text-xs font-semibold text-on-accent hover:bg-sky-400 disabled:opacity-50 shadow-lg transition"
              data-testid="batch-apply-submit-btn"
            >
              <Check className="h-4 w-4" />
              {isSubmitting ? 'Applying...' : `Apply to ${selectedPhotos.length} Photo${selectedPhotos.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
