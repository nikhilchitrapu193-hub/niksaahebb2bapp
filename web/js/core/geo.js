// =============================================================================
// geo.js — one wrapper around the browser's geolocation API, with messages a
// person can act on. Used by the sign-up form and Account → "Use my location"
// (migration 018: restaurants.lat / lng, the driver's map pin).
// =============================================================================

/** Resolve to { lat, lng } rounded to 6 places (≈10 cm), or throw a readable Error. */
export function currentPosition({ timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const geo = window.navigator?.geolocation;
    if (!geo) { reject(new Error('This browser cannot share your location. Type the address instead.')); return; }
    geo.getCurrentPosition(
      (pos) => resolve({ lat: Number(pos.coords.latitude.toFixed(6)), lng: Number(pos.coords.longitude.toFixed(6)) }),
      (err) => reject(new Error(err.code === 1
        ? 'Location permission was refused. Allow it for this site and try again.'
        : err.code === 3 ? 'Could not get a fix in time. Step outside or try again.' : 'Could not read your location right now.')),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}
