import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  Camera,
  Aperture,
  Folder,
  HardDrive,
  Maximize2,
  Minimize2,
  Edit3,
  Trash2,
  Check,
  Crosshair,
  Sparkles,
} from 'lucide-react';
import type { PhotoItem } from '../types/photo.ts';
import {
  formatWallClockDate,
  formatWallClockDateTime,
  getWallClockParts,
} from '../utils/timelineMath.ts';

interface PhotoLightboxProps {
  photo: PhotoItem | null;
  photos: PhotoItem[];
  selectedIds: Set<string>;
  onClose: () => void;
  onNavigate: (nextPhoto: PhotoItem) => void;
  onToggleSelect: (photoId: string) => void;
  onQuickEditTime: (photo: PhotoItem) => void;
  onQuickEditLocation: (photo: PhotoItem) => void;
  onQuickRemoveLocation: (photo: PhotoItem) => void;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export const PhotoLightbox: React.FC<PhotoLightboxProps> = ({
  photo,
  photos,
  selectedIds,
  onClose,
  onNavigate,
  onToggleSelect,
  onQuickEditTime,
  onQuickEditLocation,
  onQuickRemoveLocation,
}) => {
  const [isZoomed, setIsZoomed] = useState(false);

  useEffect(() => {
    setIsZoomed(false);
  }, [photo?.id]);

  useEffect(() => {
    if (!photo) return;
    const currentIndex = photos.findIndex((p) => p.id === photo.id);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowLeft' && currentIndex > 0) {
        onNavigate(photos[currentIndex - 1]);
      } else if (e.key === 'ArrowRight' && currentIndex >= 0 && currentIndex < photos.length - 1) {
        onNavigate(photos[currentIndex + 1]);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [photo, photos, onClose, onNavigate]);

  if (!photo) return null;

  const currentIndex = photos.findIndex((p) => p.id === photo.id);
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < photos.length - 1;
  const isSelected = selectedIds.has(photo.id);
  const { timeLabel } = getWallClockParts(photo.timestamp);

  return (
    <AnimatePresence>
      <motion.div
        key="lightbox-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="fixed inset-0 z-50 flex bg-slate-950/92 backdrop-blur-xl"
        data-testid="photo-lightbox-modal"
      >
        {/* Left/Center Main Image Stage */}
        <div
          className="relative flex flex-1 flex-col items-center justify-center overflow-hidden p-6"
          onClick={onClose}
        >
          {/* Top Stage Action Bar */}
          <div
            className="absolute inset-x-6 top-5 z-20 flex items-center justify-between"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 rounded-xl border border-slate-800/90 bg-slate-900/85 px-3.5 py-1.5 text-xs text-slate-300 backdrop-blur-md">
              <span className="font-mono text-sky-400 font-semibold">
                {currentIndex + 1} / {photos.length}
              </span>
              <span className="text-slate-700">•</span>
              <span className="font-medium text-slate-50 truncate max-w-xs">{photo.fileName}</span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onToggleSelect(photo.id)}
                className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium transition ${
                  isSelected
                    ? 'border-sky-400 bg-sky-500 text-on-accent'
                    : 'border-slate-700 bg-slate-900/85 text-slate-200 hover:border-sky-400/50'
                }`}
                data-testid="lightbox-select-btn"
              >
                <Check className="h-3.5 w-3.5" />
                {isSelected ? 'Selected' : 'Select for Batch'}
              </button>

              <button
                type="button"
                onClick={() => setIsZoomed((z) => !z)}
                className="rounded-xl border border-slate-800 bg-slate-900/85 p-2 text-slate-300 hover:bg-slate-800 hover:text-slate-50 transition"
                title={isZoomed ? 'Fit to screen' : 'Zoom in'}
              >
                {isZoomed ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </button>

              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-slate-800 bg-slate-900/85 p-2 text-slate-300 hover:bg-slate-800 hover:text-slate-50 transition"
                title="Close (Esc)"
                data-testid="lightbox-close-btn"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Previous Photo Arrow */}
          {hasPrev && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onNavigate(photos[currentIndex - 1]);
              }}
              className="absolute left-5 top-1/2 z-20 -translate-y-1/2 rounded-full border border-slate-700/80 bg-slate-900/85 p-3 text-slate-200 shadow-2xl hover:border-sky-400 hover:text-sky-300 transition"
              title="Previous photo (←)"
              data-testid="lightbox-prev-btn"
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
          )}

          {/* Next Photo Arrow */}
          {hasNext && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onNavigate(photos[currentIndex + 1]);
              }}
              className="absolute right-5 top-1/2 z-20 -translate-y-1/2 rounded-full border border-slate-700/80 bg-slate-900/85 p-3 text-slate-200 shadow-2xl hover:border-sky-400 hover:text-sky-300 transition"
              title="Next photo (→)"
              data-testid="lightbox-next-btn"
            >
              <ChevronRight className="h-6 w-6" />
            </button>
          )}

          {/* High-Res Animated Image */}
          <motion.div
            key={photo.id}
            initial={{ opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: isZoomed ? 1.5 : 1 }}
            transition={{ type: 'spring', stiffness: 280, damping: 26 }}
            onClick={(e) => {
              e.stopPropagation();
              setIsZoomed((z) => !z);
            }}
            className={`relative max-h-[82vh] max-w-[90%] overflow-hidden rounded-2xl border border-slate-800/80 shadow-[0_25px_70px_var(--shadow-deep)] ${
              isZoomed ? 'cursor-zoom-out' : 'cursor-zoom-in'
            }`}
          >
            <img
              src={photo.url}
              alt={photo.fileName}
              className="max-h-[82vh] w-auto object-contain select-none"
              data-testid="lightbox-main-image"
            />
          </motion.div>
        </div>

        {/* Right Sidebar: Photo Details, Timestamp, Location, and Camera EXIF Settings */}
        <motion.aside
          initial={{ x: 40, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          transition={{ duration: 0.22 }}
          onClick={(e) => e.stopPropagation()}
          className="flex w-96 shrink-0 flex-col border-l border-slate-800/90 bg-slate-900/95 overflow-y-auto"
          data-testid="lightbox-info-sidebar"
        >
          <div className="border-b border-slate-800 px-6 py-5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="truncate text-base font-semibold text-slate-50" title={photo.fileName}>
                {photo.fileName}
              </h2>
              {photo.isEdited && (
                <span className="flex items-center gap-1 rounded-full bg-amber-500/20 border border-amber-500/40 px-2 py-0.5 text-[10px] font-semibold text-amber-300 shrink-0">
                  <Sparkles className="h-3 w-3" />
                  Edited
                </span>
              )}
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-400">
              <Folder className="h-3.5 w-3.5 text-sky-400 shrink-0" />
              <span className="truncate" title={photo.relativePath}>
                {photo.subfolder || 'Root Folder'}
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-5 p-6">
            {/* 1. Created Time Card */}
            <div
              className="rounded-2xl border border-slate-800/90 bg-slate-950/60 p-4 space-y-2.5"
              data-testid="lightbox-time-section"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <Clock className="h-4 w-4 text-sky-400" />
                  Capture Time
                </div>
                <button
                  type="button"
                  onClick={() => onQuickEditTime(photo)}
                  className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/80 px-2 py-1 text-[11px] font-medium text-sky-300 hover:border-sky-400/50 transition"
                  data-testid="lightbox-edit-time-btn"
                >
                  <Edit3 className="h-3 w-3" />
                  Edit Time
                </button>
              </div>

              <div>
                <p className="text-sm font-semibold text-slate-50">
                  {formatWallClockDate(photo.timestamp)} at {timeLabel}
                </p>
                <p className="mt-0.5 font-mono text-xs text-slate-400">
                  {formatWallClockDateTime(photo.timestamp)} UTC
                </p>
              </div>

              {photo.isTimeEdited && (
                <div className="rounded-lg bg-amber-500/10 border border-amber-500/25 px-2.5 py-1.5 text-[11px] text-amber-200/90">
                  Original EXIF: {formatWallClockDateTime(photo.originalTimestamp)}
                </div>
              )}
            </div>

            {/* 2. Location / GPS Card */}
            <div
              className="rounded-2xl border border-slate-800/90 bg-slate-950/60 p-4 space-y-3"
              data-testid="lightbox-location-section"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <MapPin className="h-4 w-4 text-emerald-400" />
                  Location Data
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => onQuickEditLocation(photo)}
                    className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/80 px-2 py-1 text-[11px] font-medium text-sky-300 hover:border-sky-400/50 transition"
                    data-testid="lightbox-edit-location-btn"
                  >
                    <Edit3 className="h-3 w-3" />
                    {photo.location ? 'Change' : 'Add GPS'}
                  </button>
                  {photo.location && (
                    <button
                      type="button"
                      onClick={() => onQuickRemoveLocation(photo)}
                      className="rounded-lg border border-rose-500/30 bg-rose-500/15 p-1 text-rose-300 hover:bg-rose-500/25 transition"
                      title="Remove Location"
                      data-testid="lightbox-remove-location-btn"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {photo.location ? (
                <>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-slate-50">
                        {photo.location.name || 'Pinned Coordinates'}
                      </p>
                      {photo.isAutoLocated && (
                        <span
                          className="flex shrink-0 items-center gap-1 rounded-full bg-sky-500/20 border border-sky-500/40 px-2 py-0.5 text-[10px] font-semibold text-sky-300"
                          data-testid="auto-located-badge"
                        >
                          <Crosshair className="h-3 w-3" />
                          Auto-located
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 font-mono text-xs text-emerald-300/90">
                      {photo.location.lat.toFixed(4)}° {photo.location.lat >= 0 ? 'N' : 'S'},{' '}
                      {photo.location.lng.toFixed(4)}° {photo.location.lng >= 0 ? 'E' : 'W'}
                    </p>
                  </div>

                  {/* Mini Coordinate Radar Preview */}
                  <div className="relative h-24 w-full overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
                    <div
                      className="absolute inset-0 opacity-30"
                      style={{
                        backgroundImage:
                          'linear-gradient(to right, var(--color-slate-700) 1px, transparent 1px), linear-gradient(to bottom, var(--color-slate-700) 1px, transparent 1px)',
                        backgroundSize: '18px 18px',
                      }}
                    />
                    {/* Equator & Prime Meridian lines */}
                    <div className="absolute inset-x-0 top-1/2 h-px bg-slate-700/70" />
                    <div className="absolute inset-y-0 left-1/2 w-px bg-slate-700/70" />
                    {/* Plotted GPS Pin on World Mini-Grid */}
                    <div
                      className="absolute -translate-x-1/2 -translate-y-1/2"
                      style={{
                        left: `${((photo.location.lng + 180) / 360) * 100}%`,
                        top: `${((90 - photo.location.lat) / 180) * 100}%`,
                      }}
                    >
                      <span className="absolute -inset-2 animate-ping rounded-full bg-emerald-400/50" />
                      <span className="relative block h-3 w-3 rounded-full border-2 border-white bg-emerald-400 shadow-[0_0_10px_#34d399]" />
                    </div>
                  </div>
                </>
              ) : (
                <div className="rounded-xl border border-dashed border-slate-800 p-3 text-center">
                  <p className="text-xs text-slate-400">No GPS location recorded for this photo.</p>
                  <button
                    type="button"
                    onClick={() => onQuickEditLocation(photo)}
                    className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-sky-400 hover:text-sky-300"
                  >
                    + Assign location now
                  </button>
                </div>
              )}
            </div>

            {/* 3. Camera Hardware & Exposure EXIF Settings */}
            <div
              className="rounded-2xl border border-slate-800/90 bg-slate-950/60 p-4 space-y-3.5"
              data-testid="lightbox-exif-section"
            >
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <Camera className="h-4 w-4 text-indigo-400" />
                Camera & Optical Settings
              </div>

              <div className="space-y-1">
                <p className="text-sm font-semibold text-slate-50">
                  {photo.exif.make || photo.exif.model
                    ? `${photo.exif.make || ''} ${photo.exif.model || ''}`.trim()
                    : 'Digital Camera'}
                </p>
                <p className="text-xs text-slate-400">
                  {photo.exif.lensModel || 'Standard Prime / Zoom Lens'}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div className="rounded-xl border border-slate-800/80 bg-slate-900/90 px-3 py-2">
                  <span className="text-[10px] uppercase tracking-wider text-slate-500">Focal Length</span>
                  <p className="mt-0.5 font-mono text-xs font-semibold text-slate-200">
                    {photo.exif.focalLength ? `${photo.exif.focalLength}mm` : '—'}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800/80 bg-slate-900/90 px-3 py-2">
                  <span className="text-[10px] uppercase tracking-wider text-slate-500">Aperture</span>
                  <p className="mt-0.5 flex items-center gap-1 font-mono text-xs font-semibold text-slate-200">
                    <Aperture className="h-3 w-3 text-sky-400" />
                    {photo.exif.fNumber ? `f/${photo.exif.fNumber}` : '—'}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800/80 bg-slate-900/90 px-3 py-2">
                  <span className="text-[10px] uppercase tracking-wider text-slate-500">Shutter Speed</span>
                  <p className="mt-0.5 font-mono text-xs font-semibold text-slate-200">
                    {photo.exif.exposureTime || '—'}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800/80 bg-slate-900/90 px-3 py-2">
                  <span className="text-[10px] uppercase tracking-wider text-slate-500">ISO Sensitivity</span>
                  <p className="mt-0.5 font-mono text-xs font-semibold text-slate-200">
                    {photo.exif.iso ? `ISO ${photo.exif.iso}` : '—'}
                  </p>
                </div>
              </div>
            </div>

            {/* 4. File Storage Details */}
            <div className="rounded-2xl border border-slate-800/90 bg-slate-950/60 p-4 space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <HardDrive className="h-4 w-4 text-slate-400" />
                File Information
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-slate-500">Dimensions:</span>
                  <p className="font-mono text-slate-200">
                    {photo.exif.width && photo.exif.height
                      ? `${photo.exif.width} × ${photo.exif.height} px`
                      : '960 × 640 px'}
                  </p>
                </div>
                <div>
                  <span className="text-slate-500">File Size:</span>
                  <p className="font-mono text-slate-200">{formatBytes(photo.fileSize)}</p>
                </div>
              </div>
              <div className="pt-1 text-[11px] text-slate-500 break-all font-mono">
                {photo.relativePath}
              </div>
            </div>
          </div>
        </motion.aside>
      </motion.div>
    </AnimatePresence>
  );
};
