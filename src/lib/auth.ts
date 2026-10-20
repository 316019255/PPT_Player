import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { cookies } from 'next/headers';
import { get, insert } from './db';
import { AuthTtlCache, type AuthSnapshot } from './auth-cache';
import { guestEmail, isValidEmail, normalizeEmail, passwordProblem, proIsActive } from './validate';

const TOKEN_NAME = 'ppt_token';
const GUEST_TOKEN_NAME = 'ppt_guest';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

let devSecret: string | null = null;

function loadDevSecret(): string {
  if (devSecret) return devSecret;
  const dir = join(process.cwd(), 'data');
  const file = join(dir, '.jwt-dev-secret');
  if (existsSync(file)) {
    devSecret = readFileSync(file, 'utf8').trim();
    if (devSecret) return devSecret;
  }
  devSecret = randomBytes(32).toString('hex');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, devSecret, { mode: 0o600 });
  return devSecret;
}

/**
 * 生产环境必须显式提供 JWT_SECRET，否则一律失败关闭；
 * 开发环境使用落盘的本机随机密钥，避免留下可预测的兜底值。
 */
function getJwtSecret(): string {
  const configured = process.env.JWT_SECRET?.trim();
  if (configured) {
    if (IS_PRODUCTION && configured.length < 32) {
      throw new Error('JWT_SECRET 过短：生产环境至少需要 32 个字符');
    }
    return configured;
  }
  if (IS_PRODUCTION) {
    throw new Error('生产环境缺少 JWT_SECRET，请在 .env 中配置后再启动');
  }
  return loadDevSecret();
}

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  pro?: boolean;
  isGuest?: boolean;
}

interface AccountRow {
  id: number;
  email: string;
  name: string;
  pro: number;
  pro_expires_at: string | null;
}

interface UserRow extends AccountRow {
  password_hash: string;
}

/**
 * 游客账号的密码位。游客从不登录，这里存的是一个不合法的 bcrypt 串：
 * verify 认不出格式就返回 false，谁都进不来。建档时省掉整把哈希 ——
 * 实测单把 cost 10 要 80–130ms，而且是纯 CPU，访客越多白烧越多。
 */
export const LOCKED_PASSWORD_HASH = '!locked-no-password-login';

/**
 * pro 判定的进程内 TTL：60 秒是「每个请求少跑一趟东京」和「取消 Pro 最坏晚 60 秒见效」的折中。
 * 两个写 pro 的接口（/api/auth/pro、/api/admin/users）都会当场 evictAuthCache，
 * 所以改动在所在实例立刻可见，其它实例最多滞后 60 秒；被删掉的账号同理最多多留 60 秒。
 * 唯一清不到的是游客那一支（按 token 缓存，不是按 id）：管理员给游客开 pro 只能等 TTL 到期，
 * 而管理员授权本来就拒绝游客，这条路实际上走不到。
 * 从 20 秒提到 60 秒是跟着编辑器自动保存一起定的：停下来 8 秒落一次、最长脏 30 秒必落，
 * 一次连续改稿的几趟保存本来就落在同一分钟里，20 秒的窗口会让其中好几趟各自多跑一趟东京，
 * 只为把同一行 users 再读一遍。
 */
const AUTH_CACHE_TTL_MS = 60_000;
const authCache = new AuthTtlCache(AUTH_CACHE_TTL_MS);

/** 写 pro / 改账号之后调用，让本实例下一次请求重新查库 */
export function evictAuthCache(userId: number): void {
  authCache.delete(`u:${userId}`);
}

const guestKey = (token: string) => `g:${token}`;

function snapshot(row: AccountRow): AuthSnapshot {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    pro: proIsActive(row.pro, row.pro_expires_at),
  };
}

/** bcrypt 哈希固定以 $2 开头；不是这个形状就是锁定位，直接判失败，不进 KDF */
function isBcryptHash(hash: string): boolean {
  return hash.startsWith('$2');
}

