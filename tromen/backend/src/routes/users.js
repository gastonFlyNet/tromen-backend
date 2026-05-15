import bcrypt from 'bcrypt'
import sql from '../db/connection.js'
import { requireRole } from '../middleware/auth.js'

export default async function userRoutes(app) {

  // GET /api/users — solo admin/supervisor
  app.get('/', {
    preHandler: [requireRole('admin', 'supervisor')]
  }, async (request) => {
    const { role, active } = request.query
    let query = sql`
      SELECT id, name, email, phone, role, active, avatar_url, last_login_at, created_at
      FROM users
      WHERE 1=1
    `
    if (role)   query = sql`${query} AND role = ${role}`
    if (active !== undefined) query = sql`${query} AND active = ${active === 'true'}`

    return sql`
      SELECT id, name, email, phone, role, active, avatar_url, last_login_at, created_at
      FROM users
      WHERE 1=1
      ${role   ? sql`AND role = ${role}`           : sql``}
      ${active ? sql`AND active = ${active === 'true'}` : sql``}
      ORDER BY name ASC
    `
  })

  // GET /api/users/:id
  app.get('/:id', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const { id } = request.params
    // Solo puede ver su propio perfil o si es admin/supervisor
    if (request.user.id !== id && !['admin', 'supervisor'].includes(request.user.role)) {
      return reply.status(403).send({ error: 'Sin permisos' })
    }

    const [user] = await sql`
      SELECT id, name, email, phone, role, active, avatar_url, last_login_at, created_at
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

    const { name, phone, avatar_url, active, role } = request.body
    const updates = {}
    if (name)       updates.name = name
    if (phone)      updates.phone = phone
    if (avatar_url) updates.avatar_url = avatar_url
    if (isAdmin && active !== undefined) updates.active = active
    if (isAdmin && role) updates.role = role

    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({ error: 'Nada para actualizar' })
    }

    const [user] = await sql`
      UPDATE users SET ${sql(updates)} WHERE id = ${id}
      RETURNING id, name, email, phone, role, active
    `
    return user
  })
}
