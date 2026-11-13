import { useEffect, useState } from 'react';

import { AMBIENT_REFRESH_MS } from '../constants.js';
import { ambientEnabled, ambientTint, useAmbientVersion } from '../office/ambient.js';

/** Faint day/night tint over the office (decoration only, below all UI). */
export function AmbientTint() {
  useAmbientVersion();
  const [hour, setHour] = useState(() => new Date().getHours());
  useEffect(() => {
    const timer = setInterval(() => setHour(new Date().getHours()), AMBIENT_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  const tint = ambientEnabled() ? ambientTint(hour) : null;
  if (!tint) return null;
  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 pointer-events-none transition-colors duration-1000"
      style={{ background: tint }}
      data-testid="ambient-tint"
    />
  );
}
