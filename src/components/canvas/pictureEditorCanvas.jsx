import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { ReactSketchCanvas } from 'react-sketch-canvas';

const loadImage = (src) => new Promise((resolve, reject) => {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('Could not load an image page for export.'));
  image.src = src;
});

export const MarkingCanvas = ({ imageUrl, imageUrls = [], onSave, onCancel, saveLabel = 'Save marked work' }) => {
  const canvasRefs = useRef([]);
  const stageRef = useRef(null);
  const pages = useMemo(() => (imageUrls.length ? imageUrls : [imageUrl])
    .map((image) => typeof image === 'string' ? image : image?.url)
    .filter(Boolean), [imageUrl, imageUrls]);
  const pageSignature = pages.join('|');
  const [activePage, setActivePage] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setActivePage(0);
  }, [pageSignature]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onCancel?.();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  const handleExport = async () => {
    const pageCanvases = canvasRefs.current.slice(0, pages.length);
    if (!pages.length || pageCanvases.length < pages.length || pageCanvases.some((canvas) => !canvas)) return;
    setSaving(true);
    setError('');
    try {
      const files = await Promise.all(pageCanvases.map(async (canvas, index) => {
        const [overlayUrl, sourceImage] = await Promise.all([
          canvas.exportImage('png'),
          loadImage(pages[index]),
        ]);
        const overlay = await loadImage(overlayUrl);
        const stage = stageRef.current;
        if (!stage || !sourceImage.naturalWidth || !sourceImage.naturalHeight) throw new Error('Could not load the student page for export.');

        const output = document.createElement('canvas');
        output.width = sourceImage.naturalWidth;
        output.height = sourceImage.naturalHeight;
        const context = output.getContext('2d');
        if (!context) throw new Error('Could not prepare the marked image.');
        context.drawImage(sourceImage, 0, 0);

        const stageWidth = stage.clientWidth;
        const stageHeight = stage.clientHeight;
        const scale = Math.min(stageWidth / output.width, stageHeight / output.height);
        const displayedWidth = output.width * scale;
        const displayedHeight = output.height * scale;
        const offsetX = (stageWidth - displayedWidth) / 2;
        const offsetY = (stageHeight - displayedHeight) / 2;
        context.drawImage(overlay, offsetX, offsetY, displayedWidth, displayedHeight, 0, 0, output.width, output.height);

        const blob = await new Promise((resolve, reject) => output.toBlob((result) => result ? resolve(result) : reject(new Error('Could not encode the marked image.')), 'image/png'));
        return new File([blob], `marked-page-${index + 1}.png`, { type: 'image/png' });
      }));
      await onSave(files);
    } catch (saveError) {
      setError(saveError.message || 'Could not save the marked work.');
    } finally {
      setSaving(false);
    }
  };

  return createPortal((
    <div className="fixed inset-0 z-[100] flex h-[100dvh] flex-col bg-slate-950 p-2 text-white sm:p-4" role="dialog" aria-modal="true" aria-label="Mark exercise pages">
      <header className="relative z-20 flex min-h-12 shrink-0 items-center justify-between gap-3 pb-2">
        <div className="flex items-center gap-2">
          <button type="button" className="btn-secondary inline-flex items-center justify-center p-2" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onCancel?.(); }} aria-label="Close marking workspace" title="Close">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
          <span className="text-sm font-semibold">Page {activePage + 1}/{pages.length}</span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="btn-secondary inline-flex items-center justify-center p-2" onClick={() => setActivePage((current) => (current - 1 + pages.length) % pages.length)} disabled={pages.length < 2} aria-label="Previous page" title="Previous page">
            <ChevronLeft className="h-5 w-5" aria-hidden="true" />
          </button>
          <button type="button" className="btn-secondary inline-flex items-center justify-center p-2" onClick={() => setActivePage((current) => (current + 1) % pages.length)} disabled={pages.length < 2} aria-label="Next page" title="Next page">
            <ChevronRight className="h-5 w-5" aria-hidden="true" />
          </button>
          <button type="button" className="btn-primary" onClick={handleExport} disabled={saving || !pages.length}>
            {saving ? 'Saving pages...' : saveLabel}
          </button>
        </div>
      </header>
      <main ref={stageRef} className="relative h-[calc(100dvh-6rem)] min-h-0 w-full flex-none overflow-hidden rounded-md bg-white">
        <img src={pages[activePage]} alt={`Student work page ${activePage + 1}`} className="pointer-events-none absolute inset-0 h-full w-full object-contain" />
        {pages.map((url, index) => (
          <div key={`${url}-${index}`} className={`absolute inset-0 ${index === activePage ? 'visible' : 'invisible pointer-events-none'}`} aria-hidden={index !== activePage}>
            <ReactSketchCanvas
              ref={(canvas) => { canvasRefs.current[index] = canvas; }}
              width="100%"
              height="100%"
              strokeWidth={4}
              strokeColor="red"
              canvasColor="transparent"
              style={{ border: 0, borderRadius: 0 }}
            />
          </div>
        ))}
      </main>
      {error ? <p role="alert" className="pt-2 text-sm text-rose-300">{error}</p> : null}
    </div>
  ), document.body);
};
