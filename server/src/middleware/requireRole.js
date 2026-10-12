import { httpError } from '../utils/http.js';

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      next(httpError(403, 'You do not have access to this action.'));
      return;
    }
    next();
  };
}
