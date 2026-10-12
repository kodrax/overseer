/** Plain-text output helpers for the CLI (no dependencies). */

export type Cell = string | number | boolean | null | undefined;

export function cellText(value: Cell): string {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value).replace(/\s*\n\s*/g, ' ');
}

/** Aligned table: header, dash rule, rows; columns separated by two spaces, last column unpadded. */
export function table(headers: readonly string[], rows: readonly (readonly Cell[])[]): string {
  const text = rows.map((row) => headers.map((_, index) => cellText(row[index])));
  const widths = headers.map((header, index) => Math.max(header.length, ...text.map((row) => row[index]!.length)));
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index]!)))
      .join('  ')
      .trimEnd();
  return [line(headers), line(widths.map((width) => '-'.repeat(width))), ...text.map(line)].join('\n');
}

/** `key: value` lines with keys padded to the longest one; empty values are skipped. */
export function fields(entries: readonly (readonly [string, Cell])[]): string {
  const shown = entries.filter(([, value]) => value !== null && value !== undefined && value !== '');
  const width = Math.max(0, ...shown.map(([key]) => key.length + 1));
  return shown.map(([key, value]) => `${`${key}:`.padEnd(width)}  ${cellText(value)}`).join('\n');
}

export function similarity(value: number | null | undefined): string {
  return value === null || value === undefined ? '-' : value.toFixed(2);
}

export function list(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : '-';
}
