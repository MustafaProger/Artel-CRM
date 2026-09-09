export interface ColumnFilter {
  op: 'values' | 'contains' | 'equals' | 'range' | 'empty' | 'notEmpty';
  values?: string[]; value?: string; to?: string;
}
