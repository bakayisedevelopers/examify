import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { startScreenLoadMeasurement } from '../services/performanceTelemetry';

export const useScreenLoadMetrics = (screen, role, ready, measurementKey = '') => {
  const location = useLocation();
  const measurementRef = useRef(null);

  useEffect(() => {
    const measurement = startScreenLoadMeasurement({ screen, role, route: location.pathname });
    measurementRef.current = measurement;
    return () => {
      measurement.cancel();
      if (measurementRef.current === measurement) measurementRef.current = null;
    };
  }, [location.pathname, measurementKey, role, screen]);

  useEffect(() => {
    if (!ready) return;
    measurementRef.current?.finish();
    measurementRef.current = null;
  }, [ready]);
};
