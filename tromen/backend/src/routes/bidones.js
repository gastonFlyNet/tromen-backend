import sql from '../db/connection.js'
import { requireRole } from '../middleware/auth.js'

export default async function bidonesRoutes(app) {

  // POST /api/bidones-mal-estado - registrar un cambio de bidon en mal estado.
  // Sale un bidon bueno del stock, se registra el roto (con foto) en tabla aparte.
  // Idempotente: si viene client_uuid y ya se proceso, devuelve OK sin duplicar.
  // Los 3 pasos van en una transaccion (o se aplican todos, o ninguno).
  app.post('/', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['product_id', 'cantidad'],
        properties: {
          product_id:  { type: 'string' },
          delivery_id: { type: 'string' },
          client_id:   { type: 'string' },
          cantidad:    { type: 'integer', minimum: 1 },
          foto_url:    { type: 'string' },
          notes:       { type: 'string' },
          client_uuid: { type: 'string' },
        }
      }
    }
  }, async (request, reply) => {
    const { product_id, delivery_id, client_id, cantidad, foto_url, notes, client_uuid = null } = request.body

    const resultado = await sql.begin(async (sql) => {
      // 1. Registrar el cambio (el bidon roto que entra). PORTERO DE IDEMPOTENCIA.
      //    Si viene client_uuid y ya existia, ON CONFLICT no devuelve fila => reintento.
      let registro = null

      if (client_uuid) {
        const filas = await sql`
          INSERT INTO bidones_mal_estado
            (product_id, delivery_id, client_id, repartidor_id, cantidad, foto_url, notes, client_uuid)
          VALUES
            (${product_id}, ${delivery_id ?? null}, ${client_id ?? null},
             ${request.user.id}, ${cantidad}, ${foto_url ?? null}, ${notes ?? null}, ${client_uuid})
          ON CONFLICT (client_uuid) DO NOTHING
          RETURNING *
        `
        if (filas.length === 0) {
          // Ya estaba registrado: no descontamos stock de nuevo. Idempotente.
          return { duplicado: true }
        }
        registro = filas[0]
      } else {
        // Sin client_uuid (registro online clasico): insertar normal.
        const filas = await sql`
          INSERT INTO bidones_mal_estado
            (product_id, delivery_id, client_id, repartidor_id, cantidad, foto_url, notes)
          VALUES
            (${product_id}, ${delivery_id ?? null}, ${client_id ?? null},
             ${request.user.id}, ${cantidad}, ${foto_url ?? null}, ${notes ?? null})
          RETURNING *
        `
        registro = filas[0]
      }

      // 2. Descontar el bidon bueno del stock
      await sql`
        UPDATE products SET stock_quantity = stock_quantity - ${cantidad}
        WHERE id = ${product_id}
      `

      // 3. Registrar el movimiento de stock (salida del bidon bueno)
      await sql`
        INSERT INTO stock_movements (product_id, user_id, type, quantity, reason, notes, repartidor_id)
        VALUES (${product_id}, ${request.user.id}, 'salida', ${cantidad},
                'cambio_bidon_mal_estado', ${notes ?? 'Cambio por bidon en mal estado'}, ${request.user.id})
      `

      return { ok: true, registro }
    })

    if (resultado.duplicado) {
      return reply.status(200).send({ ok: true, duplicado: true })
    }

    return reply.status(201).send({ ok: true, registro: resultado.registro })
  })

  // GET /api/bidones-mal-estado - listado de bidones rotos (dashboard)
  app.get('/', {
    preHandler: [requireRole('admin', 'supervisor')]
  }, async (request) => {
    const { from, to } = request.query
    const dateFrom = from ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
    const dateTo   = to   ?? new Date().toISOString().slice(0, 10)
    const registros = await sql`
      SELECT b.id, b.cantidad, b.foto_url, b.notes, b.created_at,
             p.name AS producto,
             c.name AS cliente,
             u.name AS repartidor
      FROM bidones_mal_estado b
      LEFT JOIN products p ON p.id = b.product_id
      LEFT JOIN clients c  ON c.id = b.client_id
      LEFT JOIN users u    ON u.id = b.repartidor_id
      WHERE b.created_at >= ${dateFrom}::date
        AND b.created_at < ${dateTo}::date + INTERVAL '1 day'
      ORDER BY b.created_at DESC
    `
    // Conteo por marca de bidon
    const porMarca = await sql`
      SELECT p.name AS producto, COALESCE(SUM(b.cantidad), 0) AS total
      FROM bidones_mal_estado b
      LEFT JOIN products p ON p.id = b.product_id
      WHERE b.created_at >= ${dateFrom}::date
        AND b.created_at < ${dateTo}::date + INTERVAL '1 day'
      GROUP BY p.name
      ORDER BY total DESC
    `
    return { from: dateFrom, to: dateTo, registros, por_marca: porMarca }
  })
}

