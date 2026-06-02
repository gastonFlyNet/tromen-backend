import bcrypt from 'bcrypt'
import sql from '../db/connection.js'

export default async function authRoutes(app) {

  // POST /api/auth/login
  app.post('/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email:    { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 6 },
        }
      }
    }
  }, async (request, reply) => {
    const { email, password } = request.body

    const [user] = await sql`
      SELECT id, name, email, phone, role, password_hash, avatar_url, active, app_access
      FROM users
      WHERE email = ${email.toLowerCase()}
      LIMIT 1
    `

    if (!user) {
      return reply.status(401).send({ error: 'Credenciales inválidas' })
    }

    if (!user.active) {
      return reply.status(403).send({ error: 'Usuario inactivo. Contactá al administrador.' })
    }

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) {
      return reply.status(401).send({ error: 'Credenciales inválidas' })
    }

    await sql`UPDATE users SET last_login_at = NOW() WHERE id = ${user.id}`

    const token = app.jwt.sign(
      {
        id:    user.id,
        email: user.email,
        role:  user.role,
        name:  user.name,
      },
      { expiresIn: process.env.JWT_EXPIRES_IN ?? '7d' }
    )

    return {
      token,
      user: {
        id:         user.id,
        name:       user.name,
        email:      user.email,
        phone:      user.phone,
        role:       user.role,
        avatarUrl:  user.avatar_url,
        app_access: user.app_access ?? true,
      }
    }
  })

  // GET /api/auth/me
  app.get('/me', {
    preHandler: [app.authenticate]
  }, async (request) => {
    const [user] = await sql`
      SELECT id, name, email, phone, role, avatar_url, app_access, last_login_at, created_at
      FROM users
      WHERE id = ${request.user.id}
    `
    return user
  })

  // POST /api/auth/change-password
  app.post('/change-password', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['currentPassword', 'newPassword'],
        properties: {
          currentPassword: { type: 'string', minLength: 6 },
          newPassword:     { type: 'string', minLength: 6 },
        }
      }
    }
  }, async (request, reply) => {
    const { currentPassword, newPassword } = request.body

    const [user] = await sql`
      SELECT password_hash FROM users WHERE id = ${request.user.id}
    `

    const valid = await bcrypt.compare(currentPassword, user.password_hash)
    if (!valid) {
      return reply.status(400).send({ error: 'Contraseña actual incorrecta' })
    }

    const newHash = await bcrypt.hash(newPassword, 10)
    await sql`UPDATE users SET password_hash = ${newHash} WHERE id = ${request.user.id}`

    return { message: 'Contraseña actualizada correctamente' }
  })
}
