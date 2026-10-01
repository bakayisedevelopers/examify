import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export const ImagePageViewer = ({ images = [], title, alt = 'Exercise work image' }) => {
  const pages = useMemo(() => images
    .map((image) => typeof image === 'string' ? { url: image } : image)
    .filter((image) => image?.url), [images]);
  const firstPageUrl = pages[0]?.url;
  const pageCount = pages.length;
  const [page, setPage] = useState(0);

  useEffect(() => setPage(0), [pageCount, firstPageUrl]);
  if (!pages.length) return null;

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex min-h-9 items-center justify-between gap-2">
        {title ? <p className="text-sm font-medium text-slate-600">{title}</p> : <span />}
        {pages.length > 1 ? <div className="flex items-center gap-2 text-xs text-slate-500">
          <button type="button" className="btn-secondary inline-flex items-center justify-center p-2" aria-label="Previous image page" title="Previous page" onClick={() => setPage((current) => (current - 1 + pages.length) % pages.length)}>
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <span aria-live="polite">{page + 1}/{pages.length}</span>
          <button type="button" className="btn-secondary inline-flex items-center justify-center p-2" aria-label="Next image page" title="Next page" onClick={() => setPage((current) => (current + 1) % pages.length)}>
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div> : null}
      </div>
      <a href={pages[page].url} target="_blank" rel="noreferrer" aria-label={`Open image page ${page + 1}`} className="block w-full overflow-hidden rounded-md bg-slate-100">
        <img src={pages[page].url} alt={`${alt}, page ${page + 1} of ${pages.length}`} className="block max-h-[72dvh] min-h-48 w-full object-contain" />
      </a>
    </div>
  );
};
