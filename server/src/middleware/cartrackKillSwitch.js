import Setting from '../models/Setting.js';

/** Blocks Cartrack write routes when settings.cartrackEnabled is off. */
export async function cartrackKillSwitch(req, res, next) {
  try {
    const settings = await Setting.findOne().select('cartrackEnabled').lean();
    req.cartrackEnabled = settings?.cartrackEnabled === true;
    if (!req.cartrackEnabled) {
      res.status(403).json({
        error: 'Cartrack is turned off. An admin can enable it on the Deliveries page.',
      });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}
