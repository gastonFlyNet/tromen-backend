import sql from '../db/connection.js'
import { requireRole } from '../middleware/auth.js'

export default async function routeTemplateRoutes(app) {

  // ============================================================
  // GET /api/route-templates — lista de plantillas
  // ============================================================
  app.get('/', {
    preHandler: [app.authenticate]
  }, async (request) => {
    const { user_id, weekday } = request.query

    return sql`
      SELECT t.id, t.user_id, t.weekday, t.name, t.notes, t.active,
             t.created_at, t.updated_at,
             u.name AS repartidor,
             COUNT(s.id) AS stops_count
      FROM route_templates t
      JOIN users u ON u.id = t.user_id
      LEFT JOIN route_template_stops s ON s.template_id = t.id
      WHERE 1=1
      ${user_id ? sql`AND t.user_id = ${user_id}` : sql``}
      ${weekday !== undefined ? sql`AND t.weekday = ${weekday}` : sql``}
      GROUP BY t.id, u.name
      ORDER BY u.name ASC, t.weekday ASC
    `
  })

  // ============================================================
  // GET /api/route-templates/:id — plantilla con paradas y geocercas
  // ============================================================
  app.get('/:id', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const { id } = request.params

    const [template] = await sql`
      SELECT t.*, u.name AS repartidor
      FROM route_templates t
      JOIN users u ON u.id = t.user_id
      WHERE t.id = ${id}
    `
    if (!template) return reply.status(404).send({ error: 'Plantilla no encontrada' })

    const stops = await sql`
      SELECT s.id, s.client_id, s.stop_order, s.expected_amount, s.notes,
             c.name AS client_name, c.address, c.zone, c.phone,
             c.latitude, c.longitude, c.trade_name
      FROM route_template_stops s
      JOIN clients c ON c.id = s.client_id
      WHERE s.template_id = ${id}
      ORDER BY s.stop_order ASC
    `

    const geofences = await sql`
      SELECT g.id, g.name
      FROM geofences g
      JOIN route_template_geofences tg ON tg.geofence_id = g.id
      WHERE tg.template_id = ${id}
    `

    return { ...template, stops, geofences }
  })

  // ============================================================
  // POST /api/route-templates — crear plantilla
  // ============================================================
  app.post('/', {
    preHandler: [requireRole('admin', 'supervisor')],
    schema: {
      body: {
        type: 'object',
        required: ['user_id', 'weekday'],
        properties: {
          user_id: { type: 'string', format: 'uuid' },
          weekday: { type: 'integer', minimum: 0, maximum: 6 },
          name:    { type: 'string' },
          notes:   { type: 'string' },
          geofence_ids: {
            type: 'array',
            items: { type: 'string', format: 'uuid' }
          },
          stops: {
            type: 'array',
            items: {
              type: 'object',
              required: ['client_id'],
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
    const { user_id, weekday, name, notes, stops = [], geofence_ids = [] } = request.body

    const [existing] = await sql`
      SELECT id FROM route_templates
      WHERE user_id = ${user_id} AND weekday = ${weekday}
    `
    if (existing) {
      return reply.status(409).send({
        error: 'Ya existe una plantilla para este repartidor en ese día'
      })
    }

    const [template] = await sql`
      INSERT INTO route_templates (user_id, weekday, name, notes)
      VALUES (${user_id}, ${weekday}, ${name ?? null}, ${notes ?? null})
      RETURNING *
    `

    if (stops.length > 0) {
      const stopRows = stops.map((s, i) => ({
        template_id:     template.id,
        client_id:       s.client_id,
        stop_order:      s.stop_order ?? i + 1,
        expected_amount: s.expected_amount ?? 0,
        notes:           s.notes ?? null,
      }))
      await sql`INSERT INTO route_template_stops ${sql(stopRows)}`
    }

    if (geofence_ids.length > 0) {
      const geoRows = geofence_ids.map((gid) => ({
        template_id: template.id,
        geofence_id: gid,
      }))
      await sql`INSERT INTO route_template_geofences ${sql(geoRows)} ON CONFLICT DO NOTHING`
    }

    return reply.status(201).send({ ...template, stops_created: stops.length })
  })

  // ============================================================
  // PUT /api/route-templates/:id — editar plantilla
  // ============================================================
  app.put('/:id', {
    preHandler: [requireRole('admin', 'supervisor')],
    schema: {
      body: {
        type: 'object',
        properties: {
          name:   { type: 'string' },
          notes:  { type: 'string' },
          active: { type: 'boolean' },
          geofence_ids: {
            type: 'array',
            items: { type: 'string', format: 'uuid' }
          },
          stops: {
            type: 'array',
            items: {
              type: 'object',
              required: ['client_id'],
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
    const { id } = request.params
    const { name, notes, active, stops, geofence_ids } = request.body

    const [template] = await sql`SELECT * FROM route_templates WHERE id = ${id}`
    if (!template) return reply.status(404).send({ error: 'Plantilla no encontrada' })

    const [updated] = await sql`
      UPDATE route_templates
      SET name   = ${name ?? template.name},
          notes  = ${notes ?? template.notes},
          active = ${active ?? template.active}
      WHERE id = ${id}
      RETURNING *
    `

    if (Array.isArray(stops)) {
      await sql`DELETE FROM route_template_stops WHERE template_id = ${id}`
      if (stops.length > 0) {
        const stopRows = stops.map((s, i) => ({
          template_id:     id,
          client_id:       s.client_id,
          stop_order:      s.stop_order ?? i + 1,
          expected_amount: s.expected_amount ?? 0,
          notes:           s.notes ?? null,
        }))
        await sql`INSERT INTO route_template_stops ${sql(stopRows)}`
      }
    }

    if (Array.isArray(geofence_ids)) {
      await sql`DELETE FROM route_template_geofences WHERE template_id = ${id}`
      if (geofence_ids.length > 0) {
        const geoRows = geofence_ids.map((gid) => ({
          template_id: id,
          geofence_id: gid,
        }))
        await sql`INSERT INTO route_template_geofences ${sql(geoRows)} ON CONFLICT DO NOTHING`
      }
    }

    return updated
  })

  // ============================================================
  // DELETE /api/route-templates/:id
  // ============================================================
  app.delete('/:id', {
    preHandler: [requireRole('admin', 'supervisor')]
  }, async (request, reply) => {
    const { id } = request.params
    const [deleted] = await sql`
      DELETE FROM route_templates WHERE id = ${id} RETURNING id
    `
    if (!deleted) return reply.status(404).send({ error: 'Plantilla no encontrada' })
    return { success: true, id: deleted.id }
  })

  // ============================================================
  // POST /api/route-templates/:id/generate — generar ruta del día
  // ============================================================
  app.post('/:id/generate', {
    preHandler: [requireRole('admin', 'supervisor')],
    schema: {
      body: {
        type: 'object',
        properties: {
          route_date: { type: 'string', format: 'date' },
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params
    const route_date = request.body?.route_date ?? new Date().toISOString().slice(0, 10)

    const [template] = await sql`SELECT * FROM route_templates WHERE id = ${id}`
    if (!template) return reply.status(404).send({ error: 'Plantilla no encontrada' })

    const stops = await sql`
      SELECT client_id, stop_order, expected_amount, notes
      FROM route_template_stops
      WHERE template_id = ${id}
      ORDER BY stop_order ASC
    `
    if (stops.length === 0) {
      return reply.status(400).send({ error: 'La plantilla no tiene paradas' })
    }

    const [existingRoute] = await sql`
      SELECT id FROM routes
      WHERE user_id = ${template.user_id} AND route_date = ${route_date}
    `
    if (existingRoute) {
      return reply.status(409).send({
        error: 'El repartidor ya tiene una ruta para esa fecha',
        route_id: existingRoute.id
      })
    }

    const [route] = await sql`
      INSERT INTO routes (user_id, route_date, notes, total_stops, total_amount)
      VALUES (
        ${template.user_id}, ${route_date},
        ${template.notes ?? null},
        ${stops.length},
        ${stops.reduce((sum, s) => sum + Number(s.expected_amount ?? 0), 0)}
      )
      RETURNING *
    `

    const deliveryRows = stops.map((s, i) => ({
      route_id:        route.id,
      client_id:       s.client_id,
      stop_order:      s.stop_order ?? i + 1,
      expected_amount: s.expected_amount ?? 0,
      notes:           s.notes ?? null,
    }))
    await sql`INSERT INTO deliveries ${sql(deliveryRows)}`

    const templateGeofences = await sql`
      SELECT geofence_id FROM route_template_geofences WHERE template_id = ${id}
    `
    if (templateGeofences.length > 0) {
      const geoRows = templateGeofences.map((g) => ({
        route_id:    route.id,
        geofence_id: g.geofence_id,
      }))
      await sql`INSERT INTO route_geofences ${sql(geoRows)} ON CONFLICT DO NOTHING`
    }

    return reply.status(201).send({
      ...route,
      stops_created: stops.length,
      geofences_copied: templateGeofences.length,
      from_template: id
    })
  })
}