// POST /api/gps/simulate — insertar recorrido de prueba para testear historial
// SOLO PARA DESARROLLO — eliminar en producción

import sql from '../db/connection.js'
import { requireRole } from '../middleware/auth.js'

export default async function gpsSimulateRoutes(app) {

  app.post('/simulate', {
    preHandler: [requireRole('admin', 'supervisor')]
  }, async (request, reply) => {
    const { route_id, user_id } = request.body

    if (!route_id || !user_id) {
      return reply.status(400).send({ error: 'route_id y user_id son requeridos' })
    }

    // Recorrido simulado por Catriel (puntos reales de calles)
    const puntosBase = [
      { lat: -37.878007, lng: -67.790884 }, // Depósito TROMEN
      { lat: -37.878500, lng: -67.789000 },
      { lat: -37.879200, lng: -67.787500 },
      { lat: -37.880100, lng: -67.786000 },
      { lat: -37.881500, lng: -67.784500 }, // En movimiento
      { lat: -37.882000, lng: -67.784500 }, // Detenido (parada 1)
      { lat: -37.882000, lng: -67.784500 }, // Detenido
      { lat: -37.882000, lng: -67.784500 }, // Detenido
      { lat: -37.882500, lng: -67.783000 }, // En movimiento
      { lat: -37.883200, lng: -67.781500 },
      { lat: -37.884000, lng: -67.780000 },
      { lat: -37.884500, lng: -67.780000 }, // Detenido (parada 2)
      { lat: -37.884500, lng: -67.780000 }, // Detenido
      { lat: -37.884500, lng: -67.780000 }, // Detenido
      { lat: -37.883800, lng: -67.778500 }, // En movimiento
      { lat: -37.883000, lng: -67.777000 },
      { lat: -37.882200, lng: -67.775500 },
      { lat: -37.881500, lng: -67.774000 }, // Detenido (pausa)
      { lat: -37.881500, lng: -67.774000 }, // Pausado
      { lat: -37.881500, lng: -67.774000 }, // Pausado
      { lat: -37.881500, lng: -67.774000 }, // Pausado
      { lat: -37.882000, lng: -67.772500 }, // Reanuda
      { lat: -37.882800, lng: -67.771000 },
      { lat: -37.883500, lng: -67.769500 },
      { lat: -37.884000, lng: -67.769500 }, // Detenido (parada 3)
      { lat: -37.884000, lng: -67.769500 }, // Detenido
      { lat: -37.883500, lng: -67.771000 }, // Regreso
      { lat: -37.882500, lng: -67.773000 },
      { lat: -37.881500, lng: -67.775500 },
      { lat: -37.880500, lng: -67.778000 },
      { lat: -37.879500, lng: -67.780500 },
      { lat: -37.878800, lng: -67.783000 },
      { lat: -37.878200, lng: -67.786000 },
      { lat: -37.878007, lng: -67.790884 }, // Regreso depósito
    ]

    // Pausa simulada entre puntos 17-20
    const pausaInicio = new Date(Date.now() - 90 * 60 * 1000) // hace 90 min
    pausaInicio.setMinutes(pausaInicio.getMinutes() + 17 * 2)
    const pausaFin = new Date(pausaInicio.getTime() + 10 * 60 * 1000)

    // Generar eventos GPS con timestamps retroactivos
    const baseTime = new Date(Date.now() - 120 * 60 * 1000) // hace 2 horas
    const eventos = puntosBase.map((p, i) => {
      const ts = new Date(baseTime.getTime() + i * 2 * 60 * 1000)
      const isPausado = i >= 17 && i <= 20
      const isDetenido = [5, 6, 7, 11, 12, 13, 24, 25].includes(i)
      return {
        user_id,
        route_id,
        latitude:    p.lat,
        longitude:   p.lng,
        speed:       isPausado ? 0 : isDetenido ? 0 : Math.random() * 35 + 15,
        recorded_at: ts.toISOString(),
      }
    })

    await sql`INSERT INTO gps_events ${sql(eventos)}`

    // Insertar pausa simulada
    try {
      await sql`
        INSERT INTO route_pauses (route_id, authorized_by, reason, paused_at, resumed_at)
        VALUES (
          ${route_id},
          ${user_id},
          'Pausa simulada para test',
          ${pausaInicio.toISOString()},
          ${pausaFin.toISOString()}
        )
      `
    } catch {}

    return reply.send({
      ok: true,
      puntos_insertados: eventos.length,
      mensaje: `Recorrido simulado insertado para ruta ${route_id}`
    })
  })
}
