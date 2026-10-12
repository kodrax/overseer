import { InvalidArgumentError } from 'commander';
import { OverseerError } from '../core/errors.js';

/** Commander collector for repeatable options; undefined until the option is given. */
export function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

/** Like `collect`, also splitting comma lists (`--status a,b --status c`). */
export function collectList(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), ...value.split(',').map((part) => part.trim()).filter(Boolean)];
}

export function parseInteger(value: string): number {
  if (!/^\d+$/.test(value)) throw new InvalidArgumentError('Expected a non-negative integer.');
  return Number(value);
}

export function parseNumber(value: string): number {
  const number = Number(value);
  if (value.trim() === '' || !Number.isFinite(number)) throw new InvalidArgumentError('Expected a number.');
  return number;
}

/** Narrows `value` to one of `values`; INVALID_INPUT listing the valid ones otherwise. */
export function oneOf<T extends string>(values: readonly T[], value: string, label: string): T {
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) throw new OverseerError('INVALID_INPUT', `Invalid ${label} "${value}"; valid: ${values.join(', ')}.`);
  return found;
}
