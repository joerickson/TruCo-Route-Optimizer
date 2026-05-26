'use client';
import { useEffect, useRef, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { ServiceType } from '@/lib/types';
import type { ContractFilter } from '@/lib/property-filters';

export const SERVICE_COLORS: Record<ServiceType, string> = {
  weekly: '#10b981', // emerald-500
  biweekly: '#f59e0b', // amber-500
  monthly: '#3b82f6', // blue-500
};

export const SERVICE_LABELS: Record<ServiceType, string> = {
  weekly: 'Weekly MT',
  biweekly: 'Bi-Weekly',
  monthly: 'Monthly MT',
};

export interface MapFiltersProps {
  services: Record<ServiceType, boolean>;
  onServiceChange: (st: ServiceType, v: boolean) => void;
  cityOptions: Array<{ city: string; count: number }>;
  selectedCities: string[] | null;
  onCitiesChange: (cities: string[] | null) => void;
  contract: ContractFilter;
  onContractChange: (c: ContractFilter) => void;
}

const CONTRACT_OPTIONS: Array<{ value: ContractFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

export function MapFilters({
  services,
  onServiceChange,
  cityOptions,
  selectedCities,
  onCitiesChange,
  contract,
  onContractChange,
}: MapFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <CityMultiSelect options={cityOptions} selected={selectedCities} onChange={onCitiesChange} />

      <div className="inline-flex rounded-md border p-0.5 text-sm">
        {CONTRACT_OPTIONS.map((o) => (
          <button
            key={o.value}
            onClick={() => onContractChange(o.value)}
            className={cn(
              'rounded px-2.5 py-1 transition-colors',
              contract === o.value
                ? 'bg-secondary font-medium text-secondary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {o.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {(['weekly', 'biweekly', 'monthly'] as ServiceType[]).map((st) => {
          const id = `svc-${st}`;
          return (
            <div key={st} className="flex items-center gap-2">
              <Switch id={id} checked={services[st]} onCheckedChange={(v) => onServiceChange(st, v)} />
              <Label htmlFor={id} className="flex cursor-pointer items-center gap-1.5">
                <span className="inline-block h-3 w-3 rounded-full" style={{ background: SERVICE_COLORS[st] }} />
                {SERVICE_LABELS[st]}
              </Label>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CityMultiSelect({
  options,
  selected,
  onChange,
}: {
  options: Array<{ city: string; count: number }>;
  selected: string[] | null;
  onChange: (cities: string[] | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const allCities = options.map((o) => o.city);
  const isAll = selected === null;
  const isChecked = (city: string) => isAll || selected.includes(city);
  const label = isAll ? 'All cities' : `${selected.length} ${selected.length === 1 ? 'city' : 'cities'}`;

  const toggleCity = (city: string) => {
    const current = isAll ? allCities : selected;
    const next = current.includes(city) ? current.filter((c) => c !== city) : [...current, city];
    onChange(next.length === allCities.length ? null : next);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
      >
        City: <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">&#9662;</span>
      </button>
      {open && (
        <div className="absolute z-50 mt-1 max-h-72 w-60 overflow-auto rounded-md border bg-background p-2 shadow-md">
          <div className="mb-2 flex gap-2 border-b pb-2">
            <button onClick={() => onChange(null)} className="rounded border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground">
              All
            </button>
            <button onClick={() => onChange([])} className="rounded border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground">
              None
            </button>
          </div>
          {options.length === 0 && <div className="px-1 py-2 text-xs text-muted-foreground">No cities</div>}
          {options.map((o) => (
            <label key={o.city} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-accent">
              <input
                type="checkbox"
                checked={isChecked(o.city)}
                onChange={() => toggleCity(o.city)}
                className="h-3.5 w-3.5"
              />
              <span className="flex-1">{o.city}</span>
              <span className="text-xs text-muted-foreground">{o.count}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
