// Money (SPEC §4): the internal unit is the penny. 12 pence = 1 shilling, 20 shillings = 1 pound.
export const PENCE_PER_SHILLING = 12;
export const PENCE_PER_POUND = 240;

/** "£2 3s 4d", "3s 4d", "7d", "½d" for fractions; negative amounts get a minus sign. */
export function formatMoney(pence: number): string {
  const neg = pence < 0;
  let p = Math.abs(pence);
  const half = p % 1 >= 0.5 ? '½' : '';
  p = Math.floor(p);
  const pounds = Math.floor(p / PENCE_PER_POUND);
  const shillings = Math.floor((p % PENCE_PER_POUND) / PENCE_PER_SHILLING);
  const d = p % PENCE_PER_SHILLING;
  const parts: string[] = [];
  if (pounds) parts.push(`£${pounds}`);
  if (shillings) parts.push(`${shillings}s`);
  if (d || half || parts.length === 0) parts.push(`${d || (half ? '' : '0')}${half}d`);
  return (neg ? '−' : '') + parts.join(' ');
}
