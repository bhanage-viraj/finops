import Setting from '../models/Setting.js';

/**
 * Reads settings.erpFeaturesEnabled.
 * Import and export routes attach this in M6. Nothing mounts it in M0.
 * When it is off, those routes refuse. The seeded default is off.
 */
export async function killSwitch(req, res, next) {
  try {
    const settings = await Setting.findOne().select('erpFeaturesEnabled').lean();
    req.erpFeaturesEnabled = settings?.erpFeaturesEnabled === true;
    if (!req.erpFeaturesEnabled) {
      res.status(403).json({
        error: 'Zoho export is turned off. An admin can enable it on the overview.',
      });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}
