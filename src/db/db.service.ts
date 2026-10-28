import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow, types } from 'pg';
import { config } from '../config';

// Las fechas (date) se manejan como texto 'AAAA-MM-DD' y los numeric como texto exacto.
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1700, (v) => v);

export type Ejecutor = Pick<PoolClient, 'query'>;

@Injectable()
export class Db implements OnModuleDestroy {
  readonly pool: Pool;

  constructor() {
    const c = config();
    this.pool = new Pool({
      connectionString: c.databaseUrl,
      ssl: c.databaseSsl ? { rejectUnauthorized: false } : undefined,
      max: Number(process.env.DB_POOL ?? 10),
    });
  }

  async many<T extends QueryResultRow = any>(sql: string, params: unknown[] = [], ex: Ejecutor = this.pool): Promise<T[]> {
    return (await ex.query<T>(sql, params as any[])).rows;
  }

  async one<T extends QueryResultRow = any>(sql: string, params: unknown[] = [], ex: Ejecutor = this.pool): Promise<T> {
    const r = await ex.query<T>(sql, params as any[]);
    if (!r.rows[0]) throw new Error('Se esperaba un resultado');
    return r.rows[0];
  }

  async maybe<T extends QueryResultRow = any>(sql: string, params: unknown[] = [], ex: Ejecutor = this.pool): Promise<T | null> {
    return (await ex.query<T>(sql, params as any[])).rows[0] ?? null;
  }

  async exec(sql: string, params: unknown[] = [], ex: Ejecutor = this.pool): Promise<number> {
    return (await ex.query(sql, params as any[])).rowCount ?? 0;
  }

  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      const r = await fn(c);
      await c.query('commit');
      return r;
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
