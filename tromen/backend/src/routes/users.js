import bcrypt from 'bcrypt'
import sql from '../db/connection.js'
import { requireRole } from '../middleware/auth.js'

export default async function userRoutes(app) {

  // GET /api/users/supervisors — para autorizar pausas (cualquier usuario autenticado)
  app.get('/supervisors', {
    preHandler: [app.authenticate]
  }, async () => {
    return sql`
      SELECT id, name, role FROM usersa
      WHERE role IN ('admin', 'supervisor') AND active = true
      ORDER BY name ASC
    `
  })

  // GET /api/users — lista de usuarios
  app.get('/', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const { role, active } = request.query
    const isAdmin = ['admin', 'supervisor'].includes(request.user.role)

    // Repartidores solo pueden ver supervisores/admins
    if (!isAdmin && role !== 'supervisor' && role !== 'admin') {
      return reply.status(403).send({ error: 'Sin permisos para esta acción' })
    }

    return sql`
      SELECT id, name, email, phone, role, active, avatar_url, last_login_at, created_at
      FROM users
      WHERE 1=1
      ${role   ? sql`AND role = ${role}`                : sql``}
      ${active ? sql`AND active = ${active === 'true'}` : sql``}
      ORDER BY name ASC
    `
  })

  // GET /api/users/:id
  app.get('/:id', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const { id } = request.params
    if (request.user.id !== id && !['admin', 'supervisor'].includes(request.user.role)) {
      return reply.status(403).send({ error: 'Sin permisos' })
    }
    const [user] = await sql`
      SELECT id, name, email, phone, role, active, avatar_url, vehicle_plate, notes, last_login_at, created_at
      FROM users WHERE id = ${id}
    `
    if (!user) return reply.status(404).send({ error: 'Usuario no encontrado' })
    return user
  })

  // POST /api/users — crear usuario (solo admin)
  app.post('/', {
    preHandler: [requireRole('admin')],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'email', 'password', 'role'],
        properties: {
          name:     { type: 'string', minLength: 2 },
          email:    { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 6 },
          phone:    { type: 'string' },
          role:     { type: 'string', enum: ['admin', 'supervisor', 'repartidor'] },
        }
      }
    }
  }, async (request, reply) => {
    const { name, email, password, phone, role } = request.body
    const existing = await sql`SELECT id FROM users WHERE email = ${email.toLowerCase()}`
    if (existing.length > 0) {
      return reply.status(409).send({ error: 'El email ya está registrado' })
    }
    const password_hash = await bcrypt.hash(password, 10)
    const [user] = await sql`
      INSERT INTO users (name, email, phone, password_hash, role)
      VALUES (${name}, ${email.toLowerCase()}, ${phone ?? null}, ${password_hash}, ${role})
      RETURNING id, name, email, phone, role, active, created_at
    `
    return reply.status(201).send(user)
  })

  // PATCH /api/users/:id — actualizar usuario
  app.patch('/:id', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const { id } = request.params
    const isAdmin = ['admin', 'supervisor'].includes(request.user.role)
    if (request.user.id !== id && !isAdmin) {
      return reply.status(403).send({ error: 'Sin permisos' })
    }
    const { name, phone, avatar_url, active, role, vehicle_plate, notes } = request.body
    const updates = {}
    if (name)                          updates.name = name
    if (phone !== undefined)           updates.phone = phone
    if (avatar_url)                    updates.avatar_url = avatar_url
    if (vehicle_plate !== undefined)   updates.vehicle_plate = vehicle_plate
    if (notes !== undefined)           updates.notes = notes
    if (isAdmin && active !== undefined) updates.active = active
    if (isAdmin && role)               updates.role = role
    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({ error: 'Nada para actualizar' })
    }
    const [user] = await sql`
      UPDATE users SET ${sql(updates)} WHERE id = ${id}
      RETURNING id, name, email, phone, role, active
    `
    return user
  })
  // GET /api/users/:id/routes-history
  app.get('/:id/routes-history', {
    preHandler: [requireRole('admin', 'supervisor')]
  }, async (request, reply) => {
    const { id } = request.params
    const limit = parseInt(request.query.limit) || 30

    const routes = await sql`
      SELECT r.id, r.route_date AS date, r.status, r.created_at,
        json_agg(
          json_build_object(
            'id', d.id,
            'status', d.status,
            'client_id', d.client_id
          )
        ) FILTER (WHERE d.id IS NOT NULL) AS deliveries
      FROM routes r
      LEFT JOIN deliveries d ON d.route_id = r.id
      WHERE r.user_id = ${id}
      GROUP BY r.id, r.route_date, r.status, r.created_at
      ORDER BY r.route_date DESC
      LIMIT ${limit}
    `
    return reply.send({ routes })
  })
}
