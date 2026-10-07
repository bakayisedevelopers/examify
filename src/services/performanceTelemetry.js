const activeMeasurements = new Map();
let measurementSequence = 0;

const isMeasurementEnabled = () => {
  if (import.meta.env.DEV) return true;
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('perf') === '1'
      || window.localStorage.getItem('examifying:perf') === '1';
  } catch {
    return false;
  }
};

const currentRoute = () => (typeof window === 'undefined' ? '' : window.location.pathname);
const activeMeasurementsForRoute = (route) => [...activeMeasurements.values()]
  .filter((measurement) => measurement.route === route);

const getCaller = () => new Error().stack?.split('\n')
  .slice(2)
  .find((line) => !line.includes('performanceTelemetry'))
  ?.trim();

const snapshotDocumentCount = (snapshot) => {
  if (typeof snapshot?.size === 'number') return snapshot.size;
  if (typeof snapshot?.exists === 'function') return snapshot.exists() ? 1 : 0;
  return 0;
};

const recordRead = ({ operation, durationMs, documentsReturned, failed = false, source = 'server', route }) => {
  if (!isMeasurementEnabled()) return;
  const caller = getCaller();
  activeMeasurementsForRoute(route).forEach((measurement) => {
    measurement.firestoreReadOperations += 1;
    measurement.firestoreDocumentsReturned += documentsReturned;
    measurement.firestoreReadDurationMs += durationMs;
    if (failed) measurement.firestoreReadFailures += 1;
    measurement.readEvents.push({ operation, durationMs, documentsReturned, failed, source, caller });
  });
  console.debug('[Examifying][Perf][Firestore]', {
    operation,
    durationMs: Math.round(durationMs),
    documentsReturned,
    failed,
    source,
    caller,
  });
};

export const trackFirestoreRead = async (operation, read) => {
  if (!isMeasurementEnabled()) return read();
  const startedAt = performance.now();
  const route = currentRoute();
  try {
    const snapshot = await read();
    recordRead({
      operation,
      durationMs: performance.now() - startedAt,
      documentsReturned: snapshotDocumentCount(snapshot),
      route,
    });
    return snapshot;
  } catch (error) {
    recordRead({
      operation,
      durationMs: performance.now() - startedAt,
      documentsReturned: 0,
      failed: true,
      route,
    });
    throw error;
  }
};

export const trackDataRequest = async (name, request) => {
  if (!isMeasurementEnabled()) return request();
  const startedAt = performance.now();
  const measurements = activeMeasurementsForRoute(currentRoute());
  measurements.forEach((measurement) => { measurement.dataRequests += 1; });
  try {
    const result = await request();
    const durationMs = performance.now() - startedAt;
    measurements.forEach((measurement) => { measurement.dataRequestDurationMs += durationMs; });
    console.debug('[Examifying][Perf][Request]', { name, durationMs: Math.round(durationMs), failed: false });
    return result;
  } catch (error) {
    const durationMs = performance.now() - startedAt;
    measurements.forEach((measurement) => {
      measurement.dataRequestDurationMs += durationMs;
      measurement.dataRequestFailures += 1;
    });
    console.debug('[Examifying][Perf][Request]', { name, durationMs: Math.round(durationMs), failed: true });
    throw error;
  }
};

export const trackFirestoreListener = (snapshot, durationMs, route = currentRoute()) => {
  recordRead({
    operation: 'onSnapshot initial result',
    durationMs,
    documentsReturned: snapshotDocumentCount(snapshot),
    source: snapshot?.metadata?.fromCache ? 'cache' : 'server',
    route,
  });
};

export const startScreenLoadMeasurement = ({ screen, role, route }) => {
  if (!isMeasurementEnabled()) return { finish: () => {}, cancel: () => {} };
  const id = ++measurementSequence;
  const measurement = {
    id,
    screen,
    role,
    route,
    startedAt: performance.now(),
    firestoreReadOperations: 0,
    firestoreDocumentsReturned: 0,
    firestoreReadDurationMs: 0,
    firestoreReadFailures: 0,
    dataRequests: 0,
    dataRequestDurationMs: 0,
    dataRequestFailures: 0,
    readEvents: [],
  };
  activeMeasurements.set(id, measurement);

  const finish = (completed) => {
    if (!activeMeasurements.has(id)) return;
    activeMeasurements.delete(id);
    console.info('[Examifying][Perf][Screen]', {
      screen,
      role,
      completed,
      durationMs: Math.round(performance.now() - measurement.startedAt),
      firestoreReadOperations: measurement.firestoreReadOperations,
      firestoreDocumentsReturned: measurement.firestoreDocumentsReturned,
      firestoreReadDurationMs: Math.round(measurement.firestoreReadDurationMs),
      firestoreReadFailures: measurement.firestoreReadFailures,
      dataRequests: measurement.dataRequests,
      dataRequestDurationMs: Math.round(measurement.dataRequestDurationMs),
      dataRequestFailures: measurement.dataRequestFailures,
      reads: measurement.readEvents,
    });
  };

  return { finish: () => finish(true), cancel: () => finish(false) };
};
