import sql from '../db/connection.js'
import { sendSMSEntrega } from '../services/sms.js'

export default async function deliveryRoutes(app) {

  // GET /api/deliveries/:id — detalle de entrega con evidencias
  app.get('/:id', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const { id } = request.params
    const [delivery] = await sql`
      SELECT d.*, c.name AS client_name, c.address, c.phone,
             c.trade_name, c.tax_id, c.balance AS client_balance,
             r.route_date, u.name AS repartidor
      FROM deliveries d
      JOIN clients c ON c.id = d.client_id
      JOIN routes r  ON r.id = d.route_id
      JOIN users u   ON u.id = r.user_id
      WHERE d.id = ${id}
    `
    if (!delivery) return reply.status(404).send({ error: 'Entrega no encontrada' })

    const evidence = await sql`
      SELECT id, type, file_url, latitude, longitude, captured_at
      FROM delivery_evidence
      WHERE delivery_id = ${id}
      ORDER BY captured_at ASC
    `
    const payments = await sql`
      SELECT id, method, amount, reference, status, created_at
      FROM payments WHERE delivery_id = ${id}
    `
    return { ...delivery, evidence, payments }
  })

  // PATCH /api/deliveries/:id — registrar resultado de entrega
  // Este es el endpoint más importante: lo llama la app móvil
  app.patch('/:id', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['status'],
        properties: {
          status:            { type: 'string', enum: ['entregado','no_entregado','parcial','devuelto'] },
          actual_amount:     { type: 'number', minimum: 0 },
          payment_method:    { type: 'string', enum: ['efectivo','transferencia','cuenta_corriente','mixto'] },
          cash_received:     { type: 'number', minimum: 0 },
          transfer_amount:   { type: 'number', minimum: 0 },
          credit_amount:     { type: 'number', minimum: 0 },
          change_given:      { type: 'number', minimum: 0 },
          delivery_latitude: { type: 'number' },
          delivery_longitude:{ type: 'number' },
          rejection_reason:  { type: 'string' },
          notes:             { type: 'string' },
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params
    const body = request.body

    const [delivery] = await sql`
      SELECT d.*, r.user_id FROM deliveries d
      JOIN routes r ON r.id = d.route_id
      WHERE d.id = ${id}
    `
    if (!delivery) return reply.status(404).send({ error: 'Entrega no encontrada' })

    const isAdmin = ['admin', 'supervisor'].includes(request.user.role)
    if (!isAdmin && delivery.user_id !== request.user.id) {
      return reply.status(403).send({ error: 'Sin permisos' })
    }

    const updates = {
      status:             body.status,
      actual_amount:      body.actual_amount ?? 0,
      payment_method:     body.payment_method ?? null,
      cash_received:      body.cash_received ?? 0,
      transfer_amount:    body.transfer_amount ?? 0,
      credit_amount:      body.credit_amount ?? 0,
      change_given:       body.change_given ?? 0,
      delivery_latitude:  body.delivery_latitude ?? null,
      delivery_longitude: body.delivery_longitude ?? null,
      rejection_reason:   body.rejection_reason ?? null,
      notes:              body.notes ?? null,
      delivered_at:       body.status === 'entregado' ? new Date() : null,
    }

    const [updated] = await sql`
      UPDATE deliveries SET ${sql(updates)} WHERE id = ${id} RETURNING *
    `

    // Si va a cuenta corriente, actualizar saldo del cliente
    if (body.credit_amount > 0) {
      await sql`
        UPDATE clients
        SET balance = balance + ${body.credit_amount}
        WHERE id = ${delivery.client_id}
      `
    }

    // Registrar el pago
    if (body.status === 'entregado' && body.actual_amount > 0) {
      await sql`
        INSERT INTO payments (delivery_id, client_id, method, amount)
        VALUES (${id}, ${delivery.client_id}, ${body.payment_method}, ${body.actual_amount})
      `
    }

    // Actualizar contadores de la ruta
    await sql`
      UPDATE routes SET
        completed_stops  = (SELECT COUNT(*) FROM deliveries WHERE route_id = ${delivery.route_id} AND status != 'pendiente'),
        collected_amount = (SELECT COALESCE(SUM(actual_amount), 0) FROM deliveries WHERE route_id = ${delivery.route_id})
      WHERE id = ${delivery.route_id}
    `

    // Enviar SMS al cliente si tiene teléfono y la entrega fue exitosa
    if (body.status === 'entregado' && delivery.phone) {
      const items = body.items ?? []
      sendSMSEntrega({
        clientName: delivery.client_name,
        phone:      delivery.phone,
        items,
        total:       body.actual_amount ?? 0,
        method:      body.payment_method,
        creditAmount: body.credit_amount ?? 0,
        notes:       body.notes ?? null,
      }).catch(e => console.error('SMS error:', e))
    }

    return updated
  })

  // POST /api/deliveries/:id/evidence — subir evidencia (foto/firma)
  app.post('/:id/evidence', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const { id } = request.params
    const { type, file_url, latitude, longitude } = request.body

    if (!type || !file_url) {
      return reply.status(400).send({ error: 'type y file_url son requeridos' })
    }

    const [evidence] = await sql`
      INSERT INTO delivery_evidence (delivery_id, type, file_url, latitude, longitude)
      VALUES (${id}, ${type}, ${file_url}, ${latitude ?? null}, ${longitude ?? null})
      RETURNING *
    `
    return reply.status(201).send(evidence)
  })

  // PATCH /api/deliveries/:id/arrived — marcar llegada al cliente
  app.patch('/:id/arrived', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const { id } = request.params
    const { latitude, longitude } = request.body ?? {}

    const [updated] = await sql`
      UPDATE deliveries
      SET arrived_at = NOW(),
          delivery_latitude  = ${latitude ?? null},
          delivery_longitude = ${longitude ?? null}
      WHERE id = ${id}
      RETURNING id, arrived_at, delivery_latitude, delivery_longitude
    `
    if (!updated) return reply.status(404).send({ error: 'Entrega no encontrada' })
    return updated
  })
}
