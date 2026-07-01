import sql from '../db/connection.js'
import { sendSMSEntrega } from '../services/sms.js'

export default async function deliveryRoutes(app) {

  // POST /api/deliveries/street-sale — venta fuera de ruta
  app.post('/street-sale', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const {
      client_name,
      client_reference,
      client_phone,
      client_id,
      items = [],
      total_amount,
      payment_method,
      cash_received = 0,
      transfer_amount = 0,
      credit_amount = 0,
      notes,
    } = request.body

    const nombreCliente = client_name ?? client_reference ?? null

    if (!nombreCliente && !client_id) {
      return reply.status(400).send({ error: 'Nombre o ID de cliente requerido' })
    }

    // Resolver o crear cliente
    let resolvedClientId = client_id ?? null
    if (!resolvedClientId && nombreCliente) {
      const [found] = await sql`SELECT id FROM clients WHERE name ILIKE ${nombreCliente} LIMIT 1`
      if (found) {
        resolvedClientId = found.id
        if (client_phone) {
          await sql`UPDATE clients SET phone = ${client_phone} WHERE id = ${resolvedClientId} AND (phone IS NULL OR phone = '')`
        }
      } else {
        const [created] = await sql`
          INSERT INTO clients (name, address, city, phone, active)
          VALUES (${nombreCliente}, 'Venta en calle', 'Catriel', ${client_phone ?? null}, true)
          RETURNING id
        `
        resolvedClientId = created.id
      }
    }

    // Buscar o crear ruta "calle" del día para este usuario
    let route
    const [existingRoute] = await sql`
      SELECT * FROM routes
      WHERE user_id = ${request.user.id}
        AND route_date = CURRENT_DATE
        AND notes = 'venta_calle'
      LIMIT 1
    `
    if (existingRoute) {
      route = existingRoute
    } else {
      const [newRoute] = await sql`
        INSERT INTO routes (user_id, route_date, status, notes, total_stops, total_amount)
        VALUES (${request.user.id}, CURRENT_DATE, 'en_curso', 'venta_calle', 0, 0)
        RETURNING *
      `
      route = newRoute
    }

    // Registrar la entrega
    const [delivery] = await sql`
      INSERT INTO deliveries (
        route_id, client_id, stop_order, status,
        actual_amount, payment_method,
        cash_received, transfer_amount, credit_amount,
        notes, delivered_at
      ) VALUES (
        ${route.id}, ${resolvedClientId},
        (SELECT COALESCE(MAX(stop_order), 0) + 1 FROM deliveries WHERE route_id = ${route.id}),
        'entregado',
        ${total_amount ?? 0}, ${payment_method ?? 'efectivo'},
        ${cash_received}, ${transfer_amount}, ${credit_amount},
        ${notes ?? 'Venta fuera de ruta'},
        NOW()
      )
      RETURNING *
    `

    if (credit_amount > 0 && resolvedClientId) {
      await sql`UPDATE clients SET balance = balance + ${credit_amount} WHERE id = ${resolvedClientId}`
    }

    if (total_amount > 0 && resolvedClientId) {
      await sql`
        INSERT INTO payments (delivery_id, client_id, method, amount)
        VALUES (${delivery.id}, ${resolvedClientId}, ${payment_method ?? 'efectivo'}, ${total_amount})
      `
    }

    await sql`
      UPDATE routes SET
        total_stops      = (SELECT COUNT(*) FROM deliveries WHERE route_id = ${route.id}),
        completed_stops  = (SELECT COUNT(*) FROM deliveries WHERE route_id = ${route.id} AND status = 'entregado'),
        collected_amount = (SELECT COALESCE(SUM(actual_amount), 0) FROM deliveries WHERE route_id = ${route.id}),
        total_amount     = (SELECT COALESCE(SUM(actual_amount), 0) FROM deliveries WHERE route_id = ${route.id})
      WHERE id = ${route.id}
    `

    if (client_phone) {
      sendSMSEntrega({
        clientName: nombreCliente,
        phone: client_phone,
        items,
        total: total_amount ?? 0,
        method: payment_method,
        creditAmount: credit_amount,
        notes: notes ?? null,
      }).catch(e => console.error('SMS street-sale error:', e))
    }

    // Guardar items estructurados (tabla delivery_items)
    if (Array.isArray(items) && items.length > 0) {
      for (const it of items) {
        if (!it || (it.qty ?? 0) <= 0) continue
        await sql`
          INSERT INTO delivery_items (delivery_id, product_id, product_name, quantity, unit_price)
          VALUES (${delivery.id}, ${it.product_id ?? null}, ${it.name ?? 'Producto'}, ${it.qty ?? 0}, ${it.price ?? 0})
        `
      }
    }

    return reply.status(201).send({ id: delivery.id, ok: true })
  })

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
          credit_favor:      { type: 'number', minimum: 0 },
          delivery_latitude: { type: 'number' },
          delivery_longitude:{ type: 'number' },
          rejection_reason:  { type: 'string' },
          notes:             { type: 'string' },
          items:             { type: 'array' },
          client_phone:      { type: 'string' },
          credit_favor:      { type: 'number', minimum: 0 },
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params
    const body = request.body

    const [delivery] = await sql`
      SELECT d.*, r.user_id, c.phone, c.name AS client_name FROM deliveries d
      JOIN routes r ON r.id = d.route_id
      JOIN clients c ON c.id = d.client_id
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

    if (body.credit_amount > 0) {
      await sql`UPDATE clients SET balance = balance + ${body.credit_amount} WHERE id = ${delivery.client_id}`
    }
    // Excedente que el cliente deja a favor (paga de mas y elige 'a favor')
    if (body.credit_favor > 0) {
      await sql`UPDATE clients SET credit_balance = COALESCE(credit_balance, 0) + ${body.credit_favor} WHERE id = ${delivery.client_id}`
    }

    // Guardar teléfono en el cliente si lo puso el repartidor y el cliente no tenía
    if (body.client_phone && delivery.client_id) {
      await sql`
        UPDATE clients SET phone = ${body.client_phone}
        WHERE id = ${delivery.client_id} AND (phone IS NULL OR phone = '')
      `
    }

    if (body.status === 'entregado' && body.actual_amount > 0) {
      await sql`
        INSERT INTO payments (delivery_id, client_id, method, amount)
        VALUES (${id}, ${delivery.client_id}, ${body.payment_method}, ${body.actual_amount})
      `
    }

    await sql`
      UPDATE routes SET
        completed_stops  = (SELECT COUNT(*) FROM deliveries WHERE route_id = ${delivery.route_id} AND status != 'pendiente'),
        collected_amount = (SELECT COALESCE(SUM(actual_amount), 0) FROM deliveries WHERE route_id = ${delivery.route_id})
      WHERE id = ${delivery.route_id}
    `

    // Guardar items estructurados de la entrega (tabla delivery_items)
    const itemsPatch = body.items ?? []
    if (Array.isArray(itemsPatch) && itemsPatch.length > 0) {
      await sql`DELETE FROM delivery_items WHERE delivery_id = ${id}`
      for (const it of itemsPatch) {
        if (!it || (it.qty ?? 0) <= 0) continue
        await sql`
          INSERT INTO delivery_items (delivery_id, product_id, product_name, quantity, unit_price)
          VALUES (${id}, ${it.product_id ?? null}, ${it.name ?? 'Producto'}, ${it.qty ?? 0}, ${it.price ?? 0})
        `
      }
    }

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

  // POST /api/deliveries/:id/evidence — subir evidencia
  app.post('/:id/evidence', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const { id } = request.params
    const { type, file_url, latitude, longitude, client_uuid = null } = request.body

    if (!type || !file_url) {
      return reply.status(400).send({ error: 'type y file_url son requeridos' })
    }

    const [evidence] = await sql`
      INSERT INTO delivery_evidence (delivery_id, type, file_url, latitude, longitude, client_uuid)
      VALUES (${id}, ${type}, ${file_url}, ${latitude ?? null}, ${longitude ?? null}, ${client_uuid})
      ON CONFLICT (client_uuid) DO NOTHING
      RETURNING *
    `
    if (!evidence) {
      return reply.status(200).send({ ok: true, duplicado: true })
    }
    return reply.status(201).send(evidence)
  })

  // PATCH /api/deliveries/:id/arrived — marcar llegada al cliente
  app.patch('/:id/arrived', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const { id } = request.params
    const { latitude, longitude, phone } = request.body ?? {}

    const [updated] = await sql`
      UPDATE deliveries
      SET arrived_at = NOW(),
          delivery_latitude  = ${latitude ?? null},
          delivery_longitude = ${longitude ?? null}
      WHERE id = ${id}
      RETURNING id, arrived_at, delivery_latitude, delivery_longitude, client_id
    `
    if (!updated) return reply.status(404).send({ error: 'Entrega no encontrada' })

    // Si el cliente no tiene coordenadas ni teléfono, guardar los del repartidor
    if (updated.client_id && latitude && longitude) {
      const [client] = await sql`
        SELECT latitude, longitude, phone FROM clients WHERE id = ${updated.client_id}
      `
      if (client && !client.latitude && !client.longitude && !client.phone) {
        await sql`
          UPDATE clients
          SET latitude  = ${latitude},
              longitude = ${longitude},
              phone     = ${phone ?? null}
          WHERE id = ${updated.client_id}
        `
      }
    }

    return updated
  })
}
