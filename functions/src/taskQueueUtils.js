import { createHash } from 'node:crypto';
import { taskQueue } from './admin.js';

export const stableTaskId = (prefix, key) => {
  const digest = createHash('sha256').update(String(key)).digest('hex').slice(0, 40);
  return `${prefix}-${digest}`;
};

export const enqueueTaskOnce = async (functionName, data, { id, scheduleTime } = {}) => {
  try {
    await taskQueue(functionName).enqueue(data, {
      ...(id ? { id } : {}),
      ...(scheduleTime ? { scheduleTime } : {}),
    });
    return true;
  } catch (error) {
    if (error?.code === 'functions/task-already-exists') return false;
    throw error;
  }
};
