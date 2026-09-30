import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { getFunctions } from 'firebase-admin/functions';
import { getAppConfig } from './config.js';

if (!admin.apps.length) {
  admin.initializeApp();
}

let dbInstance = null;
let firestoreDatabaseId = '(default)';

export const getDb = () => {
  if (dbInstance) return dbInstance;

  const appConfig = getAppConfig();
  firestoreDatabaseId = appConfig.firestoreDatabaseId;

  dbInstance =
    firestoreDatabaseId === '(default)'
      ? getFirestore()
      : getFirestore(firestoreDatabaseId);

  return dbInstance;
};

export const storage = admin.storage();
export const taskQueue = (functionName) => getFunctions().taskQueue(functionName);
export const getFirestoreDatabaseId = () => firestoreDatabaseId;
export { admin };
