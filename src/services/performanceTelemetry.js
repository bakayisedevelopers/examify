const noMeasurement = Object.freeze({ finish: () => {}, cancel: () => {} });

// Keep existing call sites intact while ensuring diagnostics never emit browser-console data.
export const trackFirestoreRead = async (_operation, read) => read();
export const trackDataRequest = async (_name, request) => request();
export const trackFirestoreListener = () => {};
export const startScreenLoadMeasurement = () => noMeasurement;
