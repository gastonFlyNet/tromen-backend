import sql from '../db/connection.js'

export default async function ventasDepositoRoutes(app) {

  // POST /api/ventas-deposito — registrar venta desde el depósito
  app.post('/', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['total_amount', 'payment_method'],
        properties: {
          client_id:      { type: 'string' },
          client_name:    { type: 'string' },
          total_amount:   { type: 'number', minimum: 0 },
          payment_method: { type: 'string', enum: ['efectivo', 'transferencia', 'cuenta_corriente', 'mixto'] },
          cash_received:  { type: 'number', minimum: 0 },
          transfer_amount:{ type: 'number', minimum: 0 },
          credit_amount:  { type: 'number', minimum: 0 },
          notes:          { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                product_id: { type: 'string' },
                name:       { type: 'string' },
                qty:        { type: 'number' },
                price:      { type: 'number' },
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const {
      client_id, client_name,
      total_amount, payment_method,
      cash_received = 0, transfer_amount = 0, credit_amount = 0,
      notes, items = []
    } = request.body

    // 1. Buscar o crear ruta "depósito" del día para este usuario
    let route
    const [existingRoute] = await sql`
      SELECT * FROM routes
      WHERE user_id = ${request.user.id}
        AND route_date = CURRENT_DATE
        AND notes = 'deposito'
      LIMIT 1
    `

    if (existingRoute) {
      route = existingRoute
    } else {
      const [newRoute] = await sql`
        INSERT INTO routes (user_id, route_date, status, notes, total_stops, total_amount)
        VALUES (${request.user.id}, CURRENT_DATE, 'en_curso', 'deposito', 0, 0)
        RETURNING *
      `
      route = newRoute
    }

    // 2. Resolver client_id — si no hay, usar/crear cliente genérico
    let resolvedClientId = client_id ?? null
    if (!resolvedClientId && client_name) {
      // Buscar por nombre exacto
      const [found] = await sql`
        SELECT id FROM clients WHERE name ILIKE ${client_name} LIMIT 1
      `
      if (found) {
        resolvedClientId = found.id
      } else {
        // Crear cliente nuevo
        const [created] = await sql`
          INSERT INTO clients (name, address, city, active)
          VALUES (${client_name}, 'Depósito TROMEN', 'Catriel', true)
          RETURNING id
        `
        resolvedClientId = created.id
      }
    }

    // 3. Registrar la entrega
    const [delivery] = await sql`
      INSERT INTO deliveries (
        route_id, client_id, stop_order, status,
        actual_amount, payment_method,
        cash_received, transfer_amount, credit_amount,
        notes, delivered_at
      ) VALUES (
        ${route.id},
        ${resolvedClientId},
        (SELECT COALESCE(MAX(stop_order), 0) + 1 FROM deliveries WHERE route_id = ${route.id}),
        'entregado',
        ${total_amount}, ${payment_method},
        ${cash_received}, ${transfer_amount}, ${credit_amount},
        ${notes ?? 'Venta depósito'},
        NOW()
      )
      RETURNING *
    `

    // 4. Si hay deuda, actualizar balance del cliente
    if (credit_amount > 0 && resolvedClientId) {
      await sql`
        UPDATE clients SET balance = balance + ${credit_amount}
        WHERE id = ${resolvedClientId}
      `
    }

    // 5. Registrar el pago
    if (total_amount > 0 && resolvedClientId) {
      await sql`
        INSERT INTO payments (delivery_id, client_id, method, amount)
        VALUES (${delivery.id}, ${resolvedClientId}, ${payment_method}, ${total_amount})
      `
    }

    // 6. Actualizar contadores de la ruta
    await sql`
      UPDATE routes SET
        total_stops      = (SELECT COUNT(*) FROM deliveries WHERE route_id = ${route.id}),
        completed_stops  = (SELECT COUNT(*) FROM deliveries WHERE route_id = ${route.id} AND status = 'entregado'),
        collected_amount = (SELECT COALESCE(SUM(actual_amount), 0) FROM deliveries WHERE route_id = ${route.id}),
        total_amount     = (SELECT COALESCE(SUM(actual_amount), 0) FROM deliveries WHERE route_id = ${route.id})
      WHERE id = ${route.id}
    `

    return reply.status(201).send({
      ok: true,
      delivery_id: delivery.id,
      route_id: route.id,
      mensaje: 'Venta registrada correctamente'
    })
  })

  // GET /api/ventas-deposito/hoy — ventas del depósito del día
  app.get('/hoy', {
    preHandler: [app.authenticate]
  }, async () => {
    const ventas = await sql`
      SELECT
        d.id, d.actual_amount, d.payment_method,
        d.cash_received, d.transfer_amount, d.credit_amount,
        d.notes, d.delivered_at,
        c.name AS client_name,
        u.name AS operador
      FROM deliveries d
      JOIN routes r ON r.id = d.route_id
      JOIN users u  ON u.id = r.user_id
      LEFT JOIN clients c ON c.id = d.client_id
      WHERE r.notes = 'deposito'
        AND r.route_date = CURRENT_DATE
        AND d.status = 'entregado'
      ORDER BY d.delivered_at DESC
    `
    const total = ventas.reduce((s, v) => s + parseFloat(v.actual_amount || 0), 0)
    return { ventas, total }
  })
}
