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
}
