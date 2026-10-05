import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase/config';

const callWhatsAppFunction = async (name, payload = {}) => {
  if (!functions) throw new Error('Firebase Functions are not configured. WhatsApp settings are unavailable.');
  return (await httpsCallable(functions, name)(payload)).data;
};

export const getTutorWhatsAppSettings = () => callWhatsAppFunction('getTutorWhatsAppSettings');
export const saveTutorWhatsAppNumber = (whatsappNumber) => callWhatsAppFunction('saveTutorWhatsAppNumber', { whatsappNumber });
export const saveTutorWhatsAppGroupLink = ({ subject, groupLink }) => callWhatsAppFunction('saveTutorWhatsAppGroupLink', { subject, groupLink });
export const getAuthorizedLessonWhatsAppAccess = (payload) => callWhatsAppFunction('getAuthorizedLessonWhatsAppAccess', payload);
