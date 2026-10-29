/**
 * D1-совместимый адаптер поверх встроенного модуля node:sqlite (DatabaseSync).
 * Позволяет запускать код Cloudflare Worker (worker/index.js) локально, на VDS/Cloud Run
 * и в автоматических тестах без единой сторонней npm-библиотеки, сохраняя 100% семантику
 * атомарных транзакций env.DB.batch([...]) и SQL-ограничений Cloudflare D1.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

class D1PreparedStatement {
  constructor(sqliteDb, sql, boundValues = []) {
    this._db = sqliteDb;
    this._sql = sql;
    this._params = boundValues;
  }

  bind(...values) {
    return new D1PreparedStatement(this._db, this._sql, values);
  }

  _executeRaw() {
    const stmt = this._db.prepare(this._sql);
    const trimmed = this._sql.trim().toUpperCase();
    const isReader =
      trimmed.startsWith('SELECT') ||
      trimmed.startsWith('PRAGMA') ||
      trimmed.includes('RETURNING');

    if (isReader) {
      const rows = stmt.all(...this._params);
      return { results: rows, success: true, meta: {} };
    } else {
      const info = stmt.run(...this._params);
      return {
        results: [],
        success: true,
        meta: {
          changes: info.changes,
          last_row_id: info.lastInsertRowid,
        },
      };
    }
  }

  async first(colName) {
    const stmt = this._db.prepare(this._sql);
    const row = stmt.get(...this._params) || null;
    if (!row) return null;
    if (colName !== undefined) {
      return row[colName] ?? null;
    }
    return row;
  }

  async all() {
    return this._executeRaw();
  }

  async run() {
    return this._executeRaw();
  }
}

export class LocalD1Database {
  constructor(dbFilePath = ':memory:') {
    if (dbFilePath !== ':memory:') {
      const dir = path.dirname(dbFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.sqlite = new DatabaseSync(dbFilePath);
    this.sqlite.exec('PRAGMA foreign_keys = ON;');
    if (dbFilePath !== ':memory:') {
      this.sqlite.exec('PRAGMA journal_mode = WAL;');
    }
    this.sqlite.exec('PRAGMA busy_timeout = 5000;');
  }

  prepare(sql) {
    return new D1PreparedStatement(this.sqlite, sql);
  }

  /**
   * В Cloudflare D1 метод db.batch([...]) выполняет массив подготовленных запросов
   * внутри единой транзакции. Если хотя бы один запрос завершается ошибкой (например,
   * нарушение PRIMARY KEY слота или триггер пересечения интервалов), вся транзакция
   * атомарно откатывается (ROLLBACK).
   */
  async batch(statements) {
    if (!Array.isArray(statements) || statements.length === 0) {
      return [];
    }
    this.sqlite.exec('BEGIN IMMEDIATE TRANSACTION;');
    try {
      const outputs = [];
      for (const stmt of statements) {
        outputs.push(stmt._executeRaw());
      }
      this.sqlite.exec('COMMIT;');
      return outputs;
    } catch (err) {
      try {
        this.sqlite.exec('ROLLBACK;');
      } catch {
        // Игнорируем ошибку отката, если транзакция уже откатилась движком SQLite
      }
      throw err;
    }
  }

  async exec(sqlText) {
    this.sqlite.exec(sqlText);
    return { count: 1 };
  }

  close() {
    this.sqlite.close();
  }
}

export function createInitializedD1Database({
  dbPath = ':memory:',
  migrationsDir = path.resolve(process.cwd(), 'migrations'),
} = {}) {
  const db = new LocalD1Database(dbPath);
  if (fs.existsSync(migrationsDir)) {
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const fullPath = path.join(migrationsDir, file);
      const sqlContent = fs.readFileSync(fullPath, 'utf8');
      db.sqlite.exec(sqlContent);
    }
  }
  return db;
}
