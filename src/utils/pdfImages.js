import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const pdfWasmUrl = '/pdfjs/wasm/';

const canvasToDataUrl = (canvas, quality = 0.82) => canvas.toDataURL('image/jpeg', quality);

const normalizePageText = (items = []) => items
  .map((item) => item?.str ?? '')
  .join(' ')
  .replace(/\s+/g, ' ')
  .trim();

export const isPdfFile = (fileOrRecord = {}) => {
  const type = String(fileOrRecord.type || fileOrRecord.mimeType || '').toLowerCase();
  const name = String(fileOrRecord.name || fileOrRecord.fileName || fileOrRecord.url || fileOrRecord.fileUrl || '').toLowerCase();
  return type.includes('pdf') || name.endsWith('.pdf') || name.includes('.pdf?');
};

export const renderPdfFileToImages = async ({ file, maxWidth = 1200, quality = 0.75, maxPages = 40, onProgress }) => {
  if (!file) return [];

  const source = file instanceof Blob ? await file.arrayBuffer() : file;
  const pdf = await getDocument({ data: new Uint8Array(source), wasmUrl: pdfWasmUrl, useWasm: true }).promise;
  const totalPages = Math.min(pdf.numPages, maxPages);
  const pages = [];

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(maxWidth / baseViewport.width, 2);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false });

    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    const [textContent] = await Promise.all([
      page.getTextContent().catch(() => ({ items: [] })),
      page.render({ canvasContext: context, viewport }).promise,
    ]);

    pages.push({
      pageNumber,
      totalPages: pdf.numPages,
      imageDataUrl: canvasToDataUrl(canvas, quality),
      text: normalizePageText(textContent.items),
    });

    canvas.width = 0;
    canvas.height = 0;
    onProgress?.({ pageNumber, totalPages, phase: 'rendered' });
  }

  return pages;
};

export const fetchUrlAsBlob = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load document for retry (${response.status}).`);
  }
  return response.blob();
};
