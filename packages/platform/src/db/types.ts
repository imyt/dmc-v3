export interface QueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number | null;
}
export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<R>>;
}
