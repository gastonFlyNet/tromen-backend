import sql from '../db/connection.js'
import { requireRole } from '../middleware/auth.js'

export default async function productRoutes(app) {

  // GET /api/products — lista de productos activos
  app.get('/', {
    preHandler: [app.authenticate]
  }, async () => {
    return sql`
      SELECT * FROM products
      WHERE active = true
      ORDER BY sort_order ASC, name ASC
    `
  })

  // GET /api/products/all — todos (admin)
  app.get('/all', {
    preHandler: [requireRole('admin', 'supervisor')]
  }, async () => {
    return sql`SELECT * FROM products ORDER BY sort_order ASC, name ASC`
  })

  // POST /api/products — crear producto
  app.post('/', {
    preHandler: [requireRole('admin', 'supervisor')]
  }, async (request, reply) => {
    const { name, unit, price, has_empty_return, sort_order } = request.body
    if (!name) return reply.status(400).send({ error: 'El nombre es obligatorio' })

    const [product] = await sql`
      INSERT INTO products (name, unit, price, has_empty_return, sort_order)
      VALUES (
        ${name}, ${unit ?? 'unidad'}, ${price ?? 0},
        ${has_empty_return ?? false}, ${sort_order ?? 99}
      )
      RETURNING *
    `
    return reply.status(201).send(product)
  })

  // PATCH /api/products/:id — actualizar precio/datos
  app.patch('/:id', {
    preHandler: [requireRole('admin', 'supervisor')]
  }, async (request, reply) => {
    const { id } = request.params
    const { name, unit, price, active, has_empty_return, sort_order } = request.body

    const updates = {}
    if (name !== undefined)             updates.name = name
    if (unit !== undefined)             updates.unit = unit
    if (price !== undefined)            updates.price = price
    if (active !== undefined)           updates.active = active
    if (has_empty_return !== undefined) updates.has_empty_return = has_empty_return
    if (sort_order !== undefined)       updates.sort_order = sort_order
    updates.updated_at = new Date()

    const [product] = await sql`
      UPDATE products SET ${sql(updates)} WHERE id = ${id} RETURNING *
    `
    if (!product) return reply.status(404).send({ error: 'Producto no encontrado' })
    return product
  })

  // DELETE /api/products/:id — desactivar producto
  app.delete('/:id', {
    preHandler: [requireRole('admin', 'supervisor')]
  }, async (request, reply) => {
    const { id } = request.params
    await sql`UPDATE products SET active = false WHERE id = ${id}`
    return { success: true }
  })
  // GET /api/stock — stock actual de todos los productos
  app.get('/stock', {
    preHandler: [requireRole('admin', 'supervisor')]
  }, async () => {
    return sql`
      SELECT p.id, p.name, p.unit, p.price, p.active,
             COALESCE(p.stock_quantity, 0) AS stock_quantity,
             COALESCE(SUM(CASE WHEN m.type = 'entrada' THEN m.quantity ELSE 0 END), 0) AS total_entradas,
             COALESCE(SUM(CASE WHEN m.type = 'salida'  THEN m.quantity ELSE 0 END), 0) AS total_salidas
      FROM products p
      LEFT JOIN stock_movements m ON m.product_id = p.id
      WHERE p.active = true
      GROUP BY p.id, p.name, p.unit, p.price, p.active, p.stock_quantity
      ORDER BY p.sort_order ASC, p.name ASC
    `
  })

  // POST /api/stock/movement — registrar entrada o salida
  app.post('/stock/movement', {
    preHandler: [requireRole('admin', 'supervisor')],
    schema: {
      body: {
        type: 'object',
        required: ['product_id', 'type', 'quantity'],
        properties: {
          product_id: { type: 'string', format: 'uuid' },
          type:       { type: 'string', enum: ['entrada', 'salida'] },
          quantity:   { type: 'integer', minimum: 1 },
          reason:     { type: 'string' },
          notes:      { type: 'string' },
          destino:        { type: 'string', enum: ['repartidor', 'deposito'] },
          repartidor_id:  { type: 'string', format: 'uuid' },
        }
      }
    }
  }, async (request, reply) => {
    const { product_id, type, quantity, reason, notes, destino, repartidor_id } = request.body

    // Verificar stock suficiente si es salida
    if (type === 'salida') {
      const [product] = await sql`SELECT stock_quantity FROM products WHERE id = ${product_id}`
      if (!product) return reply.status(404).send({ error: 'Producto no encontrado' })
      if ((product.stock_quantity ?? 0) < quantity) {
        return reply.status(400).send({ error: `Stock insuficiente. Disponible: ${product.stock_quantity ?? 0}` })
      }
    }

    // Registrar movimiento
    const [movement] = await sql`
      INSERT INTO stock_movements (product_id, user_id, type, quantity, reason, notes, destino, repartidor_id)
      VALUES (${product_id}, ${request.user.id}, ${type}, ${quantity}, ${reason ?? null}, ${notes ?? null}, ${type === 'salida' ? (destino ?? null) : null}, ${type === 'salida' ? (repartidor_id ?? null) : null})
      RETURNING *
    `

    // Actualizar stock_quantity en products
    if (type === 'entrada') {
      await sql`UPDATE products SET stock_quantity = COALESCE(stock_quantity, 0) + ${quantity} WHERE id = ${product_id}`
    } else {
      await sql`UPDATE products SET stock_quantity = COALESCE(stock_quantity, 0) - ${quantity} WHERE id = ${product_id}`
    }

    return reply.status(201).send(movement)
  })

  // GET /api/stock/history — historial de movimientos
  app.get('/stock/history', {
    preHandler: [requireRole('admin', 'supervisor')]
  }, async (request) => {
    const { product_id, limit = 50 } = request.query

    return sql`
      SELECT m.id, m.type, m.quantity, m.reason, m.notes, m.created_at,
             p.name AS product_name, p.unit,
             u.name AS user_name,
             m.destino,
             r.name AS repartidor_name
      FROM stock_movements m
      JOIN products p ON p.id = m.product_id
      JOIN users u ON u.id = m.user_id
      LEFT JOIN users r ON r.id = m.repartidor_id
      ${product_id ? sql`WHERE m.product_id = ${product_id}` : sql``}
      ORDER BY m.created_at DESC
      LIMIT ${parseInt(limit)}
    `
  })
}
