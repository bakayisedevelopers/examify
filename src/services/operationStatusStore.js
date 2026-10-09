let snapshot = null;
let sequence = 0;
let currentOperationId = null;
const listeners = new Set();
const activeOperations = new Map();

const publish = () => listeners.forEach((listener) => listener());

export const subscribeToOperationStatus = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getOperationStatusSnapshot = () => snapshot;

const showLatestActiveOperation = () => {
  const activeEntries = [...activeOperations.entries()];
  const latest = activeEntries[activeEntries.length - 1];
  if (!latest) {
    snapshot = null;
    currentOperationId = null;
    return;
  }
  const [id, operation] = latest;
  currentOperationId = id;
  snapshot = {
    state: 'working',
    operationName: operation.operationName,
    message: operation.message || '',
    showProgress: operation.showProgress === true,
  };
};

export const dismissOperationStatus = () => {
  if (activeOperations.size) showLatestActiveOperation();
  else {
    snapshot = null;
    currentOperationId = null;
  }
  publish();
};

export const runGlobalOperation = async ({ operationName = 'Saving your changes', successMessage = '', failureMessage = '', message = '', autoDismissMs = 0, showProgress = false } = {}, action) => {
  if (typeof action !== 'function') throw new TypeError('An operation callback is required.');

  const id = ++sequence;
  const operation = { operationName, message, showProgress };
  activeOperations.set(id, operation);
  currentOperationId = id;
  snapshot = { state: 'working', operationName, message, showProgress, operationId: id };
  publish();

  try {
    const result = await action();
    activeOperations.delete(id);
    if (currentOperationId === id) {
      if (activeOperations.size) showLatestActiveOperation();
      else {
        snapshot = { state: 'success', operationName, message: successMessage, operationId: id };
        if (autoDismissMs > 0) {
          setTimeout(() => {
            if (snapshot?.operationId === id && !activeOperations.size) dismissOperationStatus();
          }, autoDismissMs);
        }
      }
      publish();
    }
    return result;
  } catch (error) {
    activeOperations.delete(id);
    if (currentOperationId === id) {
      if (activeOperations.size) showLatestActiveOperation();
      else snapshot = {
        state: 'failed',
        operationName,
        operationId: id,
        message: error?.message || failureMessage || 'The action did not finish successfully. Please try again.',
      };
      publish();
    }
    throw error;
  }
};
