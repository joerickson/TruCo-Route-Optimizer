import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatHours(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—';
  return `${n.toFixed(1)} hr`;
}

export function formatMiles(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—';
  return `${n.toFixed(0)} mi`;
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export function dayName(dow: number | null | undefined): string {
  if (dow == null) return '—';
  return DAY_NAMES[dow % 7] ?? '—';
}
