import sql from '../db/connection.js'
import { requireRole } from '../middleware/auth.js'

export default async function geofenceRoutes(app) {

  app.get('/', { preHandler: [app.authenticate] }, async () => {
    return sql`SELECT * FROM geofences ORDER BY created_at DESC`
  })

  app.post('/', { preHandler: [requireRole('admin', 'supervisor')] }, async (request, reply) => {
    const { name, description, type, polygon_coords, center_lat, center_lon, radius_meters, active } = request.body
    const [g] = await sql`
      INSERT INTO geofences (name, description, type, polygon_coords, center_lat, center_lon, radius_meters, active)
      VALUES (${name}, ${description ?? null}, ${type ?? 'zona_entrega'}, ${polygon_coords},
              ${center_lat}, ${center_lon}, ${radius_meters ?? 1000}, ${active ?? true})
      RETURNING *
    `
    return reply.status(201).send(g)
  })

  app.patch('/:id', { preHandler: [requireRole('admin', 'supervisor')] }, async (request, reply) => {
    const { id } = request.params
    const { name, description, type, polygon_coords, center_lat, center_lon, radius_meters, active } = request.body
    const updates: any = {}
    if (name !== undefined)          updates.name = name
    if (description !== undefined)   updates.description = description
    if (type !== undefined)          updates.type = type
    if (polygon_coords !== undefined) updates.polygon_coords = polygon_coords
    if (center_lat !== undefined)    updates.center_lat = center_lat
    if (center_lon !== undefined)    updates.center_lon = center_lon
    if (radius_meters !== undefined) updates.radius_meters = radius_meters
    if (active !== undefined)        updates.active = active
    updates.updated_at = new Date()
    const [g] = await sql`UPDATE geofences SET ${sql(updates)} WHERE id = ${id} RETURNING *`
    return g
  })
}