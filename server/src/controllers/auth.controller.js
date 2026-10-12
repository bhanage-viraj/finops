import User from '../models/User.js';
import { writeAudit } from '../services/audit/auditLogger.js';
import { asyncHandler, httpError } from '../utils/http.js';
import { verifyPassword } from '../utils/password.js';
import { createToken } from '../utils/token.js';

export function login(env) {
  return asyncHandler(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) throw httpError(400, 'Email and password are required.');
    const user = await User.findOne({ email });
    const valid = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!user || !valid || !user.active) throw httpError(401, 'Email or password is wrong.');
    const token = createToken({ sub: String(user._id), role: user.role }, env.jwtSecret);
    await writeAudit({
      userId: user._id, action: 'login', entity: 'users', entityId: user._id, after: { email: user.email },
    });
    res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
    });
  });
}

export function me() {
  return asyncHandler(async (req, res) => {
    res.json({ user: req.user });
  });
}
