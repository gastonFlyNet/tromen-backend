import sql from '../db/connection.js'
import { requireRole } from '../middleware/auth.js'

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
          route_id:    { type: 'string', format: 'uuid' },
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
    // Verificar geocerca de Catriel
    const [geofence] = await sql`
      SELECT id, center_lat, center_lon, radius_meters
      FROM geofences
      WHERE name = 'Perimetro Catriel' AND active = true
      LIMIT 1
    `
    if (geofence) {
      const R = 6371000
      const dLat = (latitude - geofence.center_lat) * Math.PI / 180
      const dLon = (longitude - geofence.center_lon) * Math.PI / 180
      const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(geofence.center_lat * Math.PI / 180) *
        Math.cos(latitude * Math.PI / 180) *
        Math.sin(dLon/2) * Math.sin(dLon/2)
      const distance = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
      if (distance > geofence.radius_meters) {
        await sql`
          INSERT INTO geofence_events (geofence_id, user_id, route_id, event_type, latitude, longitude)
          VALUES (${geofence.id}, ${request.user.id}, ${route_id ?? null}, 'salida', ${latitude}, ${longitude})
        `
      }
    }

    return reply.status(201).send(event)
    return reply.status(201).send(event)
  })

  // POST /api/gps/batch — enviar múltiples puntos (modo offline)
  // Cuando el repartidor recupera conexión manda todos los puntos acumulados
  app.post('/batch', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['events'],
        properties: {
          events: {
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
                route_id:    { type: 'string' },
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const { events } = request.body

    const rows = events.map(e => ({
      user_id:     request.user.id,
      route_id:    e.route_id ?? null,
      latitude:    e.latitude,
      longitude:   e.longitude,
      speed:       e.speed ?? null,
      recorded_at: e.recorded_at,
    }))

    await sql`INSERT INTO gps_events ${sql(rows)}`
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

  // GET /api/gps/user/:userId/today — track del día de un usuario
  app.get('/user/:userId/today', {
    preHandler: [requireRole('admin', 'supervisor')]
  }, async (request) => {
    const { userId } = request.params
    return sql`
      SELECT latitude, longitude, speed, heading, recorded_at
      FROM gps_events
      WHERE user_id = ${userId}
        AND recorded_at >= CURRENT_DATE
        AND recorded_at < CURRENT_DATE + INTERVAL '1 day'
      ORDER BY recorded_at ASC
    `
  })
  // GET /api/gps/geofence-alerts — alertas de salida de zona recientes
app.get('/geofence-alerts', {
  preHandler: [requireRole('admin', 'supervisor')]
}, async () => {
  return sql`
    SELECT ge.id, ge.event_type, ge.latitude, ge.longitude, ge.occurred_at,
           u.name AS repartidor, r.id AS route_id
    FROM geofence_events ge
    JOIN users u ON u.id = ge.user_id
    LEFT JOIN routes r ON r.id = ge.route_id
    WHERE ge.event_type = 'salida'
      AND ge.occurred_at >= NOW() - INTERVAL '2 hours'
    ORDER BY ge.occurred_at DESC
    LIMIT 20
  `
})
// GET /api/gps/tracks-today — tracks de TODOS los repartidores hoy (panel principal)
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
    const grouped = {}
    for (const point of rows) {
      if (!grouped[point.user_id]) grouped[point.user_id] = []
      grouped[point.user_id].push({
        lat: point.latitude,
        lng: point.longitude,
        timestamp: point.recorded_at
      })
    }
    return { tracks: grouped }
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
