import { httpsCallable } from 'firebase/functions';
import { functions, isFirebaseConfigured } from '../firebase/config';

const ensureFunctions = () => {
  if (!isFirebaseConfigured || !functions) {
    throw new Error('Firebase Functions are not configured.');
  }
};

const callKilo = async (name, payload) => {
  ensureFunctions();
  const callable = httpsCallable(functions, name);
  const response = await callable(payload);
  return response.data;
};

export const callKiloText = (payload) => callKilo('callKiloText', payload);

export const callKiloImage = ({ prompt, imageUrl, imageDataUrl, imageUrls, maxTokens = 1500, temperature = 0.2 }) =>
  callKilo('callKiloImage', {
    prompt,
    imageUrl,
    imageDataUrl,
    imageUrls,
    maxTokens,
    temperature,
  });

export const callKiloDocument = ({
  prompt,
  documentUrl,
  documentDataUrl,
  documentImages,
  documentMimeType,
  fileName,
  extractedText,
  maxTokens = 2500,
  temperature = 0.2,
  responseFormat,
}) =>
  callKilo('callKiloDocument', {
    prompt,
    documentUrl,
    documentDataUrl,
    documentImages,
    documentMimeType,
    fileName,
    extractedText,
    maxTokens,
    temperature,
    responseFormat,
  });
