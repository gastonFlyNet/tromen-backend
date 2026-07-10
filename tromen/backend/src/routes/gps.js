import sql from '../db/connection.js'
import { requireRole } from '../middleware/auth.js'

// Distancia en metros entre dos puntos (fórmula de Haversine)
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2)
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export default async function gpsRoutes(app) {

  // POST /api/gps — recibir posición desde la app móvil
  app.post('/', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['latitude', 'longitude'],
        properties: {
          latitude:    { type: 'number' },
          longitude:   { type: 'number' },
          altitude:    { type: 'number' },
          accuracy:    { type: 'number' },
          speed:       { type: 'number' },
          heading:     { type: 'number' },
          device_id:   { type: 'string' },
          battery_pct: { type: 'integer', minimum: 0, maximum: 100 },
          route_id:    { type: ['string', 'null'], format: 'uuid' },
        }
      }
    }
  }, async (request, reply) => {
    const { latitude, longitude, altitude, accuracy, speed,
            heading, device_id, battery_pct, route_id } = request.body

    const [event] = await sql`
      INSERT INTO gps_events
        (user_id, route_id, latitude, longitude, altitude, accuracy, speed, heading, device_id, battery_pct)
      VALUES
        (${request.user.id}, ${route_id ?? null}, ${latitude}, ${longitude},
         ${altitude ?? null}, ${accuracy ?? null}, ${speed ?? null}, ${heading ?? null},
         ${device_id ?? null}, ${battery_pct ?? null})
      RETURNING id, recorded_at
    `

    // ── Detección de salida de geocercas de la ruta ──────────────
    // Solo si hay ruta asociada y la geocerca es de tipo círculo (center + radius).
    if (route_id) {
      try {
        // Geocercas asignadas a esta ruta
        const geofences = await sql`
          SELECT g.id, g.name, g.center_lat, g.center_lon, g.radius_meters
          FROM geofences g
          JOIN route_geofences rg ON rg.geofence_id = g.id
          WHERE rg.route_id = ${route_id}
            AND g.active = true
            AND g.center_lat IS NOT NULL
            AND g.center_lon IS NOT NULL
            AND g.radius_meters IS NOT NULL
        `

        for (const gf of geofences) {
          const distance = distanceMeters(latitude, longitude, gf.center_lat, gf.center_lon)
          const isOutside = distance > Number(gf.radius_meters)
          if (!isOutside) continue  // está dentro, no hay nada que hacer

          // Está fuera. ¿Ya avisamos por esta geocerca en los últimos 10 min?
          const [recentAlert] = await sql`
            SELECT id FROM geofence_events
            WHERE geofence_id = ${gf.id}
              AND user_id = ${request.user.id}
              AND event_type = 'salida'
              AND occurred_at >= NOW() - INTERVAL '10 minutes'
            LIMIT 1
          `
          if (recentAlert) continue  // ya avisamos hace poco, no repetir

          // Registrar la salida
          await sql`
            INSERT INTO geofence_events (geofence_id, user_id, route_id, event_type, latitude, longitude)
            VALUES (${gf.id}, ${request.user.id}, ${route_id}, 'salida', ${latitude}, ${longitude})
          `

          // Notificar a supervisores y admins
          const supervisors = await sql`
            SELECT push_token FROM users
            WHERE role IN ('admin', 'supervisor')
              AND active = true
              AND push_token IS NOT NULL
          `
          const userName = request.user.name ?? 'Un repartidor'
          for (const sup of supervisors) {
            await fetch('https://exp.host/--/api/v2/push/send', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                to: sup.push_token,
                title: 'Salida de zona',
                body: `${userName} salió de ${gf.name}`,
                data: { type: 'geofence_exit', user_id: request.user.id, geofence_id: gf.id },
                sound: 'default',
                priority: 'high',
              })
            }).catch(() => {})
          }
        }
      } catch (err) {
        app.log.error({ err }, 'Error en detección de geocercas')
        // No frenamos el guardado del punto GPS por un error de detección
      }
    }

    return reply.status(201).send(event)
  })

  // POST /api/gps/batch — enviar múltiples puntos (modo offline)
  app.post('/batch', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['points'],
        properties: {
          points: {
            type: 'array',
            maxItems: 500,
            items: {
              type: 'object',
              required: ['latitude', 'longitude', 'recorded_at'],
              properties: {
                latitude:    { type: 'number' },
                longitude:   { type: 'number' },
                speed:       { type: 'number' },
                recorded_at: { type: 'string' },
                route_id:    { type: ['string', 'null'] },
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const { points } = request.body

    const rows = points.map(e => ({
      user_id:     request.user.id,
      route_id:    e.route_id ?? null,
      latitude:    e.latitude,
      longitude:   e.longitude,
      speed:       e.speed ?? null,
      recorded_at: e.recorded_at,
    }))

    await sql`INSERT INTO gps_events ${sql(rows)} ON CONFLICT (user_id, recorded_at) DO NOTHING`
    return reply.status(201).send({ inserted: rows.length })
  })

  // GET /api/gps/live — posición en tiempo real de todos los repartidores (admin)
  app.get('/live', {
    preHandler: [requireRole('admin', 'supervisor')]
  }, async () => {
    return sql`SELECT * FROM v_last_known_position ORDER BY repartidor ASC`
  })

  // GET /api/gps/track/:routeId — track completo de una ruta
  app.get('/track/:routeId', {
    preHandler: [app.authenticate]
  }, async (request) => {
    const { routeId } = request.params
    return sql`
      SELECT latitude, longitude, speed, heading, battery_pct, recorded_at
      FROM gps_events
      WHERE route_id = ${routeId}
      ORDER BY recorded_at ASC
    `
  })

  // GET /api/gps/tracks-today — tracks del día de todos (admin)
  app.get('/tracks-today', {
    preHandler: [requireRole('admin', 'supervisor')]
  }, async () => {
    const rows = await sql`
      SELECT user_id, latitude, longitude, recorded_at
      FROM gps_events
      WHERE recorded_at >= CURRENT_DATE
        AND recorded_at < CURRENT_DATE + INTERVAL '1 day'
      ORDER BY recorded_at ASC
    `
    const pauses = await sql`
      SELECT r.user_id, rp.paused_at, rp.resumed_at
      FROM route_pauses rp
      JOIN routes r ON r.id = rp.route_id
      WHERE r.route_date = CURRENT_DATE
    `
    const pausesByUser = {}
    for (const p of pauses) {
      if (!pausesByUser[p.user_id]) pausesByUser[p.user_id] = []
      pausesByUser[p.user_id].push({
        paused_at: new Date(p.paused_at).getTime(),
        resumed_at: p.resumed_at ? new Date(p.resumed_at).getTime() : Date.now()
      })
    }
    const grouped = {}
    for (const point of rows) {
      if (!grouped[point.user_id]) grouped[point.user_id] = []
      const userPauses = pausesByUser[point.user_id] ?? []
      const pointTime = new Date(point.recorded_at).getTime()
      const isPaused = userPauses.some(p => pointTime >= p.paused_at && pointTime <= p.resumed_at)
      grouped[point.user_id].push({
        lat: point.latitude,
        lng: point.longitude,
        timestamp: point.recorded_at,
        paused: isPaused
      })
    }
    return { tracks: grouped }
  })

  // GET /api/gps/geofence-alerts — alertas de salida de zona recientes
  app.get('/geofence-alerts', {
    preHandler: [requireRole('admin', 'supervisor')]
  }, async () => {
    return sql`
      SELECT ge.id, ge.event_type, ge.latitude, ge.longitude, ge.occurred_at,
             u.name AS repartidor, r.id AS route_id,
             g.name AS geofence_name
      FROM geofence_events ge
      JOIN users u ON u.id = ge.user_id
      LEFT JOIN routes r ON r.id = ge.route_id
      LEFT JOIN geofences g ON g.id = ge.geofence_id
      WHERE ge.event_type = 'salida'
        AND ge.occurred_at >= NOW() - INTERVAL '12 hours'
      ORDER BY ge.occurred_at DESC
      LIMIT 30
    `
  })

  // GET /api/gps/day-track/:userId?date=YYYY-MM-DD — recorrido del día con estado por punto
  app.get('/day-track/:userId', {
    preHandler: [requireRole('admin', 'supervisor')]
  }, async (request) => {
    const { userId } = request.params
    const date = request.query.date ?? new Date().toISOString().slice(0, 10)

    const rows = await sql`
      SELECT latitude, longitude, route_id, speed, recorded_at
      FROM gps_events
      WHERE user_id = ${userId}
        AND recorded_at >= ${date}::date
        AND recorded_at < ${date}::date + INTERVAL '1 day'
      ORDER BY recorded_at ASC
    `
    const pauses = await sql`
      SELECT rp.paused_at, rp.resumed_at
      FROM route_pauses rp
      JOIN routes r ON r.id = rp.route_id
      WHERE r.user_id = ${userId} AND r.route_date = ${date}::date
    `
    const pauseRanges = pauses.map(p => ({
      from: new Date(p.paused_at).getTime(),
      to: p.resumed_at ? new Date(p.resumed_at).getTime() : Date.now(),
    }))

    const points = rows.map(p => {
      const t = new Date(p.recorded_at).getTime()
      const enPausa = pauseRanges.some(r => t >= r.from && t <= r.to)
      let estado = 'sin_ruta'
      if (p.route_id) estado = enPausa ? 'pausa' : 'con_ruta'
      return {
        lat: Number(p.latitude),
        lng: Number(p.longitude),
        estado,
        recorded_at: p.recorded_at,
      }
    })
    return { points }
  })

  // GET /api/gps/user/:userId/history?date=2025-01-15 — track de fecha específica
  app.get('/user/:userId/history', {
    preHandler: [requireRole('admin', 'supervisor')]
  }, async (request) => {
    const { userId } = request.params
    const { date } = request.query

    if (!date) {
      throw { statusCode: 400, message: 'date es requerido (YYYY-MM-DD)' }
    }

    return sql`
      SELECT latitude, longitude, speed, heading, recorded_at
      FROM gps_events
      WHERE user_id = ${userId}
        AND recorded_at >= ${date}::date
        AND recorded_at < ${date}::date + INTERVAL '1 day'
      ORDER BY recorded_at ASC
    `
  })
}
