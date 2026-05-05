'use client';
import { useMemo, useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';

export interface SkippedRowDTO {
  row_number: number;
  property_name: string | null;
  city: string | null;
  reason: string;
  raw_data: Record<string, unknown>;
}

type SortKey = 'row_number' | 'property_name' | 'city' | 'reason';
type SortDir = 'asc' | 'desc';

export function SkippedRowsTable({ rows }: { rows: SkippedRowDTO[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('row_number');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return av - bv;
      return String(av).localeCompare(String(bv));
    });
    if (sortDir === 'desc') copy.reverse();
    return copy;
  }, [rows, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  function toggleExpand(rowNumber: number) {
    const next = new Set(expanded);
    if (next.has(rowNumber)) next.delete(rowNumber);
    else next.add(rowNumber);
    setExpanded(next);
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortHeader label="Row" k="row_number" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} className="w-20" />
          <SortHeader label="Property" k="property_name" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
          <SortHeader label="City" k="city" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} className="w-32" />
          <SortHeader label="Reason" k="reason" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
          <TableHead className="w-24"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((r) => (
          <Row key={r.row_number} row={r} expanded={expanded.has(r.row_number)} onToggle={() => toggleExpand(r.row_number)} />
        ))}
      </TableBody>
    </Table>
  );
}

function Row({ row, expanded, onToggle }: { row: SkippedRowDTO; expanded: boolean; onToggle: () => void }) {
  return (
    <>
      <TableRow>
        <TableCell className="font-mono text-xs">{row.row_number}</TableCell>
        <TableCell className="font-medium">{row.property_name ?? <span className="text-muted-foreground italic">—</span>}</TableCell>
        <TableCell>{row.city ?? <span className="text-muted-foreground italic">—</span>}</TableCell>
        <TableCell className="text-amber-700">{row.reason}</TableCell>
        <TableCell className="text-right">
          <button
            type="button"
            onClick={onToggle}
            className="text-xs text-primary hover:underline"
          >
            {expanded ? 'Hide raw' : 'Show raw'}
          </button>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell colSpan={5} className="bg-muted/30">
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-background p-3 text-xs">
              {JSON.stringify(row.raw_data, null, 2)}
            </pre>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function SortHeader({
  label,
  k,
  sortKey,
  sortDir,
  onClick,
  className,
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onClick: (k: SortKey) => void;
  className?: string;
}) {
  const active = sortKey === k;
  return (
    <TableHead className={className}>
      <button type="button" onClick={() => onClick(k)} className="inline-flex items-center gap-1 hover:text-foreground">
        {label}
        {active ? (
          sortDir === 'asc' ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )
        ) : (
          <ChevronsUpDown className="h-3 w-3 opacity-40" />
        )}
      </button>
    </TableHead>
  );
}
