import { useSyncExternalStore } from 'react';
import { OperationStatusOverlay } from './OperationStatusOverlay';
import {
  dismissOperationStatus,
  getOperationStatusSnapshot,
  subscribeToOperationStatus,
} from '../../services/operationStatusStore';

export const OperationStatusProvider = ({ children }) => {
  const status = useSyncExternalStore(
    subscribeToOperationStatus,
    getOperationStatusSnapshot,
    getOperationStatusSnapshot,
  );

  return (
    <>
      {children}
      {status ? (
        <OperationStatusOverlay
          state={status.state}
          operationName={status.operationName}
          message={status.message}
          showProgress={status.showProgress}
          onDone={status.state === 'working' || status.state === 'processing' ? undefined : dismissOperationStatus}
        />
      ) : null}
    </>
  );
};
