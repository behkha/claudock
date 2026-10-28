/**
 * How busy a day was on the 26-week heat map, shared by the share card and the first-run reveal so both grade the same
 * days the same way: 0 = no activity, 1-3 = by thirds of the days that had any. No imports, so `npm test` can load it.
 */
export function heatLevels(counts: number[]): (n: number) => 0 | 1 | 2 | 3 {
  const busy = counts.filter((n) => n > 0).sort((a, b) => a - b)
  if (busy.length === 0) return () => 0
  const at = (q: number): number => busy[Math.min(busy.length - 1, Math.floor(q * busy.length))]
  const [t1, t2] = [at(1 / 3), at(2 / 3)]
  return (n) => (n <= 0 ? 0 : n <= t1 ? 1 : n <= t2 ? 2 : 3)
}
