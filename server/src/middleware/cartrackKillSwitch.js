/**
 * Blocks Cartrack write routes. FinOps is permanently read-only toward Cartrack
 * (no job create/complete), so this always refuses.
 */
export async function cartrackKillSwitch(req, res, next) {
  res.status(403).json({
    error: 'Cartrack is read-only in FinOps. Creating or completing jobs is disabled.',
  });
}
