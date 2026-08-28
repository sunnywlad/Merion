import type { ReactNode } from 'react';

export type TableColumn<Row> = {
  key: string;
  header: ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Couleur sémantique du contenu de la cellule. La colonne de statut
   *  utilise `tone="success"` par défaut (planche 06). */
  tone?: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  render?: (row: Row) => ReactNode;
};

type TableProps<Row> = {
  caption?: string;
  columns: TableColumn<Row>[];
  rows: Row[];
  className?: string;
  emptyMessage?: ReactNode;
};

const TONE_TEXT: Record<NonNullable<TableColumn<unknown>['tone']>, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  info: 'text-info',
  neutral: 'text-neutral',
};

const ALIGN: Record<NonNullable<TableColumn<unknown>['align']>, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

/**
 * Merion table — planche 06 du brand book. En-tête sur fond Slate foncé,
 * lignes alternées sur Cloud à 5 % d'opacité, colonne de statut par défaut
 * en Success. Pas de tri, pas de pagination à ce stade.
 */
export function Table<Row extends Record<string, ReactNode>>({
  caption,
  columns,
  rows,
  className = '',
  emptyMessage = 'No data',
}: TableProps<Row>) {
  return (
    <div className={`overflow-x-auto ${className}`.trim()}>
      <table
        role="table"
        className="w-full border-collapse text-small text-cloud"
      >
        {caption ? (
          <caption className="sr-only">{caption}</caption>
        ) : null}
        <thead className="bg-slate">
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={`px-3 py-2 font-medium ${ALIGN[col.align ?? 'left']}`}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="px-3 py-4 text-center text-cloud/60"
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row, rowIdx) => (
              <tr
                key={rowIdx}
                className={rowIdx % 2 === 1 ? 'bg-cloud/5' : undefined}
              >
                {columns.map((col) => {
                  const content = col.render ? col.render(row) : (row as Record<string, ReactNode>)[col.key];
                  return (
                    <td
                      key={col.key}
                      className={`px-3 py-2 ${ALIGN[col.align ?? 'left']} ${col.tone ? TONE_TEXT[col.tone] : ''}`}
                    >
                      {content}
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export default Table;
