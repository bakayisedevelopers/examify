import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { LoaderCircle, RefreshCw } from 'lucide-react';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const PDF_WASM_URL = '/pdfjs/wasm/';

export const InAppPdfPage = ({ url, pageNumber = 1, className = '' }) => {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const [pdf, setPdf] = useState(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [isLoading, setIsLoading] = useState(Boolean(url));
  const [error, setError] = useState('');
  const [retryVersion, setRetryVersion] = useState(0);

  useEffect(() => {
    if (!url) {
      setPdf(null);
      setIsLoading(false);
      setError('This PDF is not available.');
      return undefined;
    }

    let active = true;
    const loadingTask = getDocument({ url, wasmUrl: PDF_WASM_URL, useWasm: true, disableRange: true, disableStream: true });
    setPdf(null);
    setIsLoading(true);
    setError('');

    loadingTask.promise.then((document) => {
      if (!active) {
        void document.destroy();
        return;
      }
      setPdf(document);
      setIsLoading(false);
    }).catch((loadError) => {
      if (!active) return;
      setError(loadError?.message || 'The PDF could not be loaded inside Examifying. Check your connection and try again.');
      setIsLoading(false);
    });

    return () => {
      active = false;
      void loadingTask.destroy();
    };
  }, [retryVersion, url]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const updateWidth = () => setContainerWidth(container.clientWidth);
    updateWidth();

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateWidth);
      observer.observe(container);
      return () => observer.disconnect();
    }

    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, [pdf]);

  useEffect(() => {
    if (!pdf || !canvasRef.current || !containerWidth) return undefined;
    let active = true;
    let renderTask;
    setError('');

    const safePageNumber = Math.max(1, Math.floor(Number(pageNumber) || 1));
    if (safePageNumber > pdf.numPages) {
      setError(`This paper has ${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'}.`);
      return undefined;
    }

    pdf.getPage(safePageNumber).then((page) => {
      if (!active || !canvasRef.current) return;
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(containerWidth / baseViewport.width, 1.5);
      const viewport = page.getViewport({ scale });
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('The browser could not prepare the PDF page canvas.');

      canvas.width = Math.ceil(viewport.width * outputScale);
      canvas.height = Math.ceil(viewport.height * outputScale);
      canvas.style.width = `${Math.ceil(viewport.width)}px`;
      canvas.style.height = `${Math.ceil(viewport.height)}px`;
      renderTask = page.render({
        canvasContext: context,
        viewport,
        transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
      });
      return renderTask.promise;
    }).catch((renderError) => {
      if (active && renderError?.name !== 'RenderingCancelledException') {
        setError(renderError?.message || 'This PDF page could not be rendered.');
      }
    });

    return () => {
      active = false;
      renderTask?.cancel();
    };
  }, [containerWidth, pageNumber, pdf]);

  return (
    <div ref={containerRef} className={`relative flex min-h-0 w-full justify-center overflow-auto ${className}`}>
      {isLoading ? <div role="status" className="absolute inset-0 z-10 grid place-items-center bg-slate-900/90 p-6 text-center text-sm text-slate-200">
        <span className="inline-flex items-center gap-2"><LoaderCircle className="h-4 w-4 animate-spin text-lime-400" aria-hidden="true" />Loading PDF page…</span>
      </div> : null}
      {error ? <div role="alert" className="absolute inset-0 z-10 grid place-items-center bg-slate-900/95 p-6 text-center text-sm text-slate-200">
        <div className="max-w-md space-y-4">
          <p>{error}</p>
          {url ? <button type="button" className="btn-secondary inline-flex items-center gap-2" onClick={() => setRetryVersion((current) => current + 1)}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />Retry loading PDF
          </button> : null}
        </div>
      </div> : null}
      <canvas key={pageNumber} ref={canvasRef} className="h-fit max-w-full bg-white shadow-xl" aria-label={`PDF page ${pageNumber}`} />
    </div>
  );
};
