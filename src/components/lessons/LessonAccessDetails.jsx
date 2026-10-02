import { ExternalLink, MapPin, MessageCircle } from 'lucide-react';
import { CopyTextButton } from '../common/CopyTextButton';
import { normalizeWhatsAppLessonLink } from '../../utils/whatsapp';

export const LessonAccessDetails = ({ lessonType = 'online', whatsappLessonLink = '', locationDetails = '' }) => {
  let safeLink = '';
  try {
    safeLink = normalizeWhatsAppLessonLink(whatsappLessonLink);
  } catch {
    safeLink = '';
  }

  const showLink = lessonType !== 'inPerson' && Boolean(safeLink);
  const showLocation = lessonType === 'inPerson' && Boolean(locationDetails);
  if (!showLink && !showLocation) return null;

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
      {showLink ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <MessageCircle className="mt-0.5 h-4 w-4 flex-none text-lime-700" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase text-slate-500">WhatsApp lesson link</p>
              <a className="break-all text-sm font-medium text-lime-800 underline" href={safeLink} target="_blank" rel="noreferrer">{safeLink}</a>
            </div>
          </div>
          <div className="flex flex-none items-center gap-2">
            <a className="btn-secondary inline-flex h-10 items-center gap-2" href={safeLink} target="_blank" rel="noreferrer" aria-label="Open WhatsApp lesson link" title="Open WhatsApp lesson link"><ExternalLink className="h-4 w-4" />Open</a>
            <CopyTextButton value={safeLink} label="WhatsApp lesson link" />
          </div>
        </div>
      ) : null}
      {showLocation ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <MapPin className="mt-0.5 h-4 w-4 flex-none text-lime-700" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase text-slate-500">In-person venue</p>
              <p className="whitespace-pre-wrap text-sm text-slate-800">{locationDetails}</p>
            </div>
          </div>
          <CopyTextButton value={locationDetails} label="in-person venue" />
        </div>
      ) : null}
    </div>
  );
};
