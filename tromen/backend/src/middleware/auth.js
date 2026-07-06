export const authenticate = async (request, reply) => {
  try {
    await request.jwtVerify()
  } catch {
    reply.status(401).send({ error: 'Token inválido o expirado' })
  }
}

export const requireRole = (...roles) => async (request, reply) => {
  try {
    await request.jwtVerify()
    if (!roles.includes(request.user.role)) {
      reply.status(403).send({ error: 'Sin permisos para esta acción' })
    }
  } catch {
    reply.status(401).send({ error: 'No autorizado' })
  }
}
