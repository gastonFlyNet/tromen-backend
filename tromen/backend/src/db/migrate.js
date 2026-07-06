import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import postgres from 'postgres'
import 'dotenv/config'

const __dirname = dirname(fileURLToPath(import.meta.url))

const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} })

async function migrate() {
  console.log('🚀 Ejecutando migraciones TROMEN...')
  try {
    const schema = readFileSync(
      join(__dirname, '../../migrations/001_schema.sql'),
      'utf8'
    )
    await sql.unsafe(schema)
    console.log('✅ Schema creado correctamente')

    const seed = readFileSync(
      join(__dirname, '../../seeds/001_seed.sql'),
      'utf8'
    )
    await sql.unsafe(seed)
    console.log('✅ Datos de prueba insertados')

    console.log('\n🎉 Base de datos lista. Podés arrancar el servidor con: npm run dev')
  } catch (err) {
    console.error('❌ Error en migración:', err.message)
    process.exit(1)
  } finally {
    await sql.end()
  }
}

migrate()
