/** 35 mm-equivalent focal length for a vertical FOV (24 mm sensor height). */
export function focalLengthFromFov(fovDeg: number): number {
  return 12 / Math.tan((Math.max(1, Math.min(179, fovDeg)) * Math.PI) / 360);
}
