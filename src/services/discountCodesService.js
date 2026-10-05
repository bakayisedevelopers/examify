import { httpsCallable } from 'firebase/functions';
import { functions, isFirebaseConfigured } from '../firebase/config';

const callDiscountFunction = async (name, payload = {}) => {
  if (!isFirebaseConfigured) throw new Error('Discount codes require a connected Firebase account.');
  const response = await httpsCallable(functions, name)(payload);
  return response.data;
};

export const createDiscountCode = (settings) => callDiscountFunction('createDiscountCode', settings);
export const listDiscountCodes = () => callDiscountFunction('listDiscountCodes');
export const setDiscountCodeActive = ({ code, active }) => callDiscountFunction('setDiscountCodeActive', { code, active });
export const updateDiscountCodeTitle = ({ code, title }) => callDiscountFunction('updateDiscountCodeTitle', { code, title });
export const validateDiscountCode = (payload) => callDiscountFunction('validateDiscountCode', payload);
export const previewDiscountCode = (payload) => callDiscountFunction('previewDiscountCode', payload);
