import { hashPassword } from '../utils/hash';
import { success, errors } from '../utils/response';
import { isValidEmail, isValidUsername, isValidPassword, generateInviteCode } from '../utils/validate';

interface InitBody {
  username: string;
  email: string;
  password: string;
}

export async function handleInit(request: Request, env: Env): Promise<Response> {
  try {
    // Check if any admin exists
    const existingAdmin = await env.DB.prepare(
      "SELECT id FROM users WHERE role = 'admin' LIMIT 1"
    ).first();

    if (existingAdmin) {
      return errors.forbidden('System already initialized');
    }

    const body = await request.json<InitBody>();
    const { username, email, password } = body;

    if (!username || !email || !password) {
      return errors.badRequest('Missing required fields: username, email, password');
    }

    if (!isValidUsername(username)) {
      return errors.badRequest('Invalid username (3-32 chars, alphanumeric and underscore only)');
    }

    if (!isValidEmail(email)) {
      return errors.badRequest('Invalid email format');
    }

    if (!isValidPassword(password)) {
      return errors.badRequest('Password must be 6-128 characters');
    }

    const userId = crypto.randomUUID();
    const now = Date.now();
    const passwordHash = await hashPassword(password);

    // Create admin user
    await env.DB.prepare(
      `INSERT INTO users (id, username, email, password_hash, role, storage_quota, storage_used, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'admin', 107374182400, 0, 1, ?, ?)`
    ).bind(userId, username.toLowerCase(), email.toLowerCase(), passwordHash, now, now).run();

    // Generate 5 initial invite codes
    const inviteCodes: string[] = [];
    const statements = [];
    for (let i = 0; i < 5; i++) {
      const code = generateInviteCode();
      const codeId = crypto.randomUUID();
      inviteCodes.push(code);
      statements.push(
        env.DB.prepare(
          'INSERT INTO invite_codes (id, code, created_by, created_at) VALUES (?, ?, ?, ?)'
        ).bind(codeId, code, userId, now)
      );
    }
    await env.DB.batch(statements);

    return success({
      message: 'System initialized successfully',
      admin: {
        id: userId,
        username: username.toLowerCase(),
        email: email.toLowerCase(),
        role: 'admin',
      },
      invite_codes: inviteCodes,
    }, 201);
  } catch (e) {
    console.error('Init error:', e);
    return errors.serverError('Initialization failed');
  }
}

export async function handleCheckInit(_request: Request, env: Env): Promise<Response> {
  const existingAdmin = await env.DB.prepare(
    "SELECT id FROM users WHERE role = 'admin' LIMIT 1"
  ).first();

  return success({
    initialized: !!existingAdmin,
  });
}
