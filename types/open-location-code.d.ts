// open-location-code ships no TypeScript types — minimal declarations for
// the subset lib/manualLocationInput.ts uses, matching the real runtime API
// (verified by probing the installed package).
declare module 'open-location-code' {
  export interface CodeArea {
    latitudeLo: number;
    longitudeLo: number;
    latitudeHi: number;
    longitudeHi: number;
    codeLength: number;
    latitudeCenter: number;
    longitudeCenter: number;
  }

  export class OpenLocationCode {
    isValid(code: string): boolean;
    isShort(code: string): boolean;
    isFull(code: string): boolean;
    decode(code: string): CodeArea;
    recoverNearest(
      code: string,
      referenceLatitude: number,
      referenceLongitude: number,
    ): string;
    encode(latitude: number, longitude: number, codeLength?: number): string;
    shorten(code: string, latitude: number, longitude: number): string;
  }
}
