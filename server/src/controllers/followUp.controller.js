import { todayFollowUp } from '../services/followUp/today.js';
import { asyncHandler } from '../utils/http.js';

export function today(env) {
  return asyncHandler(async (req, res) => {
    res.json(await todayFollowUp(req.user, env));
  });
}
