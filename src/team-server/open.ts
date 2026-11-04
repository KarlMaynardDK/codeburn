import { migrate, Store, type Db } from './store.js'

/** Opens (and migrates) the configured backend: PostgreSQL when a URL is given, else SQLite in the data dir. */
export async function openStore(dataDir: string, databaseUrl?: string): Promise<Store> {
  let db: Db
  if (databaseUrl) {
    if (!/^postgres(ql)?:\/\//.test(databaseUrl)) throw new Error('--database-url must be a postgres:// or postgresql:// URL')
    const { openPostgres } = await import('./store-postgres.js')
    db = await openPostgres(databaseUrl)
  } else {
    const { openSqlite } = await import('./store-sqlite.js')
    db = openSqlite(dataDir)
  }
  await migrate(db)
  return new Store(db)
}
