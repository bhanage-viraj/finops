import User from '../models/User.js';
import { httpError } from '../utils/http.js';
import { readToken } from '../utils/token.js';

export function requireAuth(env) {
  return async (req, res, next) => {
    try {
      const header = req.get('authorization') || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      const payload = readToken(token, env.jwtSecret);
      if (!payload?.sub) throw httpError(401, 'Sign in required.');
      const user = await User.findById(payload.sub).select('name email role active');
      if (!user || !user.active) throw httpError(401, 'Sign in required.');
      req.user = { id: user._id, name: user.name, email: user.email, role: user.role };
      next();
    } catch (error) {
      next(error.status ? error : httpError(401, 'Sign in required.'));
    }
  };
}
