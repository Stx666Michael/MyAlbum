import React, { useEffect, useState, useCallback } from 'react';
import {
  FolderOpen,
  Folder,
  HardDrive,
  ArrowUp,
  Sparkles,
  X,
  Check,
  RefreshCw,
  Image as ImageIcon,
  ChevronRight,
} from 'lucide-react';
import type { BrowseResponse } from '../types/photo.ts';

interface FolderPickerModalProps {
  isOpen: boolean;
  currentFolderPath: string;
  onClose: () => void;
  onSelectFolder: (folderPath: string) => Promise<void>;
  onLoadDemo: (resetEdits?: boolean) => Promise<void>;
}

export const FolderPickerModal: React.FC<FolderPickerModalProps> = ({
  isOpen,
  currentFolderPath,
  onClose,
  onSelectFolder,
  onLoadDemo,
}) => {
  const [manualPath, setManualPath] = useState<string>(currentFolderPath);
  const [browseData, setBrowseData] = useState<BrowseResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fetchBrowse = useCallback(async (dirPath?: string) => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const q = dirPath ? `?dir=${encodeURIComponent(dirPath)}` : '';
      const res = await fetch(`/api/browse${q}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to browse directory');
      }
      setBrowseData(data);
      setManualPath(data.currentPath);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to read directory');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchBrowse(currentFolderPath || undefined);
    }
  }, [isOpen, currentFolderPath, fetchBrowse]);

  if (!isOpen) return null;

  const handleScanManualPath = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualPath.trim()) return;
    setIsLoading(true);
    setErrorMsg(null);
    try {
      await onSelectFolder(manualPath.trim());
      onClose();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to scan folder');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md"
      data-testid="folder-picker-modal"
    >
      <div className="relative flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-500/15 border border-sky-500/30 text-sky-400">
              <FolderOpen className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-base font-semibold text-white">Open Photo Folder</h2>
              <p className="text-xs text-slate-400">
                Scans the selected folder and all nested subfolders recursively
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex flex-col gap-4 p-6">
          {/* Built-in Curated Demo Album Banner */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-500/30 bg-gradient-to-r from-sky-950/60 via-slate-900 to-indigo-950/50 p-4">
            <div className="space-y-0.5">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-sky-300">
                <Sparkles className="h-4 w-4" />
                Curated Global Demo Album (52 Photos • 9 Days • 9 Subfolders)
              </div>
              <p className="text-xs text-slate-400">
                Includes real EXIF & GPS across Tokyo, Paris, Iceland, NYC, Cairo, Sydney & Studio
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={async () => {
                  setIsLoading(true);
                  try {
                    await onLoadDemo(true);
                    onClose();
                  } finally {
                    setIsLoading(false);
                  }
                }}
                className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/90 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:border-amber-400/50 hover:text-amber-300 transition"
                title="Reset any batch edits made to the demo album"
                data-testid="reset-demo-album-btn"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Reset Demo
              </button>
              <button
                type="button"
                onClick={async () => {
                  setIsLoading(true);
                  try {
                    await onLoadDemo(false);
                    onClose();
                  } finally {
                    setIsLoading(false);
                  }
                }}
                className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-sky-400 transition shadow"
                data-testid="load-demo-album-btn"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Load Demo Album
              </button>
            </div>
          </div>

          {/* Direct Folder Path Input */}
          <form onSubmit={handleScanManualPath} className="flex gap-2">
            <input
              type="text"
              value={manualPath}
              onChange={(e) => setManualPath(e.target.value)}
              placeholder="Enter or paste local folder path (e.g. C:\Users\User\Pictures)"
              className="flex-1 rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2 font-mono text-xs text-white placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
              data-testid="folder-path-input"
            />
            <button
              type="submit"
              disabled={isLoading || !manualPath.trim()}
              className="flex items-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50 transition"
              data-testid="scan-folder-submit-btn"
            >
              <Check className="h-4 w-4" />
              Scan This Folder
            </button>
          </form>

          {errorMsg && (
            <div className="rounded-xl border border-rose-500/40 bg-rose-950/30 px-3.5 py-2 text-xs text-rose-300">
              {errorMsg}
            </div>
          )}

          {/* Visual Directory Browser */}
          <div className="flex flex-col rounded-xl border border-slate-800 bg-slate-950/70 overflow-hidden">
            {/* Drives & Parent Bar */}
            <div className="flex items-center justify-between border-b border-slate-800/80 bg-slate-900/70 px-3.5 py-2">
              <div className="flex items-center gap-1.5">
                {browseData?.drives.map((drive) => (
                  <button
                    key={drive}
                    type="button"
                    onClick={() => fetchBrowse(drive)}
                    className="flex items-center gap-1 rounded-md border border-slate-800 bg-slate-950 px-2 py-1 font-mono text-xs text-slate-300 hover:border-sky-500/40 hover:text-sky-300"
                  >
                    <HardDrive className="h-3 w-3 text-sky-400" />
                    {drive}
                  </button>
                ))}
              </div>

              {browseData?.parentPath && (
                <button
                  type="button"
                  onClick={() => fetchBrowse(browseData.parentPath!)}
                  className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1 text-xs font-medium text-slate-300 hover:border-slate-700 hover:text-white"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                  Up One Level
                </button>
              )}
            </div>

            {/* Subdirectories List */}
            <div className="max-h-60 overflow-y-auto divide-y divide-slate-800/50">
              {browseData?.directories.length === 0 ? (
                <div className="py-8 text-center text-xs text-slate-500">
                  No subdirectories in this folder ({browseData.imageCountInCurrent} images directly here).
                </div>
              ) : (
                browseData?.directories.map((dir) => (
                  <div
                    key={dir.path}
                    className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-900/80 transition"
                  >
                    <button
                      type="button"
                      onClick={() => fetchBrowse(dir.path)}
                      className="flex flex-1 items-center gap-2.5 text-left min-w-0"
                    >
                      <Folder className="h-4 w-4 text-sky-400 shrink-0" />
                      <span className="truncate text-xs font-medium text-slate-200">{dir.name}</span>
                      {dir.imageCount > 0 && (
                        <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[10px] text-emerald-300">
                          <ImageIcon className="h-2.5 w-2.5" />
                          {dir.imageCount}
                        </span>
                      )}
                      {dir.hasSubfolders && (
                        <ChevronRight className="h-3.5 w-3.5 text-slate-500" />
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={async () => {
                        setIsLoading(true);
                        try {
                          await onSelectFolder(dir.path);
                          onClose();
                        } catch (err: any) {
                          setErrorMsg(err?.message || 'Failed to scan folder');
                        } finally {
                          setIsLoading(false);
                        }
                      }}
                      className="ml-3 rounded-lg border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-[11px] font-medium text-sky-300 hover:bg-sky-500/25 transition shrink-0"
                    >
                      Load Folder
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
