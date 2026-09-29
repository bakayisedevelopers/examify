import { callKiloDocument } from './kiloService';
import { fetchUrlAsBlob, isPdfFile, renderPdfFileToImages } from '../utils/pdfImages';

const DEFAULT_BATCH_SIZE = 2;

export const extractDocumentText = async ({
  file,
  documentUrl,
  documentDataUrl,
  documentMimeType,
  fileName,
  label = 'Document',
  prompt,
  batchSize = DEFAULT_BATCH_SIZE,
  maxPages = 40,
  onProgress,
}) => {
  const record = { type: file?.type || documentMimeType, name: file?.name || fileName, url: documentUrl };
  const isPdf = isPdfFile(record);

  if (isPdf) {
    let pdfBlob = file;
    if (!pdfBlob && documentUrl) {
      onProgress?.(`${label} [Loading PDF]`);
      pdfBlob = await fetchUrlAsBlob(documentUrl);
    }

    const pages = await renderPdfFileToImages({
      file: pdfBlob,
      maxPages,
      onProgress: ({ pageNumber, totalPages }) => onProgress?.(`${label} [Page ${pageNumber}/${Math.min(totalPages, maxPages)} rendered]`),
    });

    const batchResults = [];
    const totalPages = pages.length;

    for (let index = 0; index < pages.length; index += batchSize) {
      const batch = pages.slice(index, index + batchSize);
      const firstPage = batch[0]?.pageNumber ?? index + 1;
      const lastPage = batch[batch.length - 1]?.pageNumber ?? firstPage;
      onProgress?.(`${label} [Pages ${firstPage}-${lastPage}/${totalPages} extracting]`);

      const embeddedText = batch
        .map((page) => page.text ? `Page ${page.pageNumber} embedded PDF text:\n${page.text}` : '')
        .filter(Boolean)
        .join('\n\n');

      let result = null;
      try {
        result = await callKiloDocument({
          documentImages: batch.map((page) => page.imageDataUrl),
          documentMimeType: 'image/jpeg',
          fileName,
          extractedText: embeddedText,
          prompt: [
            prompt,
            `These images are pages ${firstPage}-${lastPage} of ${totalPages} from ${fileName || label}.`,
            embeddedText ? 'Use the embedded PDF text below together with the rendered page images. Prefer embedded text when it contains subject names and marks.' : '',
            'Return only the requested extraction for these pages.',
          ].filter(Boolean).join('\n'),
          maxTokens: 2200,
          temperature: 0,
        });
      } catch (error) {
        if (!embeddedText) throw error;
        console.warn('[Examifying][DocumentExtraction] Vision extraction failed; using embedded PDF text:', error);
        onProgress?.(`${label} [${lastPage}/${totalPages} Embedded text used]`);
      }

      batchResults.push({
        pages: batch.map((page) => page.pageNumber),
        text: [embeddedText, result?.text ?? ''].filter(Boolean).join('\n\n'),
        model: result?.model ?? (embeddedText ? 'embedded-pdf-text' : ''),
      });
      onProgress?.(`${label} [${lastPage}/${totalPages} Extracted]`);
    }

    return {
      text: batchResults.map((entry) => `Pages ${entry.pages.join('-')}\n${entry.text}`.trim()).join('\n\n'),
      model: batchResults.map((entry) => entry.model).filter(Boolean).join(', '),
      pageCount: totalPages,
      batches: batchResults,
      mode: 'pdf-images',
    };
  }

  onProgress?.(`${label} [Image extracting]`);
  const result = await callKiloDocument({
    documentUrl,
    documentDataUrl,
    documentMimeType: documentMimeType || file?.type,
    fileName: fileName || file?.name,
    prompt,
    maxTokens: 2200,
    temperature: 0,
  });
  onProgress?.(`${label} [Image extracted]`);

  return {
    text: result?.text ?? '',
    model: result?.model ?? '',
    pageCount: 1,
    batches: [{ pages: [1], text: result?.text ?? '', model: result?.model ?? '' }],
    mode: 'image',
  };
};
