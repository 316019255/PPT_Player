/**
 * 建一个「能登录」的后台账号。管理员权限本身不在这里给 —— 它是 .env.local 里
 * ADMIN_EMAILS 的名单，改完必须重启 dev（名单是每次调用现读 env，但 env 只在启动时读进来）。
 *
 *   node --env-file=.env.local scripts/set-admin.mjs <email> <password> [名称] [--reset]
 *
 * 为什么要有这个脚本：注册页的密码规则是「至少 8 位」，测试用的短密码走 UI 进不来；
 * 而直接连库插一条 bcrypt 串，走的就是和 registerUser 完全一样的登录形状。
 * 存在的邮箱默认拒绝（不静默改别人密码），要重置显式加 --reset。
 */
import bcrypt from 'bcryptjs';
import pg from 'pg';

const [email, password, ...rest] = process.argv.slice(2);
const explicitName = rest.find((a) => !a.startsWith('--'))?.trim();
const forceReset = rest.includes('--reset');

function die(message) {
  console.error(message);
  process.exit(1);
}

if (!email || !password) {
  die('用法：node --env-file=.env.local scripts/set-admin.mjs <email> <password> [名称] [--reset]');
}

const url = process.env.DATABASE_URL;
if (!url) die('缺少 DATABASE_URL（本地用 --env-file=.env.local）');

const normalized = email.trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalized)) die(`邮箱形状不对：${normalized}`);
// 游客行没有可登录身份（password_hash 是不合法的 bcrypt 串），promote 它只会造出一个谁都进不去的管理员
if (normalized.startsWith('guest_') && normalized.endsWith('@ppt-player.local')) {
  die('游客邮箱不能当管理员：它没有可登录的身份');
}

const ca = process.env.DATABASE_CA_CERT?.trim();
const ssl = ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };

// 连接串的 sslmode 会盖过显式 ssl 选项，pg 把 require 当 verify-full 处理，自建 CA 必然验不过
const [base, search] = url.split('?');
const query = new URLSearchParams(search);
query.delete('sslmode');
const connectionString = [...query.keys()].length ? `${base}?${query}` : base;

const client = new pg.Client({ connectionString, ssl });

try {
  await client.connect();

  const hit = await client.query('SELECT id, name, pro FROM users WHERE email = $1', [normalized]);
  if (hit.rowCount > 0 && !forceReset) {
    const r = hit.rows[0];
    die(`已存在 id=${r.id} ${normalized}（${r.name}，pro=${r.pro}）。要重置它的密码就加 --reset`);
  }

  const hash = await bcrypt.hash(password, 10);

  if (hit.rowCount > 0) {
    // 重置密码不该顺手改掉别人的名称 —— 只有明确传了名称才动
    await client.query(
      explicitName ? 'UPDATE users SET password_hash = $1, name = $2 WHERE id = $3' : 'UPDATE users SET password_hash = $1 WHERE id = $2',
      explicitName ? [hash, explicitName, hit.rows[0].id] : [hash, hit.rows[0].id]
    );
    console.log(`已重置 id=${hit.rows[0].id} ${normalized} 的密码${explicitName ? `（名称：${explicitName}）` : ''}`);
  } else {
    const inserted = await client.query(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id',
      [normalized, hash, explicitName || '管理员']
    );
    console.log(`已创建 id=${inserted.rows[0].id} ${normalized}（名称：${explicitName || '管理员'}，pro=0）`);
  }

  console.log(`下一步：ADMIN_EMAILS=${normalized} 写进 .env.local，然后重启 dev。`);
} catch (err) {
  console.error('失败：', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
