import { PAPER_MONTHS } from '../lib/constants.js';

export const detectUploaderPaperMonth = (fileName = '') => {
  const lower = String(fileName).toLowerCase();
  if (/\bdec(?:ember)?\b/.test(lower)) return 'November';
  return PAPER_MONTHS.find((month) => lower.includes(month.toLowerCase())) ?? PAPER_MONTHS[0];
};
