import { dismissOperationStatus, runGlobalOperation } from '../services/operationStatusStore';

export const useOperationStatus = () => {
  return {
    // The overlay is rendered once by OperationStatusProvider at app level.
    operationStatus: null,
    runOperation: runGlobalOperation,
    closeOperationStatus: dismissOperationStatus,
  };
};
