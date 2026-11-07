/** JSON object key order is not semantic; arrays and scalar types remain exact wire values. */
export function sameParameterValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameParameterValue(value, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const entries = Object.entries(left);
  const other = Object.entries(right);
  return entries.length === other.length && entries.every(([key, value]) => {
    const entry = other.find(([name]) => name === key);
    return entry !== undefined && sameParameterValue(value, entry[1]);
  });
}
