import type { ReactNode } from 'react'
import { Download } from 'lucide-react'

import { Card } from '@/components/ui/card'
import { DataTable, type Column } from '@/components/DataTable'
import { cn } from '@/lib/utils'
import { downloadCsv, toCsv, type CsvValue } from './lib/csv'
import { ApiError } from './lib/api'

export function Panel({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <Card className="px-5 py-4">
      <div className="mb-3.5 flex items-center justify-between gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-heading">{title}</h2>
        {actions}
      </div>
      {children}
    </Card>
  )
}

export function Button({ className, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs text-foreground hover:bg-interactive-secondary disabled:opacity-50',
        className,
      )}
      {...p}
    />
  )
}

export const selectCls =
  'rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground outline-none focus:ring-1 focus:ring-primary'

export function CsvButton({ filename, headers, rows }: { filename: string; headers: string[]; rows: CsvValue[][] }) {
  return (
    <Button disabled={!rows.length} onClick={() => downloadCsv(filename, toCsv(headers, rows))} title="Export as CSV">
      <Download size={12} /> CSV
    </Button>
  )
}

/** A table panel with a CSV button. `csv` rows are raw values, `rows` are the displayed cells. */
export function TablePanel({
  title,
  filename,
  columns,
  rows,
  csv,
}: {
  title: string
  filename: string
  columns: Column[]
  rows: Array<Record<string, ReactNode>>
  csv: CsvValue[][]
}) {
  return (
    <Panel title={title} actions={<CsvButton filename={filename} headers={columns.map((c) => c.label)} rows={csv} />}>
      <div className="overflow-x-auto">
        <DataTable columns={columns} rows={rows} />
      </div>
    </Panel>
  )
}

export function Loading() {
  return <div className="py-12 text-center text-sm text-tertiary-foreground">Loading...</div>
}

export function ErrorNote({ error }: { error: unknown }) {
  const e = error as ApiError
  const msg = e instanceof ApiError && e.code ? `${e.code} (${e.status})` : String((error as Error)?.message ?? error)
  return <div className="py-8 text-center text-sm text-red-500">Could not load data: {msg}</div>
}

export function Empty({ children = 'No usage recorded for this period.' }: { children?: ReactNode }) {
  return <div className="py-12 text-center text-sm text-tertiary-foreground">{children}</div>
}
