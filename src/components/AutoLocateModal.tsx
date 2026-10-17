import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  Crosshair,
  FileText,
  Folder,
  FolderOpen,
  Route,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  AutoLocateOptions,
  AutoLocateRequest,
  AutoLocateResponse,
  AutoLocateStrategy,
  AutoLocateSuggestion,
  AutoLocateTrackSource,
  AutoLocateWindowMinutes,
  BrowseResponse,
  PhotoItem,
} from '../types/photo.ts';
import { formatWallClockDateTime } from '../utils/timelineMath.ts';

export interface AutoLocateModalProps {
  isOpen: boolean;
  folderPath: string;
  targets: PhotoItem[];
  onClose: () => void;
  onApply: (selected: AutoLocateSuggestion[]) => Promise<void>;
}

interface AutoLocateOutcome {
  response: AutoLocateResponse;
  // Snapshot of the targets sent with the run, so rows stay valid if the App's filter changes.
  photos: PhotoItem[];
}

const WINDOW_OPTIONS: { label: string; value: AutoLocateWindowMinutes }[] = [
  { label: '30 min', value: 30 },
  { label: '2 hours', value: 120 },
  { label: '6 hours', value: 360 },
  { label: '24 hours', value: 1440 },
  { label: '7 days', value: 10080 },
];

const STRATEGIES: AutoLocateStrategy[] = ['track', 'companion', 'gazetteer', 'nominatim'];

const STRATEGY_LABELS: Record<AutoLocateStrategy, string> = {
  track: 'Track',
  companion: 'Companion',
  gazetteer: 'Folder/file name',
  nominatim: 'Nominatim',
};

const STRATEGY_BADGE_CLASSES: Record<AutoLocateStrategy, string> = {
  track: 'border-sky-500/30 bg-sky-500/15 text-sky-300',
  companion: 'border-violet-500/30 bg-violet-500/15 text-violet-300',
  gazetteer: 'border-amber-500/30 bg-amber-500/15 text-amber-300',
  nominatim: 'border-teal-500/30 bg-teal-500/15 text-teal-300',
};

const DEFAULT_MIN_CONFIDENCE = 0.65;
const MAX_UTC_OFFSET_MINUTES = 840;
const MAX_DRIFT_MINUTES = 720;
const MAX_LISTED_UNMATCHED = 20;

const SECTION_HEADING_CLASS = 'text-[11px] font-semibold uppercase tracking-wider text-slate-400';
const FIELD_LABEL_CLASS = 'mb-1 block text-[11px] text-slate-400';
const INPUT_CLASS =
  'w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-50 focus:border-sky-500 focus:outline-none';
const CHECKBOX_LABEL_CLASS = 'flex items-center gap-2 text-xs text-slate-300';
const CHECKBOX_CLASS = 'h-3.5 w-3.5 accent-sky-500';
const SECONDARY_BUTTON_CLASS =
  'flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/90 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:border-sky-500/40 hover:text-sky-300';
const PRIMARY_BUTTON_CLASS =
  'flex items-center gap-1.5 rounded-xl bg-sky-500 px-5 py-2 text-xs font-semibold text-on-accent shadow-lg transition hover:bg-sky-400 disabled:opacity-50';
const ERROR_BOX_CLASS =
  'rounded-xl border border-rose-500/40 bg-rose-950/30 px-3.5 py-2 text-xs text-rose-300';

// "+09:00" -> 540. Returns null for malformed or out-of-range input.
function parseUtcOffset(raw: string): number | null {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const minutes = Number(match[3]);
  if (minutes > 59) return null;
  const total = (Number(match[2]) * 60 + minutes) * (match[1] === '-' ? -1 : 1);
  return Math.abs(total) <= MAX_UTC_OFFSET_MINUTES ? total : null;
}

function parseDriftMinutes(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Math.abs(value) <= MAX_DRIFT_MINUTES ? value : null;
}

function selectAtOrAbove(suggestions: AutoLocateSuggestion[], threshold: number): Set<string> {
  return new Set(suggestions.filter((s) => s.confidence >= threshold).map((s) => s.photoId));
}

function confidenceTone(confidence: number): string {
  if (confidence >= 0.85) return 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300';
  if (confidence >= 0.65) return 'border-amber-500/30 bg-amber-500/15 text-amber-300';
  return 'border-rose-500/30 bg-rose-500/15 text-rose-300';
}

function fileNameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export const AutoLocateModal: React.FC<AutoLocateModalProps> = ({
  isOpen,
  folderPath,
  targets,
  onClose,
  onApply,
}) => {
  const [windowMinutes, setWindowMinutes] = useState<AutoLocateWindowMinutes>(120);
  const [utcOffsetInput, setUtcOffsetInput] = useState('+00:00');
  const [useEmbeddedOffset, setUseEmbeddedOffset] = useState(true);
  const [driftInput, setDriftInput] = useState('0');
  const [enableCompanion, setEnableCompanion] = useState(true);
  const [enableGazetteer, setEnableGazetteer] = useState(true);
  const [enableNominatim, setEnableNominatim] = useState(false);
  const [trackSource, setTrackSource] = useState<AutoLocateTrackSource | null>(null);

  const [isBrowserOpen, setIsBrowserOpen] = useState(false);
  const [browseData, setBrowseData] = useState<BrowseResponse | null>(null);
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);

  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<AutoLocateOutcome | null>(null);
  const [minConfidence, setMinConfidence] = useState(DEFAULT_MIN_CONFIDENCE);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const [isApplying, setIsApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  // Bumped on folder change and on each new request, so responses that arrive late are dropped.
  const runSeqRef = useRef(0);
  const browseSeqRef = useRef(0);

  // Results and selections belong to one folder. Track and offset settings persist.
  useEffect(() => {
    runSeqRef.current += 1;
    browseSeqRef.current += 1;
    setIsRunning(false);
    setOutcome(null);
    setSelectedIds(new Set());
    setRunError(null);
    setApplyError(null);
    setBrowseData(null);
    setBrowseError(null);
    setIsBrowsing(false);
    setIsBrowserOpen(false);
  }, [folderPath]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const utcOffsetMinutes = parseUtcOffset(utcOffsetInput);
  const driftMinutes = parseDriftMinutes(driftInput);
  const canRun =
    targets.length > 0 && utcOffsetMinutes !== null && driftMinutes !== null && !isRunning;

  const suggestions = outcome?.response.suggestions ?? [];
  const selectedSuggestions = suggestions.filter((s) => selectedIds.has(s.photoId));
  const photoById = new Map((outcome?.photos ?? []).map((p) => [p.id, p] as const));
  const unmatchedIds = new Set(outcome?.response.unmatchedPhotoIds ?? []);
  const unmatchedPhotos = (outcome?.photos ?? []).filter((p) => unmatchedIds.has(p.id));
  const warnings = outcome?.response.warnings ?? [];
  const attribution = outcome?.response.attribution ?? null;
  const parentPath = browseData?.parentPath ?? null;
  const browseFiles = browseData?.files ?? [];

  const loadBrowse = async (dirPath: string) => {
    const seq = ++browseSeqRef.current;
    setIsBrowsing(true);
    setBrowseError(null);
    try {
      const res = await fetch(`/api/browse?dir=${encodeURIComponent(dirPath)}&kind=track`);
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Failed to browse directory');
      if (seq === browseSeqRef.current) setBrowseData(data as BrowseResponse);
    } catch (err) {
      if (seq === browseSeqRef.current) {
        setBrowseError(err instanceof Error ? err.message : 'Unable to read directory');
      }
    } finally {
      if (seq === browseSeqRef.current) setIsBrowsing(false);
    }
  };

  const openTrackBrowser = () => {
    setIsBrowserOpen(true);
    loadBrowse(folderPath);
  };

  const chooseTrack = (source: AutoLocateTrackSource) => {
    setTrackSource(source);
    setIsBrowserOpen(false);
  };

  const handleRun = async () => {
    if (!canRun || utcOffsetMinutes === null || driftMinutes === null) return;
    const options: AutoLocateOptions = {
      windowMinutes,
      utcOffsetMinutes,
      driftMinutes,
      useEmbeddedOffset,
      enableCompanion,
      enableGazetteer,
      enableNominatim,
    };
    const request: AutoLocateRequest = {
      folderPath,
      photoIds: targets.map((p) => p.id),
      ...(trackSource ? { trackSource } : {}),
      options,
    };
    const seq = ++runSeqRef.current;
    setIsRunning(true);
    setRunError(null);
    setApplyError(null);
    try {
      const res = await fetch('/api/photos/auto-locate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Auto-locate failed (HTTP ${res.status})`);
      if (seq !== runSeqRef.current) return;
      const response = data as AutoLocateResponse;
      setOutcome({ response, photos: targets });
      setSelectedIds(selectAtOrAbove(response.suggestions, minConfidence));
    } catch (err) {
      if (seq === runSeqRef.current) {
        setRunError(err instanceof Error ? err.message : 'Auto-locate failed');
      }
    } finally {
      if (seq === runSeqRef.current) setIsRunning(false);
    }
  };

  // The slider re-applies the threshold, which replaces any manual row toggles.
  const handleThresholdChange = (value: number) => {
    setMinConfidence(value);
    if (outcome) setSelectedIds(selectAtOrAbove(outcome.response.suggestions, value));
  };

  const toggleSuggestion = (photoId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(photoId)) next.delete(photoId);
      else next.add(photoId);
      return next;
    });
  };

  const handleApply = async () => {
    if (selectedSuggestions.length === 0 || isApplying) return;
    setIsApplying(true);
    setApplyError(null);
    try {
      await onApply(selectedSuggestions);
      // The App closes the modal on success. Clear results so a reopened modal starts fresh.
      setOutcome(null);
      setSelectedIds(new Set());
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : 'Failed to apply locations');
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md"
      data-testid="auto-locate-modal"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="auto-locate-title"
        className="relative flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-sky-500/30 bg-sky-500/15 text-sky-400">
              <Crosshair className="h-5 w-5" />
            </span>
            <div>
              <h2 id="auto-locate-title" className="text-base font-semibold text-slate-50">
                Auto-Locate Photos
              </h2>
              <p className="text-xs text-slate-400">
                Suggests places for unlocated photos in this view. Nothing changes until you apply.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            data-testid="auto-locate-close-btn"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6">
          {targets.length === 0 && (
            <div
              className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-xs text-slate-400"
              data-testid="auto-locate-no-targets"
            >
              No unlocated photos in this view
            </div>
          )}

          <section className="space-y-3">
            <h3 className={SECTION_HEADING_CLASS}>Track</h3>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={openTrackBrowser}
                className={SECONDARY_BUTTON_CLASS}
                data-testid="auto-locate-track-choose"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                Choose track file
              </button>
              <button
                type="button"
                onClick={() => chooseTrack({ type: 'sample' })}
                className={SECONDARY_BUTTON_CLASS}
                data-testid="auto-locate-sample-btn"
              >
                <Route className="h-3.5 w-3.5" />
                Use sample track
              </button>
            </div>

            {trackSource ? (
              <div
                className="flex items-center justify-between gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200"
                data-testid="auto-locate-track-selected"
              >
                <span
                  className="min-w-0 truncate"
                  title={trackSource.type === 'file' ? trackSource.path : undefined}
                >
                  {trackSource.type === 'file' ? fileNameFromPath(trackSource.path) : 'Sample track'}
                </span>
                <button
                  type="button"
                  onClick={() => setTrackSource(null)}
                  className="shrink-0 rounded-md border border-emerald-500/30 px-2 py-0.5 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/20"
                  data-testid="auto-locate-track-clear"
                >
                  Clear
                </button>
              </div>
            ) : (
              <p className="text-xs text-slate-500">
                No track selected: only companion and folder-name matches will run.
              </p>
            )}

            {isBrowserOpen && (
              <div
                className="flex flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-950/70"
                data-testid="auto-locate-browser"
              >
                <div className="flex items-center justify-between gap-3 border-b border-slate-800/80 bg-slate-900/70 px-3.5 py-2">
                  <span
                    className="min-w-0 truncate font-mono text-[11px] text-slate-400"
                    title={browseData?.currentPath}
                  >
                    {browseData?.currentPath ?? folderPath}
                  </span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {parentPath && (
                      <button
                        type="button"
                        onClick={() => loadBrowse(parentPath)}
                        className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-950 px-2 py-1 text-[11px] font-medium text-slate-300 hover:border-slate-700 hover:text-slate-50"
                        data-testid="auto-locate-browser-up"
                      >
                        <ArrowUp className="h-3 w-3" />
                        Up one level
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setIsBrowserOpen(false)}
                      className="rounded-lg border border-slate-800 bg-slate-950 px-2 py-1 text-[11px] font-medium text-slate-300 hover:border-slate-700 hover:text-slate-50"
                    >
                      Done
                    </button>
                  </div>
                </div>

                <div className="max-h-56 overflow-y-auto divide-y divide-slate-800/50">
                  {isBrowsing && (
                    <div className="py-3 text-center text-xs text-slate-500">Loading...</div>
                  )}
                  {browseError && (
                    <div className="px-4 py-3 text-xs text-rose-300">{browseError}</div>
                  )}
                  {browseData && !isBrowsing && (
                    <>
                      {browseData.directories.map((dir) => (
                        <button
                          key={dir.path}
                          type="button"
                          onClick={() => loadBrowse(dir.path)}
                          className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-xs text-slate-200 hover:bg-slate-900/80"
                        >
                          <Folder className="h-4 w-4 shrink-0 text-sky-400" />
                          <span className="truncate font-medium">{dir.name}</span>
                        </button>
                      ))}
                      {browseFiles.map((file) => (
                        <button
                          key={file.path}
                          type="button"
                          onClick={() => chooseTrack({ type: 'file', path: file.path })}
                          className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-xs text-slate-200 hover:bg-slate-900/80"
                          data-testid="auto-locate-browser-file"
                        >
                          <span className="flex min-w-0 items-center gap-2.5">
                            <FileText className="h-4 w-4 shrink-0 text-emerald-400" />
                            <span className="truncate font-medium">{file.name}</span>
                          </span>
                          <span className="shrink-0 font-mono text-[11px] text-slate-500">
                            {formatFileSize(file.size)}
                          </span>
                        </button>
                      ))}
                      {browseData.directories.length === 0 && browseFiles.length === 0 && (
                        <div className="py-6 text-center text-xs text-slate-500">
                          No subfolders or .gpx / .json files here.
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
          </section>

          <section className="space-y-3">
            <h3 className={SECTION_HEADING_CLASS}>Time</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="block">
                <span className={FIELD_LABEL_CLASS}>Match window (±)</span>
                <select
                  value={windowMinutes}
                  onChange={(e) => setWindowMinutes(Number(e.target.value) as AutoLocateWindowMinutes)}
                  className={INPUT_CLASS}
                  data-testid="auto-locate-window"
                >
                  {WINDOW_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <div>
                <label className="block">
                  <span className={FIELD_LABEL_CLASS}>UTC offset (±HH:MM)</span>
                  <input
                    type="text"
                    value={utcOffsetInput}
                    onChange={(e) => setUtcOffsetInput(e.target.value)}
                    placeholder="+00:00"
                    aria-invalid={utcOffsetMinutes === null}
                    className={INPUT_CLASS}
                    data-testid="auto-locate-utc-offset"
                  />
                </label>
                {utcOffsetMinutes === null ? (
                  <p className="mt-1 text-[11px] text-rose-300" data-testid="auto-locate-utc-offset-error">
                    Enter an offset like +09:00, between -14:00 and +14:00.
                  </p>
                ) : (
                  <p className="mt-1 text-[11px] text-slate-500">
                    Used for photos without an EXIF offset, or for all photos when the option below is off.
                  </p>
                )}
              </div>

              <label className={CHECKBOX_LABEL_CLASS}>
                <input
                  type="checkbox"
                  checked={useEmbeddedOffset}
                  onChange={(e) => setUseEmbeddedOffset(e.target.checked)}
                  className={CHECKBOX_CLASS}
                  data-testid="auto-locate-exif-offset"
                />
                Use each photo&apos;s EXIF offset when present
              </label>

              <div>
                <label className="block">
                  <span className={FIELD_LABEL_CLASS}>Clock drift (minutes)</span>
                  <input
                    type="number"
                    min={-MAX_DRIFT_MINUTES}
                    max={MAX_DRIFT_MINUTES}
                    step={1}
                    value={driftInput}
                    onChange={(e) => setDriftInput(e.target.value)}
                    aria-invalid={driftMinutes === null}
                    className={INPUT_CLASS}
                    data-testid="auto-locate-drift"
                  />
                </label>
                <p className="mt-1 text-[11px] text-slate-500">
                  Positive if the camera clock runs ahead of the track clock. Applied to unlocated photos only.
                </p>
                {driftMinutes === null && (
                  <p className="mt-1 text-[11px] text-rose-300" data-testid="auto-locate-drift-error">
                    Enter whole minutes from -720 to 720.
                  </p>
                )}
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <h3 className={SECTION_HEADING_CLASS}>Sources</h3>
            <label className={CHECKBOX_LABEL_CLASS}>
              <input
                type="checkbox"
                checked={enableCompanion}
                onChange={(e) => setEnableCompanion(e.target.checked)}
                className={CHECKBOX_CLASS}
                data-testid="auto-locate-companion"
              />
              Companion photos
            </label>
            <label className={CHECKBOX_LABEL_CLASS}>
              <input
                type="checkbox"
                checked={enableGazetteer}
                onChange={(e) => setEnableGazetteer(e.target.checked)}
                className={CHECKBOX_CLASS}
                data-testid="auto-locate-gazetteer"
              />
              Folder and file place names (offline)
            </label>
            <div>
              <label className={CHECKBOX_LABEL_CLASS}>
                <input
                  type="checkbox"
                  checked={enableNominatim}
                  onChange={(e) => setEnableNominatim(e.target.checked)}
                  className={CHECKBOX_CLASS}
                  data-testid="auto-locate-nominatim"
                />
                OpenStreetMap Nominatim (online)
              </label>
              <p className="mt-1 pl-6 text-[11px] text-slate-500">
                Sends unmatched folder and file place names (not photos) to openstreetmap.org. Results are cached on this computer.
              </p>
            </div>
          </section>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-slate-500">
                {targets.length > 0 &&
                  `${targets.length} unlocated photo${targets.length === 1 ? '' : 's'} will be checked`}
              </p>
              <button
                type="button"
                onClick={handleRun}
                disabled={!canRun}
                className={PRIMARY_BUTTON_CLASS}
                data-testid="auto-locate-run-btn"
              >
                <Sparkles className={`h-4 w-4 ${isRunning ? 'animate-pulse' : ''}`} />
                {isRunning ? 'Running...' : 'Run'}
              </button>
            </div>
            {runError && (
              <div role="alert" className={ERROR_BOX_CLASS} data-testid="auto-locate-run-error">
                {runError}
              </div>
            )}
          </div>

          {outcome && (
            <section className="space-y-4 border-t border-slate-800 pt-6" data-testid="auto-locate-results">
              <div className="flex flex-wrap gap-1.5 text-[11px]" data-testid="auto-locate-summary">
                <span className="rounded-full border border-slate-700 bg-slate-800/70 px-2.5 py-0.5 text-slate-300">
                  Targets: {outcome.response.stats.targets}
                </span>
                <span className="rounded-full border border-slate-700 bg-slate-800/70 px-2.5 py-0.5 text-slate-300">
                  Matched: {outcome.response.stats.matched}
                </span>
                {STRATEGIES.map((strategy) => (
                  <span
                    key={strategy}
                    className={`rounded-full border px-2.5 py-0.5 ${STRATEGY_BADGE_CLASSES[strategy]}`}
                  >
                    {STRATEGY_LABELS[strategy]}: {outcome.response.stats.byStrategy[strategy] ?? 0}
                  </span>
                ))}
              </div>

              <label className="flex items-center gap-3 text-xs text-slate-300">
                <span className="shrink-0">Minimum confidence</span>
                <input
                  type="range"
                  min={0.5}
                  max={1}
                  step={0.05}
                  value={minConfidence}
                  onChange={(e) => handleThresholdChange(Number(e.target.value))}
                  className="flex-1 accent-sky-400"
                  data-testid="auto-locate-min-confidence"
                />
                <span className="w-10 text-right font-mono text-slate-200">
                  {Math.round(minConfidence * 100)}%
                </span>
              </label>

              {suggestions.length === 0 ? (
                <p className="text-xs text-slate-500">No location matches were found for these photos.</p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-800">
                  <table className="w-full min-w-[720px] text-left text-xs">
                    <thead className="bg-slate-950/70 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                      <tr>
                        <th className="w-10 px-3 py-2">
                          <span className="sr-only">Select</span>
                        </th>
                        <th className="px-2 py-2">Photo</th>
                        <th className="px-2 py-2">Taken</th>
                        <th className="px-2 py-2">Place</th>
                        <th className="px-2 py-2">Match</th>
                        <th className="px-2 py-2">Confidence</th>
                        <th className="px-2 py-2">Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {suggestions.map((s) => {
                        const photo = photoById.get(s.photoId);
                        const fileName = photo?.fileName ?? s.photoId;
                        const isSelected = selectedIds.has(s.photoId);
                        return (
                          <tr
                            key={s.photoId}
                            className={isSelected ? 'bg-sky-500/5' : undefined}
                            data-testid={`auto-locate-row-${s.photoId}`}
                          >
                            <td className="px-3 py-2 align-middle">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleSuggestion(s.photoId)}
                                aria-label={`Select ${fileName}`}
                                className={CHECKBOX_CLASS}
                              />
                            </td>
                            <td className="px-2 py-2 align-middle">
                              {photo ? (
                                <img
                                  src={photo.url}
                                  alt={photo.fileName}
                                  loading="lazy"
                                  className="h-10 w-14 rounded-md border border-slate-800 object-cover"
                                />
                              ) : (
                                <div className="h-10 w-14 rounded-md border border-slate-800 bg-slate-800" />
                              )}
                            </td>
                            <td className="px-2 py-2 align-middle">
                              <div className="max-w-[180px] truncate font-medium text-slate-200" title={fileName}>
                                {fileName}
                              </div>
                              <div className="font-mono text-[11px] text-slate-400" title={s.utcIso ?? undefined}>
                                {photo ? `${formatWallClockDateTime(photo.timestamp)} UTC` : '—'}
                              </div>
                            </td>
                            <td className="px-2 py-2 align-middle">
                              <div className="max-w-[200px] truncate text-slate-200">{s.location.name}</div>
                              <div className="font-mono text-[11px] text-slate-500">
                                {s.location.lat.toFixed(5)}, {s.location.lng.toFixed(5)}
                              </div>
                            </td>
                            <td className="px-2 py-2 align-middle">
                              <div className="flex flex-wrap gap-1">
                                <span
                                  className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${STRATEGY_BADGE_CLASSES[s.strategy]}`}
                                >
                                  {STRATEGY_LABELS[s.strategy]}
                                </span>
                                {s.previouslyRemoved && (
                                  <span className="rounded-full border border-orange-500/30 bg-orange-500/15 px-2 py-0.5 text-[10px] font-semibold text-orange-300">
                                    Previously removed
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="px-2 py-2 align-middle">
                              <span
                                className={`rounded-md border px-2 py-0.5 font-mono text-[11px] font-semibold ${confidenceTone(s.confidence)}`}
                              >
                                {Math.round(s.confidence * 100)}%
                              </span>
                            </td>
                            <td className="px-2 py-2 align-middle text-[11px] text-slate-400">{s.reason}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {unmatchedPhotos.length > 0 && (
                <div
                  className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-xs"
                  data-testid="auto-locate-unmatched"
                >
                  <p className="font-semibold text-slate-300">Not matched: {unmatchedPhotos.length}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {unmatchedPhotos.slice(0, MAX_LISTED_UNMATCHED).map((photo) => (
                      <span
                        key={photo.id}
                        className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-400"
                      >
                        {photo.fileName}
                      </span>
                    ))}
                  </div>
                  {unmatchedPhotos.length > MAX_LISTED_UNMATCHED && (
                    <p className="mt-2 text-[11px] text-slate-500">
                      and {unmatchedPhotos.length - MAX_LISTED_UNMATCHED} more
                    </p>
                  )}
                </div>
              )}

              {warnings.length > 0 && (
                <ul
                  className="list-disc space-y-1 rounded-xl border border-amber-500/30 bg-amber-500/10 py-3 pl-8 pr-4 text-xs text-amber-200"
                  data-testid="auto-locate-warnings"
                >
                  {warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>

        <div className="flex flex-col gap-3 border-t border-slate-800 px-6 py-4">
          {applyError && (
            <div role="alert" className={ERROR_BOX_CLASS} data-testid="auto-locate-apply-error">
              {applyError}
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 text-[11px] text-slate-500">
              {attribution !== null && <p data-testid="auto-locate-attribution">{attribution}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-2.5">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
                data-testid="auto-locate-cancel-btn"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleApply}
                disabled={selectedSuggestions.length === 0 || isApplying}
                className={PRIMARY_BUTTON_CLASS}
                data-testid="auto-locate-apply-btn"
              >
                <Check className="h-4 w-4" />
                {isApplying ? 'Applying...' : `Apply selected (${selectedSuggestions.length})`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
