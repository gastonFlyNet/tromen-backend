import sql from '../db/connection.js'
import { requireRole } from '../middleware/auth.js'

// Parser de productos desde el texto de notes (datos viejos, pre delivery_items)
function parseProductosDeNotes(notes) {
  if (!notes) return { entregados: [], devueltos: [] }
  const partes = notes.split('|').map(p => p.trim())
  const entregados = []
  const devueltos = []
  for (const parte of partes) {
    const mDev = parte.match(/^(.+?)\s+devueltos:\s*(\d+)$/i)
    if (mDev) { devueltos.push({ nombre: mDev[1].trim(), cantidad: parseInt(mDev[2]) }); continue }
    const mEnt = parte.match(/^(.+?):\s*(\d+)$/)
    if (mEnt) {
      const nombre = mEnt[1].trim()
      if (/^(cliente|tel|tel\u00e9fono|remito|nota|notas)$/i.test(nombre)) continue
      entregados.push({ nombre, cantidad: parseInt(mEnt[2]) })
      continue
    }
  }
  return { entregados, devueltos }
}

export default async function dashboardRoutes(app) {

  // GET /api/dashboard/today — resumen del día (el endpoint principal del panel web)
  app.get('/today', {
    preHandler: [requireRole('admin', 'supervisor')]
  }, async () => {
    const [summary] = await sql`
      SELECT
        COUNT(*)                                            AS total_routes,
        COUNT(*) FILTER (WHERE status = 'en_curso')        AS routes_active,
        COUNT(*) FILTER (WHERE status = 'completada')      AS routes_done,
        COUNT(*) FILTER (WHERE status = 'pendiente')       AS routes_pending,
        COALESCE(SUM(total_stops), 0)                      AS total_stops,
        COALESCE(SUM(completed_stops), 0)                  AS completed_stops,
        COALESCE(SUM(collected_amount), 0)                 AS total_collected,
        COALESCE(SUM(total_amount), 0)                     AS total_expected
      FROM routes
      WHERE route_date = CURRENT_DATE
    `

    const byRepartidor = await sql`SELECT * FROM v_daily_summary WHERE route_date = CURRENT_DATE`
    const livePositions = await sql`SELECT * FROM v_last_known_position`

    // Sacar las rutas de depósito: no son repartidores reales, no van en la lista
    const rutasDeposito = await sql`
      SELECT id FROM routes WHERE route_date = CURRENT_DATE AND notes = 'deposito'
    `
    const idsDeposito = new Set(rutasDeposito.map(r => r.id))
    const byRepartidorFiltrado = byRepartidor.filter(r => !idsDeposito.has(r.route_id))

    return {
      summary,
      by_repartidor: byRepartidorFiltrado,
      live_positions: livePositions,
    }
  })

  // GET /api/dashboard/summary?from=&to= — resumen por rango de fechas
  app.get('/summary', {
    preHandler: [requireRole('admin', 'supervisor')]
  }, async (request) => {
    const { from, to } = request.query
    const dateFrom = from ?? new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
    const dateTo   = to   ?? new Date().toISOString().slice(0, 10)

    const daily = await sql`
      SELECT * FROM v_daily_summary
      WHERE route_date BETWEEN ${dateFrom} AND ${dateTo}
      ORDER BY route_date DESC
    `

    const [totals] = await sql`
      SELECT
        COUNT(DISTINCT r.id)                                    AS total_routes,
        COUNT(d.id)                                             AS total_deliveries,
        COUNT(d.id) FILTER (WHERE d.status = 'entregado')       AS delivered,
        COUNT(d.id) FILTER (WHERE d.status = 'no_entregado')    AS not_delivered,
        COALESCE(SUM(d.actual_amount), 0)                       AS total_collected,
        COALESCE(SUM(d.cash_received), 0)                       AS cash_total,
        COALESCE(SUM(d.transfer_amount), 0)                     AS transfer_total,
        COALESCE(SUM(d.credit_amount), 0)                       AS credit_total
      FROM routes r
      LEFT JOIN deliveries d ON d.route_id = r.id
      WHERE r.route_date BETWEEN ${dateFrom} AND ${dateTo}
    `

    return { from: dateFrom, to: dateTo, totals, daily }
  })

  // GET /api/dashboard/collections — cobranzas pendientes de conciliar
  app.get('/collections', {
    preHandler: [requireRole('admin', 'supervisor')]
  }, async () => {
    const pending = await sql`
      SELECT p.id, p.method, p.amount, p.reference, p.created_at,
             c.name AS client_name, d.delivered_at,
             u.name AS repartidor, r.route_date
      FROM payments p
      JOIN deliveries d ON d.id = p.delivery_id
      JOIN clients c    ON c.id = p.client_id
      JOIN routes r     ON r.id = d.route_id
      JOIN users u      ON u.id = r.user_id
      WHERE p.status = 'pendiente'
      ORDER BY p.created_at DESC
      LIMIT 200
    `
    return pending
  })

  // GET /api/dashboard/resumen-diario?date=YYYY-MM-DD — datos para el Excel del día
  app.get('/resumen-diario', {
    preHandler: [requireRole('admin', 'supervisor')]
  }, async (request) => {
    const date = request.query.date ?? new Date().toISOString().slice(0, 10)

    // Todas las ventas entregadas del día (reparto + depósito), con detalle
    const ventasRaw = await sql`
      SELECT
        d.id,
        d.actual_amount,
        d.payment_method,
        d.cash_received,
        d.transfer_amount,
        d.credit_amount,
        d.change_given,
        d.notes,
        d.delivered_at,
        c.name AS cliente,
        c.address AS direccion,
        u.name AS repartidor,
        u.id AS repartidor_id,
        CASE WHEN r.notes = 'deposito' THEN true ELSE false END AS es_deposito
      FROM deliveries d
      JOIN routes r ON r.id = d.route_id
      JOIN users u ON u.id = r.user_id
      LEFT JOIN clients c ON c.id = d.client_id
      WHERE r.route_date = ${date}::date
        AND d.status = 'entregado'
      ORDER BY es_deposito ASC, u.name ASC, d.delivered_at ASC
    `

    // Items estructurados (delivery_items) de las entregas del dia
    const itemsRows = await sql`
      SELECT di.delivery_id, di.product_name, di.quantity
      FROM delivery_items di
      JOIN deliveries d ON d.id = di.delivery_id
      JOIN routes r ON r.id = d.route_id
      WHERE r.route_date = ${date}::date
    `
    const itemsPorEntrega = {}
    for (const it of itemsRows) {
      if (!itemsPorEntrega[it.delivery_id]) itemsPorEntrega[it.delivery_id] = []
      itemsPorEntrega[it.delivery_id].push({ nombre: it.product_name, cantidad: Number(it.quantity) })
    }

    // Por cada venta: productos entregados y devueltos (estructurado o parseado)
    const ventas = ventasRaw.map(v => {
      let entregados = []
      let devueltos = []
      if (itemsPorEntrega[v.id] && itemsPorEntrega[v.id].length > 0) {
        entregados = itemsPorEntrega[v.id]
        devueltos = parseProductosDeNotes(v.notes).devueltos
      } else {
        const p = parseProductosDeNotes(v.notes)
        entregados = p.entregados
        devueltos = p.devueltos
      }
      return { ...v, productos: entregados, devueltos }
    })

    // Cambios por bidon en mal estado del dia
    const cambiosBidon = await sql`
      SELECT bme.cantidad, bme.notes, bme.created_at,
             p.name AS producto, c.name AS cliente, u.name AS repartidor
      FROM bidones_mal_estado bme
      LEFT JOIN products p ON p.id = bme.product_id
      LEFT JOIN clients c ON c.id = bme.client_id
      LEFT JOIN users u ON u.id = bme.repartidor_id
      WHERE bme.created_at >= ${date}::date
        AND bme.created_at < ${date}::date + INTERVAL '1 day'
      ORDER BY bme.created_at ASC
    `

    return { date, ventas, cambios_bidon: cambiosBidon }
  })

  // GET /api/dashboard/alerts — alertas del sistema
  app.get('/alerts', {
    preHandler: [requireRole('admin', 'supervisor')]
  }, async () => {
    const [overdueClients] = await sql`
      SELECT COUNT(*) AS count FROM clients
      WHERE balance > credit_limit AND active = true
    `
    const [stoppedRoutes] = await sql`
      SELECT COUNT(*) AS count FROM routes r
      WHERE r.status = 'en_curso'
        AND r.route_date = CURRENT_DATE
        AND NOT EXISTS (
          SELECT 1 FROM gps_events g
          WHERE g.route_id = r.id
            AND g.recorded_at > NOW() - INTERVAL '30 minutes'
        )
    `
    const [pendingClosings] = await sql`
      SELECT COUNT(*) AS count FROM cash_closings
      WHERE status = 'con_diferencia'
    `
    // Repartidores actualmente fuera de zona:
    // usuarios con un evento de 'salida' reciente que NO tienen un
    // evento de 'entrada' posterior (salieron y no volvieron aún).
    const outOfZoneRows = await sql`
      SELECT DISTINCT u.id, u.name
      FROM geofence_events ge
      JOIN users u ON u.id = ge.user_id
      WHERE ge.event_type = 'salida'
        AND ge.occurred_at >= NOW() - INTERVAL '2 hours'
        AND NOT EXISTS (
          SELECT 1 FROM geofence_events ge2
          WHERE ge2.user_id = ge.user_id
            AND ge2.event_type = 'entrada'
            AND ge2.occurred_at > ge.occurred_at
        )
    `

    // Rutas pausadas hoy: el repartidor pausó su ruta y no la retomó.
    const pausedRows = await sql`
      SELECT u.id, u.name
      FROM routes r
      JOIN users u ON u.id = r.user_id
      WHERE r.status = 'pausada'
        AND r.route_date = CURRENT_DATE
    `

    return {
      overdue_clients:  parseInt(overdueClients.count),
      stopped_routes:   parseInt(stoppedRoutes.count),
      pending_closings: parseInt(pendingClosings.count),
      out_of_zone:      outOfZoneRows.length,
      out_of_zone_names: outOfZoneRows.map(r => r.name),
      paused_routes:    pausedRows.length,
      paused_routes_names: pausedRows.map(r => r.name),
    }
  })

  // GET /api/dashboard/ventas-geo?date=YYYY-MM-DD&user_id=... â€” gestiones georreferenciadas
  // Fuente unica para los marcadores de venta en todos los mapas del panel.
  app.get('/ventas-geo', {
    preHandler: [requireRole('admin', 'supervisor')]
  }, async (request) => {
    const date = request.query.date ?? new Date().toISOString().slice(0, 10)
    const userId = request.query.user_id ?? null

    const ventas = await sql`
      SELECT
        d.id,
        d.delivery_latitude  AS latitude,
        d.delivery_longitude AS longitude,
        d.actual_amount      AS monto,
        d.delivered_at,
        d.status,
        d.notes,
        c.name AS cliente,
        u.name AS repartidor,
        u.id   AS repartidor_id,
        CASE
          WHEN r.notes = 'venta_calle' THEN 'calle'
          WHEN d.status = 'no_entregado' THEN 'ausente'
          ELSE 'normal'
        END AS tipo
      FROM deliveries d
      JOIN routes r ON r.id = d.route_id
      JOIN users u  ON u.id = r.user_id
      LEFT JOIN clients c ON c.id = d.client_id
      WHERE r.route_date = ${date}::date
        AND d.delivery_latitude IS NOT NULL
        AND d.delivery_longitude IS NOT NULL
        ${userId ? sql`AND u.id = ${userId}` : sql``}
      ORDER BY d.delivered_at ASC
    `

    // Productos por gestion (para el popup): de delivery_items o parseado de notes
    const ids = ventas.map(v => v.id)
    let itemsPorEntrega = {}
    if (ids.length > 0) {
      const itemsRows = await sql`
        SELECT delivery_id, product_name, quantity
        FROM delivery_items
        WHERE delivery_id = ANY(${ids})
      `
      for (const it of itemsRows) {
        if (!itemsPorEntrega[it.delivery_id]) itemsPorEntrega[it.delivery_id] = []
        itemsPorEntrega[it.delivery_id].push({ nombre: it.product_name, cantidad: Number(it.quantity) })
      }
    }

    const result = ventas.map(v => ({
      ...v,
      productos: itemsPorEntrega[v.id] ?? parseProductosDeNotes(v.notes).entregados,
    }))

    return { date, ventas: result }
  })
}