/**
 * 用异步版而不是 *Sync：bcryptjs 是纯 JS，异步并不会跑到 libuv 线程池上，
 * 只是分片让出事件循环。实测连续 3 把的最大卡顿从 363ms 降到 97ms ——
 * 单个函数的总 CPU 没省，省的是同实例上其它请求被顶住的时长。
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!isBcryptHash(hash)) return false;
  return bcrypt.compare(password, hash);
}

export function signToken(user: AuthUser): string {
  return jwt.sign({ id: user.id, email: user.email, name: user.name }, getJwtSecret(), {
    expiresIn: '30d',
  });
}

export function verifyToken(token: string): AuthUser | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret()) as AuthUser;
    return { id: Number(decoded.id), email: decoded.email, name: decoded.name };
  } catch (err) {
    if (IS_PRODUCTION && err instanceof Error && err.message.startsWith('生产环境缺少')) {
      console.error('[auth]', err.message);
    }
    return null;
  }
}

export async function setAuthCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(TOKEN_NAME, token, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30,
    path: '/',
  });
}

export async function clearAuthCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(TOKEN_NAME);
}

async function loadUserById(id: number): Promise<AuthSnapshot | null> {
  const key = `u:${id}`;
  const hit = authCache.get(key);
  if (hit) return hit;

  // 不再拖 password_hash：每个认证请求都带它纯属白给。
  // email/name 要留着，游客那支复用同一份快照直接当 AuthUser 用。
  const row = await get<AccountRow>(
    'SELECT id, email, name, pro, pro_expires_at FROM users WHERE id = $1',
    [id]
  );
  if (!row) return null;

  const snap = snapshot(row);
  authCache.set(key, snap);
  return snap;
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(TOKEN_NAME)?.value;
  if (!token) return null;
  const base = verifyToken(token);
  if (!base) return null;

  // pro 以数据库为准，并且必须没过期
  try {
    const snap = await loadUserById(base.id);
    if (!snap) return null;
    return { ...base, pro: snap.pro };
  } catch {
    return { ...base, pro: false };
  }
}

export async function registerUser(
  email: string,
  password: string,
  name: string
): Promise<AuthUser> {
  const normalizedEmail = normalizeEmail(email);
  if (!isValidEmail(normalizedEmail)) throw new Error('邮箱格式不正确');

  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);

  const trimmedName = name.trim().slice(0, 50);
  if (!trimmedName) throw new Error('请填写名称');

  const existing = await get<{ id: number }>('SELECT id FROM users WHERE email = $1', [
    normalizedEmail,
  ]);
  if (existing) throw new Error('邮箱已被注册');

  const row = await insert<{ id: number }>(
    'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id',
    [normalizedEmail, await hashPassword(password), trimmedName]
  );

  return { id: row.id, email: normalizedEmail, name: trimmedName };
}

export async function loginUser(email: string, password: string): Promise<AuthUser> {
  const user = await get<UserRow>(
    'SELECT id, email, name, password_hash, pro, pro_expires_at FROM users WHERE email = $1',
    [normalizeEmail(email)]
  );

  if (!user) throw new Error('邮箱或密码错误');
  if (!(await verifyPassword(password, user.password_hash))) throw new Error('邮箱或密码错误');

  return { id: user.id, email: user.email, name: user.name };
}

/**
 * 按 guest cookie 找回已经建过的游客档：先查进程内缓存，再按合成邮箱查一次库并回填。
 * 找不到返回 null —— 建档是 getOrCreateGuest 的事，只读页面不该为一次 404 写下一行。
 */
async function findGuestByToken(guestToken: string): Promise<AuthSnapshot | null> {
  const key = guestKey(guestToken);
  const hit = authCache.get(key);
  if (hit) return hit;

  const user = await get<AccountRow>(
    'SELECT id, email, name, pro, pro_expires_at FROM users WHERE email = $1',
    [guestEmail(guestToken)]
  );
  if (!user) return null;

  const snap = snapshot(user);
  authCache.set(key, snap);
  return snap;
}

/**
 * 游客用户：用随机邮箱自动创建，cookie 里存 guest token 避免重复创建。
 * 游客和免费用户共享限额（1 个 PPT，每 PPT 2 页）。
 */
export async function getOrCreateGuest(): Promise<AuthUser> {
  const cookieStore = await cookies();
  const guestToken = cookieStore.get(GUEST_TOKEN_NAME)?.value;

  if (guestToken) {
    const found = await findGuestByToken(guestToken);
    if (found) return { ...found, isGuest: true };
  }

  // 创建新游客账号
  const token = randomBytes(16).toString('hex');
  const email = guestEmail(token);
  const name = `游客 ${token.slice(0, 6)}`;

  const row = await insert<{ id: number }>(
    'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id',
    [email, LOCKED_PASSWORD_HASH, name]
  );

  // 这行是我们自己刚写进去的，直接进缓存，下一个请求不用再按 email 查一趟
  authCache.set(guestKey(token), { id: row.id, email, name, pro: false });

  // 设置 guest cookie
  cookieStore.set(GUEST_TOKEN_NAME, token, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30, // 30 天
    path: '/',
  });

  return {
    id: row.id,
    email,
    name,
    pro: false,
    isGuest: true,
  };
}

/**
 * 获取当前用户（已登录）或游客（未登录）。
 * 未登录时自动创建游客账号，保证所有访问者都有 user_id 可用。
 */
export async function getCurrentUserOrGuest(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (user) return user;
  return getOrCreateGuest();
}

/**
 * 只读页面的身份：登录用户，或已经建过档的游客；都解析不出来就是 null。
 *
 * 和 getCurrentUserOrGuest 的差别只有一个：**不建档**。放映页按 id 取的是
 * 「这个人名下的稿子」，一个拿着别人分享链接进来、连 guest cookie 都没有的访客
 * 本来就没有可放的内容 —— 替他 INSERT 一行游客只是把一次 404 变成一次写库
 * （实测库里 67 个用户有 62 个是游客行，大多就是这么攒下来的）。
 */
export async function getViewerUser(): Promise<AuthUser | null> {
  const user = await getCurrentUser();
  if (user) return user;

  const guestToken = (await cookies()).get(GUEST_TOKEN_NAME)?.value;
  if (!guestToken) return null;

  const found = await findGuestByToken(guestToken);
  return found ? { ...found, isGuest: true } : null;
}
