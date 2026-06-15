import sql from '../db/connection.js'
import { requireRole } from '../middleware/auth.js'

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

    return {
      summary,
      by_repartidor: byRepartidor,
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
    // cuenta usuarios con un evento de 'salida' reciente que NO tienen
    // un evento de 'entrada' posterior (o sea, salieron y no volvieron aún).
    const [outOfZone] = await sql`
      SELECT COUNT(DISTINCT ge.user_id) AS count
      FROM geofence_events ge
      WHERE ge.event_type = 'salida'
        AND ge.occurred_at >= NOW() - INTERVAL '2 hours'
        AND NOT EXISTS (
          SELECT 1 FROM geofence_events ge2
          WHERE ge2.user_id = ge.user_id
            AND ge2.event_type = 'entrada'
            AND ge2.occurred_at > ge.occurred_at
        )
    `

    return {
      overdue_clients:  parseInt(overdueClients.count),
      stopped_routes:   parseInt(stoppedRoutes.count),
      pending_closings: parseInt(pendingClosings.count),
      out_of_zone:      parseInt(outOfZone.count),
    }
  })
}
