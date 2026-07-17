import sql from '../db/connection.js'
import { requireRole } from '../middleware/auth.js'

export default async function clientRoutes(app) {

  // GET /api/clients
  app.get('/', {
    preHandler: [app.authenticate]
  }, async (request) => {
    const { zone, search, active = 'true' } = request.query
    return sql`
      SELECT id, name, trade_name, address, city, zone, phone,
             tax_id, credit_limit, balance, latitude, longitude, active, remito
      FROM clients
      WHERE active = ${active === 'true'}
      ${zone   ? sql`AND zone = ${zone}`                        : sql``}
      ${search ? sql`AND (name ILIKE ${'%'+search+'%'} OR trade_name ILIKE ${'%'+search+'%'})` : sql``}
      ORDER BY name ASC
    `
  })

  // GET /api/clients/:id — con historial de entregas
  app.get('/:id', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const { id } = request.params
    const [client] = await sql`SELECT * FROM clients WHERE id = ${id}`
    if (!client) return reply.status(404).send({ error: 'Cliente no encontrado' })

    const deliveries = await sql`
      SELECT d.id, d.status, d.actual_amount, d.payment_method, d.delivered_at,
             r.route_date, u.name AS repartidor
      FROM deliveries d
      JOIN routes r ON r.id = d.route_id
      JOIN users u  ON u.id = r.user_id
      WHERE d.client_id = ${id}
      ORDER BY d.delivered_at DESC
      LIMIT 20
    `
    return { ...client, recent_deliveries: deliveries }
  })

  // GET /api/clients/:id/deliveries — historial completo de entregas del cliente
  app.get('/:id/deliveries', {
    preHandler: [app.authenticate]
  }, async (request) => {
    const { id } = request.params
    return sql`
      SELECT d.id, d.status, d.actual_amount, d.credit_amount,
             d.payment_method, d.delivered_at, d.notes,
             r.route_date, u.name AS repartidor
      FROM deliveries d
      JOIN routes r ON r.id = d.route_id
      JOIN users u  ON u.id = r.user_id
      WHERE d.client_id = ${id}
      ORDER BY d.delivered_at DESC NULLS LAST
      LIMIT 100
    `
  })

  // POST /api/clients
  app.post('/', {
    preHandler: [requireRole('admin', 'supervisor', 'repartidor')],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'address'],
        properties: {
          name:         { type: 'string' },
          trade_name:   { type: 'string' },
          address:      { type: 'string' },
          city:         { type: 'string' },
          zone:         { type: 'string' },
          phone:        { type: 'string' },
          email:        { type: 'string' },
          tax_id:       { type: 'string' },
          credit_limit: { type: 'number', minimum: 0 },
          latitude:     { type: 'number' },
          longitude:    { type: 'number' },
          remito:       { type: 'boolean' },
        }
      }
    }
  }, async (request, reply) => {
    const data = request.body
    const [client] = await sql`
      INSERT INTO clients ${sql(data)}
      RETURNING *
    `
    return reply.status(201).send(client)
  })

  // PATCH /api/clients/:id
  app.patch('/:id', {
    preHandler: [requireRole('admin', 'supervisor')]
  }, async (request, reply) => {
    const { id } = request.params
    const allowed = ['name','trade_name','address','city','zone','phone',
                     'email','tax_id','credit_limit','balance','latitude','longitude','active','notes','remito']
    const updates = Object.fromEntries(
      Object.entries(request.body).filter(([k]) => allowed.includes(k))
    )
    if (!Object.keys(updates).length) {
      return reply.status(400).send({ error: 'Nada para actualizar' })
    }
    const [client] = await sql`
      UPDATE clients SET ${sql(updates)} WHERE id = ${id} RETURNING *
    `
    return client
  })

  // PATCH /api/clients/:id/phone — repartidor completa el telefono si el cliente no tiene
  app.patch('/:id/phone', {
    preHandler: [requireRole('admin', 'supervisor', 'repartidor')]
  }, async (request, reply) => {
    const { id } = request.params
    const [client] = await sql`SELECT * FROM clients WHERE id = ${id}`
    if (!client) return reply.status(404).send({ error: 'Cliente no encontrado' })

    const { phone } = request.body
    if (!phone || typeof phone !== 'string' || !phone.trim()) {
      return reply.status(400).send({ error: 'Telefono requerido' })
    }

    if (client.phone && client.phone.trim()) {
      return reply.status(409).send({ error: 'El cliente ya tiene telefono registrado' })
    }

    const [updated] = await sql`
      UPDATE clients SET phone = ${phone} WHERE id = ${id} RETURNING *
    `
    return updated
  })

  // GET /api/clients/balances — saldos de cuenta corriente
  app.get('/report/balances', {
    preHandler: [requireRole('admin', 'supervisor')]
  }, async () => {
    return sql`SELECT * FROM v_client_balances ORDER BY current_balance DESC`
  })
}
