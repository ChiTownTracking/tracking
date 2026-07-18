import { OpenLocationCode } from 'open-location-code';

// Pure, offline parsing of staff-pasted locations — no API calls, no quota.
// Accepts either a raw "lat, lng" pair (Google Maps' copy format) or a Plus
// Code (full or short), and returns null for anything else: this is user
// input, so an unrecognized format is an expected case, not an error.

const olc = new OpenLocationCode();

// Same Chicago focus point orsClient biases its geocoding toward. Short Plus
// Codes (e.g. "V9H6+52 Chicago, Illinois") technically need the locality
// text resolved to a reference location — but the app's real service area is
// already scoped to the Midwest (orsClient's bounding box), so a fixed
// regional reference is reasonable here, rather than adding a second
// geocoding round-trip just to resolve a locality name offline parsing was
// meant to avoid.
const REFERENCE_LAT = 41.8781;
const REFERENCE_LNG = -87.6298;

// "41.878988, -87.639732" — comma-separated, optional whitespace. Optional
// surrounding parens are stripped (matched pair only) before this runs.
const LAT_LNG_PATTERN = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/;

export function parseManualLocation(
  input: string,
): { lat: number; lng: number } | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let pairCandidate = trimmed;
  if (pairCandidate.startsWith('(') && pairCandidate.endsWith(')')) {
    pairCandidate = pairCandidate.slice(1, -1).trim();
  }
  const pairMatch = pairCandidate.match(LAT_LNG_PATTERN);
  if (pairMatch) {
    const lat = Number(pairMatch[1]);
    const lng = Number(pairMatch[2]);
    // Same sanity bounds as createLinkInput's waypoint schema. An
    // out-of-range pair is still unmistakably a coordinate attempt — reject
    // it rather than falling through to Plus Code parsing.
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      return { lat, lng };
    }
    return null;
  }

  // Plus Codes: the code itself is the first token — anything after it
  // (e.g. a trailing "Chicago, Illinois" locality) is dropped.
  const codeCandidate = trimmed.split(/[\s,]+/)[0];
  if (olc.isValid(codeCandidate)) {
    if (olc.isFull(codeCandidate)) {
      const area = olc.decode(codeCandidate);
      return { lat: area.latitudeCenter, lng: area.longitudeCenter };
    }
    if (olc.isShort(codeCandidate)) {
      const fullCode = olc.recoverNearest(
        codeCandidate,
        REFERENCE_LAT,
        REFERENCE_LNG,
      );
      const area = olc.decode(fullCode);
      return { lat: area.latitudeCenter, lng: area.longitudeCenter };
    }
  }

  return null;
}
