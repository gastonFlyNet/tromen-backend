import sql from '../db/connection.js'
import { requireRole } from '../middleware/auth.js'

export default async function bidonesRoutes(app) {

  // POST /api/bidones-mal-estado — registrar un cambio de bidón en mal estado
  // Sale un bidón bueno del stock, se registra el roto (con foto) en la tabla aparte.
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
        }
      }
    }
  }, async (request, reply) => {
    const { product_id, delivery_id, client_id, cantidad, foto_url, notes } = request.body

    // 1. Registrar el cambio (el bidón roto que entra)
    const [registro] = await sql`
      INSERT INTO bidones_mal_estado
        (product_id, delivery_id, client_id, repartidor_id, cantidad, foto_url, notes)
      VALUES
        (${product_id}, ${delivery_id ?? null}, ${client_id ?? null},
         ${request.user.id}, ${cantidad}, ${foto_url ?? null}, ${notes ?? null})
      RETURNING *
    `

    // 2. Descontar el bidón bueno del stock
    await sql`
      UPDATE products SET stock_quantity = stock_quantity - ${cantidad}
      WHERE id = ${product_id}
    `

    // 3. Registrar el movimiento de stock (salida del bidón bueno)
    await sql`
      INSERT INTO stock_movements (product_id, user_id, type, quantity, reason, notes, repartidor_id)
      VALUES (${product_id}, ${request.user.id}, 'salida', ${cantidad},
              'cambio_bidon_mal_estado', ${notes ?? 'Cambio por bidón en mal estado'}, ${request.user.id})
    `

    return reply.status(201).send({ ok: true, registro })
  })

  // GET /api/bidones-mal-estado — listado de bidones rotos (dashboard)
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

    // Conteo por marca de bidón
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
