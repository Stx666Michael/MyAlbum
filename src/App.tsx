import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Clock,
  Globe,
  FolderOpen,
  CheckSquare,
  Square,
  Sparkles,
  MapPin,
  Filter,
  Loader2,
  X,
} from 'lucide-react';
import type {
  BatchLocationEdit,
  BatchTimeEdit,
  PhotoItem,
  PhotoLocation,
  ScanResponse,
} from './types/photo.ts';
import { TimelineView } from './components/TimelineView.tsx';
import { MapView } from './components/MapView.tsx';
import { PhotoLightbox } from './components/PhotoLightbox.tsx';
import { BatchEditModal } from './components/BatchEditModal.tsx';
import { FolderPickerModal } from './components/FolderPickerModal.tsx';

export const App: React.FC = () => {
  const [activeView, setActiveView] = useState<'timeline' | 'location'>('timeline');
  const [spacingMode, setSpacingMode] = useState<'compact' | 'proportional'>('compact');

  const [scanData, setScanData] = useState<ScanResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [selectedSubfolder, setSelectedSubfolder] = useState<string>('ALL');

  // Batch selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Lightbox & modals state
  const [activePhotoId, setActivePhotoId] = useState<string | null>(null);
  const [batchModalState, setBatchModalState] = useState<{
    isOpen: boolean;
    tab: 'time' | 'location';
  }>({ isOpen: false, tab: 'time' });
  const [isFolderModalOpen, setIsFolderModalOpen] = useState<boolean>(false);
  const [isMapPinPicking, setIsMapPinPicking] = useState<boolean>(false);

  // Toast feedback state
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
  }, []);

  useEffect(() => {
    if (!toastMessage) return;
    const timer = setTimeout(() => setToastMessage(null), 3600);
    return () => clearTimeout(timer);
  }, [toastMessage]);

  const loadDemoAlbum = useCallback(async (resetEdits = false) => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reset: resetEdits }),
      });
      const data: ScanResponse = await res.json();
      if (!res.ok) {
        throw new Error((data as any).error || 'Failed to load demo album');
      }
      setScanData(data);
      setSelectedSubfolder('ALL');
      if (resetEdits) {
        setSelectedIds(new Set());
        showToast('Demo album reset to original EXIF metadata');
      }
    } catch (err: any) {
      showToast(err?.message || 'Error loading demo photos');
    } finally {
      setIsLoading(false);
    }
  }, [showToast]);

  const loadCustomFolder = useCallback(
    async (folderPath: string) => {
      setIsLoading(true);
      try {
        const res = await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderPath }),
        });
        const data: ScanResponse = await res.json();
        if (!res.ok) {
          throw new Error((data as any).error || 'Failed to scan folder');
        }
        setScanData(data);
        setSelectedSubfolder('ALL');
        setSelectedIds(new Set());
        showToast(`Loaded ${data.totalCount} photos across ${data.subfolders.length + 1} folders`);
      } finally {
        setIsLoading(false);
      }
    },
    [showToast]
  );

  // Initial load of built-in demo album
  useEffect(() => {
    loadDemoAlbum(false);
  }, [loadDemoAlbum]);

  // Filtered photos by subfolder (including nested subfolders)
  const filteredPhotos = useMemo(() => {
    if (!scanData) return [];
    if (selectedSubfolder === 'ALL') return scanData.photos;
    return scanData.photos.filter(
      (p) =>
        p.subfolder === selectedSubfolder ||
        p.subfolder.startsWith(`${selectedSubfolder}/`)
    );
  }, [scanData, selectedSubfolder]);

  const filteredLocatedCount = useMemo(
    () => filteredPhotos.filter((p) => p.location !== null).length,
    [filteredPhotos]
  );

  // Prune selection when subfolder filter changes so hidden photos are not accidentally batch-edited
  useEffect(() => {
    const visibleSet = new Set(filteredPhotos.map((p) => p.id));
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (visibleSet.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [filteredPhotos]);

  const selectedPhotos = useMemo(
    () => filteredPhotos.filter((p) => selectedIds.has(p.id)),
    [filteredPhotos, selectedIds]
  );

  const activePhoto = useMemo(
    () => (scanData && activePhotoId ? scanData.photos.find((p) => p.id === activePhotoId) || null : null),
    [scanData, activePhotoId]
  );

  const handleToggleSelect = useCallback((photoId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(photoId)) {
        next.delete(photoId);
      } else {
        next.add(photoId);
      }
      return next;
    });
  }, []);

  const handleSelectGroup = useCallback((photoIds: string[], additive = true) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (additive) {
        photoIds.forEach((id) => next.add(id));
      } else {
        photoIds.forEach((id) => next.delete(id));
      }
      return next;
    });
  }, []);

  const handleSelectAllVisible = () => {
    if (filteredPhotos.length === 0) return;
    const allSelected = filteredPhotos.every((p) => selectedIds.has(p.id));
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredPhotos.map((p) => p.id)));
    }
  };

  const applyBatchEditRequest = useCallback(
    async (
      targetPhotoIds: string[],
      options: { timeEdit?: BatchTimeEdit; locationEdit?: BatchLocationEdit }
    ) => {
      if (!scanData || targetPhotoIds.length === 0) return;
      const res = await fetch('/api/photos/batch', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folderPath: scanData.folderPath,
          photoIds: targetPhotoIds,
          ...options,
        }),
      });
      const updated: ScanResponse = await res.json();
      if (!res.ok) {
        throw new Error((updated as any).error || 'Batch update failed');
      }
      setScanData(updated);
      const actionDesc = options.timeEdit
        ? 'timestamps'
        : options.locationEdit?.mode === 'remove'
          ? 'removed locations'
          : 'locations';
      showToast(`Updated ${actionDesc} for ${targetPhotoIds.length} photo${targetPhotoIds.length === 1 ? '' : 's'}`);
    },
    [scanData, showToast]
  );

  const handleBatchSetLocationOnMap = useCallback(
    async (photoIds: string[], location: PhotoLocation) => {
      await applyBatchEditRequest(photoIds, {
        locationEdit: { mode: 'set', location },
      });
    },
    [applyBatchEditRequest]
  );

  const handleBatchRemoveLocationOnMap = useCallback(
    async (photoIds: string[]) => {
      await applyBatchEditRequest(photoIds, {
        locationEdit: { mode: 'remove' },
      });
    },
    [applyBatchEditRequest]
  );

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
      {/* Top Navigation & Studio Command Header */}
      <header className="relative z-30 flex h-16 shrink-0 items-center justify-between border-b border-slate-800/90 bg-slate-950/90 px-5 backdrop-blur-xl">
        {/* Left: Brand + Active Folder & Subfolder Filter */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 to-indigo-600 text-slate-950 shadow-[0_0_20px_rgba(56,189,248,0.35)]">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-sm font-bold tracking-tight text-white">MyAlbum</h1>
              <p className="text-[10px] font-medium text-sky-400">Flowing Timeline & 3D Globe</p>
            </div>
          </div>

          <div className="h-6 w-px bg-slate-800" />

          {/* Folder Picker Trigger */}
          <button
            type="button"
            onClick={() => setIsFolderModalOpen(true)}
            className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/90 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-sky-500/40 hover:text-sky-300 transition"
            data-testid="open-folder-picker-btn"
          >
            <FolderOpen className="h-3.5 w-3.5 text-sky-400" />
            <span className="max-w-[150px] truncate">{scanData?.folderName || 'sample-photos'}</span>
            <span className="rounded-md bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
              {scanData?.totalCount ?? 0}
            </span>
          </button>

          {/* Subfolder Filter Select */}
          {scanData && scanData.subfolders.length > 0 && (
            <div className="hidden md:flex items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900/70 px-2.5 py-1.5 text-xs">
              <Filter className="h-3.5 w-3.5 text-slate-400" />
              <select
                value={selectedSubfolder}
                onChange={(e) => setSelectedSubfolder(e.target.value)}
                className="bg-transparent text-xs text-slate-200 focus:outline-none cursor-pointer"
                aria-label="Filter by subfolder"
                data-testid="subfolder-filter-select"
              >
                <option value="ALL" className="bg-slate-900 text-slate-100">
                  All Subfolders ({scanData.totalCount} photos)
                </option>
                {scanData.subfolders.map((sub) => (
                  <option key={sub} value={sub} className="bg-slate-900 text-slate-100">
                    📁 {sub}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Center: Primary View Mode Switcher (Timeline vs Location Globe) */}
        <div
          className="flex items-center rounded-2xl border border-slate-800 bg-slate-900/90 p-1 shadow-inner"
          data-testid="view-mode-switcher"
        >
          <button
            type="button"
            onClick={() => setActiveView('timeline')}
            className={`flex items-center gap-2 rounded-xl px-4 py-1.5 text-xs font-semibold transition-all ${
              activeView === 'timeline'
                ? 'bg-sky-500 text-slate-950 shadow-[0_0_20px_rgba(56,189,248,0.4)]'
                : 'text-slate-400 hover:text-slate-100'
            }`}
            data-testid="switch-to-timeline-btn"
          >
            <Clock className="h-3.5 w-3.5" />
            1. Timeline Strings
          </button>

          <button
            type="button"
            onClick={() => setActiveView('location')}
            className={`flex items-center gap-2 rounded-xl px-4 py-1.5 text-xs font-semibold transition-all ${
              activeView === 'location'
                ? 'bg-sky-500 text-slate-950 shadow-[0_0_20px_rgba(56,189,248,0.4)]'
                : 'text-slate-400 hover:text-slate-100'
            }`}
            data-testid="switch-to-location-btn"
          >
            <Globe className="h-3.5 w-3.5" />
            2. Location Globe
            {scanData && (
              <span
                className={`rounded-full px-1.5 py-0.2 font-mono text-[10px] ${
                  activeView === 'location'
                    ? 'bg-slate-950/25 text-slate-950'
                    : 'bg-slate-800 text-sky-300'
                }`}
              >
                {filteredLocatedCount}
              </span>
            )}
          </button>
        </div>

        {/* Right: Selection & Batch Edit Actions */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSelectAllVisible}
            className="flex items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-700 hover:text-white transition"
            data-testid="select-all-visible-btn"
          >
            {filteredPhotos.length > 0 && filteredPhotos.every((p) => selectedIds.has(p.id)) ? (
              <CheckSquare className="h-3.5 w-3.5 text-sky-400" />
            ) : (
              <Square className="h-3.5 w-3.5 text-slate-400" />
            )}
            <span>
              {selectedIds.size > 0 ? `${selectedIds.size} Selected` : 'Select All'}
            </span>
          </button>

          {selectedIds.size > 0 && (
            <>
              <button
                type="button"
                onClick={() => setBatchModalState({ isOpen: true, tab: 'time' })}
                className="flex items-center gap-1.5 rounded-xl border border-sky-500/40 bg-sky-500/15 px-3 py-1.5 text-xs font-semibold text-sky-300 hover:bg-sky-500/25 transition"
                data-testid="open-batch-time-btn"
              >
                <Clock className="h-3.5 w-3.5" />
                Batch Time
              </button>

              <button
                type="button"
                onClick={() => setBatchModalState({ isOpen: true, tab: 'location' })}
                className="flex items-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25 transition"
                data-testid="open-batch-location-btn"
              >
                <MapPin className="h-3.5 w-3.5" />
                Batch Location
              </button>

              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className="rounded-xl border border-slate-800 bg-slate-900 p-1.5 text-slate-400 hover:text-white transition"
                title="Clear selection"
                data-testid="clear-selection-btn"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      </header>

      {/* Main Content Stage */}
      <main className="relative flex-1 overflow-hidden">
        {isLoading ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-slate-400">
            <Loader2 className="h-8 w-8 animate-spin text-sky-400" />
            <p className="text-sm font-medium text-slate-300">
              Scanning photo folders & extracting EXIF metadata...
            </p>
          </div>
        ) : activeView === 'timeline' ? (
          <TimelineView
            photos={filteredPhotos}
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
            onSelectGroup={handleSelectGroup}
            onOpenPhoto={(photo) => setActivePhotoId(photo.id)}
            spacingMode={spacingMode}
            onChangeSpacingMode={setSpacingMode}
          />
        ) : (
          <MapView
            photos={filteredPhotos}
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
            onSelectGroup={handleSelectGroup}
            onOpenPhoto={(photo) => setActivePhotoId(photo.id)}
            onBatchSetLocation={handleBatchSetLocationOnMap}
            onBatchRemoveLocation={handleBatchRemoveLocationOnMap}
            isPickingLocation={isMapPinPicking}
            onChangePickingLocation={setIsMapPinPicking}
          />
        )}

        {/* Toast Notification Pill */}
        {toastMessage && (
          <div
            className="fixed bottom-16 right-6 z-50 flex items-center gap-2 rounded-xl border border-sky-500/40 bg-slate-900/95 px-4 py-2.5 text-xs font-medium text-sky-200 shadow-2xl backdrop-blur-md"
            data-testid="toast-notification"
          >
            <Sparkles className="h-4 w-4 text-sky-400" />
            <span>{toastMessage}</span>
          </div>
        )}
      </main>

      {/* Photo Detail Lightbox & EXIF Inspector */}
      <PhotoLightbox
        photo={activePhoto}
        photos={filteredPhotos}
        selectedIds={selectedIds}
        onClose={() => setActivePhotoId(null)}
        onNavigate={(next) => setActivePhotoId(next.id)}
        onToggleSelect={handleToggleSelect}
        onQuickEditTime={(photo) => {
          setSelectedIds(new Set([photo.id]));
          setActivePhotoId(null);
          setBatchModalState({ isOpen: true, tab: 'time' });
        }}
        onQuickEditLocation={(photo) => {
          setSelectedIds(new Set([photo.id]));
          setActivePhotoId(null);
          setBatchModalState({ isOpen: true, tab: 'location' });
        }}
        onQuickRemoveLocation={async (photo) => {
          await applyBatchEditRequest([photo.id], {
            locationEdit: { mode: 'remove' },
          });
        }}
      />

      {/* Batch Time & Location Editor Modal */}
      <BatchEditModal
        isOpen={batchModalState.isOpen}
        initialTab={batchModalState.tab}
        selectedPhotos={selectedPhotos}
        onClose={() => setBatchModalState((s) => ({ ...s, isOpen: false }))}
        onApplyBatch={async (options) => {
          await applyBatchEditRequest(Array.from(selectedIds), options);
        }}
        onSwitchToMapPinPicker={() => {
          setActiveView('location');
          setIsMapPinPicking(true);
        }}
      />

      {/* Folder Browser & Demo Loader Modal */}
      <FolderPickerModal
        isOpen={isFolderModalOpen}
        currentFolderPath={scanData?.folderPath || ''}
        onClose={() => setIsFolderModalOpen(false)}
        onSelectFolder={loadCustomFolder}
        onLoadDemo={loadDemoAlbum}
      />
    </div>
  );
};

export default App;
