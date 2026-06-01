import sql from '../db/connection.js'
import { requireRole } from '../middleware/auth.js'

export default async function routeRoutes(app) {

  // GET /api/routes — lista de rutas
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

  // GET /api/routes/today — ruta del día del repartidor logueado
  app.get('/today', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const [route] = await sql`
      SELECT r.*, u.name AS repartidor
      FROM routes r
      JOIN users u ON u.id = r.user_id
      WHERE r.user_id = ${request.user.id}
        AND r.route_date = CURRENT_DATE
      LIMIT 1
    `
    if (!route) return reply.status(404).send({ error: 'No hay ruta para hoy' })
    const deliveries = await sql`
      SELECT d.*, c.name AS client_name, c.address, c.phone,
             c.latitude, c.longitude, c.trade_name
      FROM deliveries d
      JOIN clients c ON c.id = d.client_id
      WHERE d.route_id = ${route.id}
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
    return { ...route, deliveries }
  })

  // POST /api/routes — crear ruta (admin/supervisor)
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
    const { user_id, route_date, vehicle_id, notes, stops = [] } = request.body

    // Optimizar orden de paradas por proximidad geografica
    let orderedStops = [...stops]
    if (stops.length > 1) {
      const clientIds = stops.map(s => s.client_id)
      const clients = await sql`
        SELECT id, latitude, longitude FROM clients
        WHERE id = ANY(${clientIds})
        AND latitude IS NOT NULL AND longitude IS NOT NULL
      `
      const coordMap = {}
      for (const c of clients) coordMap[c.id] = { lat: Number(c.latitude), lng: Number(c.longitude) }
      const allHaveCoords = stops.every(s => coordMap[s.client_id])
      if (allHaveCoords) {
        let currentLat = -37.879
        let currentLng = -67.799
        const remaining = [...stops]
        orderedStops = []
        while (remaining.length > 0) {
          let bestIdx = 0
          let bestDist = Infinity
          remaining.forEach((stop, i) => {
            const c = coordMap[stop.client_id]
            const dist = Math.sqrt(Math.pow(c.lat - currentLat, 2) + Math.pow(c.lng - currentLng, 2))
            if (dist < bestDist) { bestDist = dist; bestIdx = i }
          })
          const next = remaining.splice(bestIdx, 1)[0]
          orderedStops.push(next)
          currentLat = coordMap[next.client_id].lat
          currentLng = coordMap[next.client_id].lng
        }
      }
    }

    const [route] = await sql`
      INSERT INTO routes (user_id, route_date, vehicle_id, notes, total_stops, total_amount)
      VALUES (
        ${user_id}, ${route_date}, ${vehicle_id ?? null}, ${notes ?? null},
        ${orderedStops.length},
        ${orderedStops.reduce((sum, s) => sum + (s.expected_amount ?? 0), 0)}
      )
      RETURNING *
    `
    if (stops.length > 0) {
      const deliveryRows = orderedStops.map((s, i) => ({
        route_id:        route.id,
        client_id:       s.client_id,
        stop_order:      i + 1,
        expected_amount: s.expected_amount,
        notes:           s.notes ?? null,
      }))
      await sql`INSERT INTO deliveries ${sql(deliveryRows)}`
    }
    return reply.status(201).send({ ...route, stops_created: orderedStops.length, optimized: true })
  })

  // POST /api/routes/:id/stops — agregar paradas a ruta existente
  app.post('/:id/stops', {
    preHandler: [requireRole('admin', 'supervisor')],
  }, async (request, reply) => {
    const { id } = request.params
    const { stops = [] } = request.body
    const [route] = await sql`SELECT * FROM routes WHERE id = ${id}`
    if (!route) return reply.status(404).send({ error: 'Ruta no encontrada' })
    if (stops.length === 0) return reply.status(400).send({ error: 'No hay paradas para agregar' })
    const [maxOrder] = await sql`
      SELECT COALESCE(MAX(stop_order), 0) AS max_order
      FROM deliveries WHERE route_id = ${id}
    `
    const baseOrder = maxOrder.max_order
    const deliveryRows = orderedStops.map((s, i) => ({
      route_id:        id,
      client_id:       s.client_id,
      stop_order:      s.stop_order ?? baseOrder + i + 1,
      expected_amount: s.expected_amount ?? 0,
      notes:           s.notes ?? null,
    }))
    await sql`INSERT INTO deliveries ${sql(deliveryRows)}`
    await sql`
      UPDATE routes SET
        total_stops  = (SELECT COUNT(*) FROM deliveries WHERE route_id = ${id}),
        total_amount = (SELECT COALESCE(SUM(expected_amount), 0) FROM deliveries WHERE route_id = ${id})
      WHERE id = ${id}
    `
    return reply.status(201).send({
      message: `${stops.length} parada${stops.length > 1 ? 's' : ''} agregada${stops.length > 1 ? 's' : ''} correctamente`,
      stops_added: stops.length,
    })
  })

 // POST /api/routes/:id/pause — pausar ruta
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
    // Notificar a supervisores y admins
    try {
      const repartidor = await sql`SELECT name FROM users WHERE id = ${route.user_id}`
      const repartidorName = repartidor[0]?.name ?? 'Un repartidor'
      const supervisors = await sql`
        SELECT push_token FROM users
        WHERE role IN ('admin', 'supervisor') AND active = true AND push_token IS NOT NULL
      `
      for (const sup of supervisors) {
        await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: sup.push_token,
            title: 'Ruta pausada',
            body: `${repartidorName} pauso su ruta${reason ? ': ' + reason : ''}`,
            data: { type: 'route_paused', route_id: id },
            sound: 'default',
            priority: 'high',
          })
        }).catch(() => {})
      }
    } catch {}
    return reply.status(201).send(pause)
  })

  // POST /api/routes/:id/resume — reanudar ruta
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

  // PATCH /api/routes/:id/start — iniciar ruta
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

  // PATCH /api/routes/:id/finish — finalizar ruta
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
  // GET /api/routes/pauses/today — pausas de rutas de hoy
  app.get('/pauses/today', {
    preHandler: [requireRole('admin', 'supervisor')]
  }, async () => {
    return sql`
      SELECT rp.id, rp.route_id, rp.reason, rp.paused_at, rp.resumed_at,
             u.name AS authorized_by_name,
             r.user_id, rep.name AS repartidor
      FROM route_pauses rp
      JOIN routes r ON r.id = rp.route_id
      JOIN users rep ON rep.id = r.user_id
      LEFT JOIN users u ON u.id = rp.authorized_by
      WHERE r.route_date = CURRENT_DATE
      ORDER BY rp.paused_at DESC
    `
  })
} 
