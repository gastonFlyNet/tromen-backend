import sql from '../db/connection.js'
import { requireRole } from '../middleware/auth.js'

export default async function routeRoutes(app) {
  // Notifica al repartidor de una ruta que sus paradas cambiaron (push silenciosa -> refresh).
  async function notificarRutaActualizada(routeId) {
    try {
      const [r] = await sql`
        SELECT u.push_token FROM routes rt
        JOIN users u ON u.id = rt.user_id
        WHERE rt.id = ${routeId} AND u.push_token IS NOT NULL
      `
      if (r && r.push_token) {
        await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: r.push_token,
            data: { type: 'route_updated', route_id: routeId },
            priority: 'high',
            _contentAvailable: true,
          })
        }).catch(() => {})
      }
    } catch (e) { /* no frenar la operacion por un fallo de push */ }
  }

  // GET /api/routes
  app.get('/', {
    preHandler: [app.authenticate]
  }, async (request) => {
    const { date, status, user_id } = request.query
    const isAdmin = ['admin', 'supervisor'].includes(request.user.role)
    const targetUser = isAdmin ? (user_id ?? null) : request.user.id

    return sql`
      SELECT r.id, r.route_date, r.status, r.started_at, r.finished_at,
             r.total_stops, r.completed_stops, r.total_amount, r.collected_amount,
             r.vehicle_id, u.name AS repartidor, u.id AS user_id
      FROM routes r
      JOIN users u ON u.id = r.user_id
      WHERE 1=1
      ${targetUser ? sql`AND r.user_id = ${targetUser}` : sql``}
      ${date       ? sql`AND r.route_date = ${date}`    : sql``}
      ${status     ? sql`AND r.status = ${status}`      : sql``}
      ORDER BY r.route_date DESC, r.created_at DESC
      LIMIT 100
    `
  })

  // GET /api/routes/today
  app.get('/today', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    let [route] = await sql`
      SELECT r.*, u.name AS repartidor
      FROM routes r
      JOIN users u ON u.id = r.user_id
      WHERE r.user_id = ${request.user.id}
        AND r.route_date = CURRENT_DATE
        AND r.notes IS DISTINCT FROM 'deposito'
        AND r.notes IS DISTINCT FROM 'venta_calle'
      ORDER BY r.created_at DESC
      LIMIT 1
    `

    // No hay ruta de reparto: si hizo venta calle hoy, usamos esa ruta como base
    // para no romper la estructura que espera la app (route.status, route.id, etc.)
    if (!route) {
      ;[route] = await sql`
        SELECT r.*, u.name AS repartidor
        FROM routes r
        JOIN users u ON u.id = r.user_id
        WHERE r.user_id = ${request.user.id}
          AND r.route_date = CURRENT_DATE
          AND r.notes IS DISTINCT FROM 'deposito'
        ORDER BY r.created_at DESC
        LIMIT 1
      `
    }

    if (!route) return reply.status(404).send({ error: 'No hay ruta para hoy' })

    const deliveries = await sql`
      SELECT d.*, c.name AS client_name, c.address, c.phone,
             c.latitude, c.longitude, c.trade_name
      FROM deliveries d
      JOIN clients c ON c.id = d.client_id
      WHERE d.route_id IN (
        SELECT id FROM routes
        WHERE user_id = ${request.user.id}
          AND route_date = CURRENT_DATE
          AND notes IS DISTINCT FROM 'deposito'
      )
      ORDER BY d.stop_order ASC
    `
    return { ...route, deliveries }
  })

  // GET /api/routes/:id
  app.get('/:id', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const { id } = request.params
    const [route] = await sql`
      SELECT r.*, u.name AS repartidor, u.phone AS repartidor_phone
      FROM routes r JOIN users u ON u.id = r.user_id
      WHERE r.id = ${id}
    `
    if (!route) return reply.status(404).send({ error: 'Ruta no encontrada' })

    const isAdmin = ['admin', 'supervisor'].includes(request.user.role)
    if (!isAdmin && route.user_id !== request.user.id) {
      return reply.status(403).send({ error: 'Sin permisos' })
    }

    const deliveries = await sql`
      SELECT d.*, c.name AS client_name, c.address, c.phone,
             c.latitude, c.longitude, c.trade_name
      FROM deliveries d
      JOIN clients c ON c.id = d.client_id
      WHERE d.route_id = ${id}
      ORDER BY d.stop_order ASC
    `
    // Cuadre de caja: efectivo de entregas + pagos de deuda en efectivo del repartidor ese dia
    const efectivo_entregas = deliveries
      .filter(d => d.payment_method === 'efectivo')
      .reduce((sum, d) => sum + Number(d.actual_amount ?? 0), 0)
    const [pagosEf] = await sql`
      SELECT COALESCE(SUM(monto), 0) AS total
      FROM pagos_cuenta_corriente
      WHERE metodo = 'efectivo'
        AND registrado_por = ${route.user_id}
        AND DATE(created_at) = ${route.route_date}
    `
    const efectivo_deudas = Number(pagosEf?.total ?? 0)
    const efectivo_cobrado = efectivo_entregas + efectivo_deudas
    const efectivo_esperado = Number(route.cash_start ?? 0) + efectivo_cobrado
    return { ...route, deliveries, efectivo_entregas, efectivo_deudas, efectivo_cobrado, efectivo_esperado }
  })

  // POST /api/routes — crear ruta
  app.post('/', {
    preHandler: [requireRole('admin', 'supervisor')],
    schema: {
      body: {
        type: 'object',
        required: ['user_id', 'route_date'],
        properties: {
          user_id:    { type: 'string', format: 'uuid' },
          route_date: { type: 'string', format: 'date' },
          vehicle_id: { type: 'string' },
          notes:      { type: 'string' },
          cash_start:  { type: 'number' },
          stops: {
            type: 'array',
            items: {
              type: 'object',
              required: ['client_id', 'expected_amount'],
              properties: {
                client_id:       { type: 'string', format: 'uuid' },
                expected_amount: { type: 'number' },
                stop_order:      { type: 'integer' },
                notes:           { type: 'string' },
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const { user_id, route_date, vehicle_id, notes, cash_start, stops = [] } = request.body

    const [route] = await sql`
      INSERT INTO routes (user_id, route_date, vehicle_id, notes, cash_start, total_stops, total_amount)
      VALUES (
        ${user_id}, ${route_date}, ${vehicle_id ?? null}, ${notes ?? null}, ${cash_start ?? 0},
        ${stops.length},
        ${stops.reduce((sum, s) => sum + (s.expected_amount ?? 0), 0)}
      )
      RETURNING *
    `

    if (stops.length > 0) {
      const deliveryRows = stops.map((s, i) => ({
        route_id:        route.id,
        client_id:       s.client_id,
        stop_order:      s.stop_order ?? i + 1,
        expected_amount: s.expected_amount,
        notes:           s.notes ?? null,
      }))
      await sql`INSERT INTO deliveries ${sql(deliveryRows)}`
    }

    return reply.status(201).send({ ...route, stops_created: stops.length })
  })

  // POST /api/routes/:id/stops — agregar paradas a ruta existente (una o varias)
  app.post('/:id/stops', {
    preHandler: [requireRole('admin', 'supervisor')],
  }, async (request, reply) => {
    const { id } = request.params
    const body = request.body

    const [route] = await sql`SELECT * FROM routes WHERE id = ${id}`
    if (!route) return reply.status(404).send({ error: 'Ruta no encontrada' })

    // Aceptar tanto { stops: [...] } como { client_id, expected_amount }
    const stopsArr = body.stops ?? [body]

    if (!stopsArr.length || !stopsArr[0].client_id) {
      return reply.status(400).send({ error: 'Se requiere client_id' })
    }

    const [maxStop] = await sql`
      SELECT COALESCE(MAX(stop_order), 0) AS max_order FROM deliveries WHERE route_id = ${id}
    `
    let currentOrder = (maxStop?.max_order ?? 0)

    const deliveryRows = stopsArr.map((s, currentIdx) => {
      currentOrder++
      return {
        route_id:        id,
        client_id:       s.client_id,
        stop_order:      s.stop_order ?? currentOrder,
        expected_amount: s.expected_amount ?? 0,
        notes:           s.notes ?? null,
      }
    })

    const inserted = await sql`INSERT INTO deliveries ${sql(deliveryRows)} RETURNING *`

    const totalAdded = stopsArr.reduce((sum, s) => sum + (s.expected_amount ?? 0), 0)
    await sql`
      UPDATE routes SET
        total_stops  = total_stops + ${stopsArr.length},
        total_amount = total_amount + ${totalAdded}
      WHERE id = ${id}
    `

    await notificarRutaActualizada(id)
    return reply.status(201).send(inserted)
  })
  // DELETE /api/routes/:id/stops/:deliveryId — quitar una parada de la ruta
  app.delete('/:id/stops/:deliveryId', {
    preHandler: [requireRole('admin', 'supervisor')],
  }, async (request, reply) => {
    const { id, deliveryId } = request.params
    const [delivery] = await sql`
      SELECT * FROM deliveries WHERE id = ${deliveryId} AND route_id = ${id}
    `
    if (!delivery) return reply.status(404).send({ error: 'Parada no encontrada en esta ruta' })
    if (delivery.status && delivery.status !== 'pendiente') {
      return reply.status(400).send({ error: 'No se puede quitar una parada ya gestionada' })
    }
    await sql`DELETE FROM delivery_items WHERE delivery_id = ${deliveryId}`
    await sql`DELETE FROM deliveries WHERE id = ${deliveryId}`
    await sql`
      UPDATE routes SET
        total_stops  = (SELECT COUNT(*) FROM deliveries WHERE route_id = ${id}),
        total_amount = (SELECT COALESCE(SUM(expected_amount), 0) FROM deliveries WHERE route_id = ${id})
      WHERE id = ${id}
    `
    await notificarRutaActualizada(id)
    return reply.send({ ok: true, removed: deliveryId })
  })

  // PATCH /api/routes/:id/start
  app.patch('/:id/start', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const { id } = request.params
    const [route] = await sql`SELECT * FROM routes WHERE id = ${id}`
    if (!route) return reply.status(404).send({ error: 'Ruta no encontrada' })
    if (route.user_id !== request.user.id) return reply.status(403).send({ error: 'Sin permisos' })
    if (route.status !== 'pendiente') return reply.status(400).send({ error: 'La ruta ya fue iniciada' })

    const [updated] = await sql`
      UPDATE routes SET status = 'en_curso', started_at = NOW()
      WHERE id = ${id} RETURNING *
    `
    return updated
  })

  // PATCH /api/routes/:id/finish
  app.patch('/:id/finish', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const { id } = request.params
    const [route] = await sql`SELECT * FROM routes WHERE id = ${id}`
    if (!route) return reply.status(404).send({ error: 'Ruta no encontrada' })
    if (route.user_id !== request.user.id) return reply.status(403).send({ error: 'Sin permisos' })

    const [updated] = await sql`
      UPDATE routes SET status = 'completada', finished_at = NOW()
      WHERE id = ${id} RETURNING *
    `
    return updated
  })

  // POST /api/routes/:id/pause
  app.post('/:id/pause', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const { id } = request.params
    const { authorized_by, reason } = request.body

    if (!authorized_by) return reply.status(400).send({ error: 'authorized_by es requerido' })

    const [route] = await sql`SELECT * FROM routes WHERE id = ${id}`
    if (!route) return reply.status(404).send({ error: 'Ruta no encontrada' })
    if (route.status !== 'en_curso') return reply.status(400).send({ error: 'La ruta no esta en curso' })

    await sql`UPDATE routes SET status = 'pausada' WHERE id = ${id}`

    const [pause] = await sql`
      INSERT INTO route_pauses (route_id, authorized_by, reason)
      VALUES (${id}, ${authorized_by}, ${reason ?? null})
      RETURNING *
    `
    return reply.status(201).send(pause)
  })

  // POST /api/routes/:id/resume
  app.post('/:id/resume', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const { id } = request.params

    const [route] = await sql`SELECT * FROM routes WHERE id = ${id}`
    if (!route) return reply.status(404).send({ error: 'Ruta no encontrada' })

    await sql`UPDATE routes SET status = 'en_curso' WHERE id = ${id}`

    await sql`
      UPDATE route_pauses SET resumed_at = NOW()
      WHERE route_id = ${id} AND resumed_at IS NULL
    `
    return { success: true }
  })
  // POST /api/routes/:id/geofences — asignar geocercas a una ruta
  app.post('/:id/geofences', {
    preHandler: [requireRole('admin', 'supervisor')],
  }, async (request, reply) => {
    const { id } = request.params
    const { geofence_ids = [] } = request.body

    if (!geofence_ids.length) return reply.status(400).send({ error: 'geofence_ids requerido' })

    const rows = geofence_ids.map((gid) => ({ route_id: id, geofence_id: gid }))
    await sql`INSERT INTO route_geofences ${sql(rows)} ON CONFLICT DO NOTHING`

    return reply.status(201).send({ ok: true, asignadas: geofence_ids.length })
  })

  // GET /api/routes/:id/geofences — geocercas de una ruta
  app.get('/:id/geofences', {
    preHandler: [app.authenticate]
  }, async (request) => {
    const { id } = request.params
    return sql`
      SELECT g.* FROM geofences g
      JOIN route_geofences rg ON rg.geofence_id = g.id
      WHERE rg.route_id = ${id}
    `
  })

  // DELETE /api/routes/:id — borrar ruta (solo si NO tiene ventas registradas)
  // Caso de uso: el encargado generó una ruta mal cargada / duplicada y necesita
  // borrarla. Se bloquea si hay ventas para proteger la contabilidad.
  app.delete('/:id', {
    preHandler: [requireRole('admin', 'supervisor')],
  }, async (request, reply) => {
    const { id } = request.params

    const [route] = await sql`SELECT * FROM routes WHERE id = ${id}`
    if (!route) return reply.status(404).send({ error: 'Ruta no encontrada' })

    // Candado contable: no se borra una ruta que ya tiene ventas.
    const [{ ventas }] = await sql`
      SELECT COUNT(*)::int AS ventas
      FROM deliveries
      WHERE route_id = ${id}
        AND (status IN ('entregado','parcial','devuelto') OR actual_amount > 0)
    `
    if (ventas > 0) {
      return reply.status(400).send({
        error: `No se puede borrar: la ruta tiene ${ventas} ventas registradas`
      })
    }

    // Borrado en orden de FK, todo dentro de una transacción:
    // si algo falla, rollback y la ruta no queda a medias.
    await sql.begin(async (sql) => {
      await sql`DELETE FROM delivery_evidence WHERE delivery_id IN (SELECT id FROM deliveries WHERE route_id = ${id})`
      await sql`DELETE FROM delivery_items    WHERE delivery_id IN (SELECT id FROM deliveries WHERE route_id = ${id})`
      await sql`DELETE FROM route_pauses      WHERE route_id = ${id}`
      await sql`DELETE FROM route_geofences   WHERE route_id = ${id}`
      await sql`DELETE FROM deliveries        WHERE route_id = ${id}`
      await sql`DELETE FROM routes            WHERE id = ${id}`
    })

    return reply.send({ ok: true, deleted: id })
  })
}
