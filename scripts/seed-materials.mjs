/**
 * 把在线素材的初始清单写进 materials 表（幂等，可重复执行）。
 * 用法：node --env-file=.env.local scripts/seed-materials.mjs
 *
 * 这批数据原来是 src/lib/backgrounds.ts 里的字面量，前台直接 import；
 * 现在 materials 是在线素材的唯一真相，前台改从表里读，所以搬进种子脚本。
 * url 上有唯一索引，重复执行走 ON CONFLICT DO NOTHING，不会插出第二份。
 */
import pg from 'pg';

// [kind, url, thumb_url, category, title]
const SEED = [
  ['image', 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1920', 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=400', '自然', '山脉日落'],
  ['image', 'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=1920', 'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=400', '自然', '雾气森林'],
  ['image', 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=1920', 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=400', '自然', '阳光树林'],
  ['image', 'https://images.unsplash.com/photo-1472214103451-9374bd1c798e?w=1920', 'https://images.unsplash.com/photo-1472214103451-9374bd1c798e?w=400', '自然', '湖畔山野'],
  ['image', 'https://images.unsplash.com/photo-1501785888041-af3ef285b470?w=1920', 'https://images.unsplash.com/photo-1501785888041-af3ef285b470?w=400', '自然', '挪威峡湾'],
  ['image', 'https://images.unsplash.com/photo-1518837695005-2083093ee35b?w=1920', 'https://images.unsplash.com/photo-1518837695005-2083093ee35b?w=400', '自然', '广阔海洋'],
  ['image', 'https://images.unsplash.com/photo-1514565131-fce0801e5785?w=1920', 'https://images.unsplash.com/photo-1514565131-fce0801e5785?w=400', '城市', '城市夜灯'],
  ['image', 'https://images.unsplash.com/photo-1480714378408-67cf0d13bc1b?w=1920', 'https://images.unsplash.com/photo-1480714378408-67cf0d13bc1b?w=400', '城市', '都市天际线'],
  ['image', 'https://images.unsplash.com/photo-1444723121867-7a241cacace9?w=1920', 'https://images.unsplash.com/photo-1444723121867-7a241cacace9?w=400', '城市', '霓虹都市'],
  ['image', 'https://images.unsplash.com/photo-1557683316-973673baf926?w=1920', 'https://images.unsplash.com/photo-1557683316-973673baf926?w=400', '抽象', '紫粉渐变'],
  ['image', 'https://images.unsplash.com/photo-1579546929518-9e396f3cc809?w=1920', 'https://images.unsplash.com/photo-1579546929518-9e396f3cc809?w=400', '抽象', '极光色带'],
  ['image', 'https://images.unsplash.com/photo-1557682250-33bd709cbe85?w=1920', 'https://images.unsplash.com/photo-1557682250-33bd709cbe85?w=400', '抽象', '蓝色渐变'],
  ['image', 'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?w=1920', 'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?w=400', '宇宙', '银河星系'],
  ['image', 'https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?w=1920', 'https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?w=400', '宇宙', '星空轨迹'],
  ['image', 'https://images.unsplash.com/photo-1490750967868-88aa4f44baee?w=1920', 'https://images.unsplash.com/photo-1490750967868-88aa4f44baee?w=400', '花卉', '粉色花海'],
  ['image', 'https://images.unsplash.com/photo-1490750967868-88aa4f44baee?w=1920&sat=-100', 'https://images.unsplash.com/photo-1490750967868-88aa4f44baee?w=400&sat=-100', '花卉', '黑白花卉'],
  ['video', 'https://www.w3schools.com/html/mov_bbb.mp4', 'https://images.unsplash.com/photo-1518837695005-2083093ee35b?w=400', '稳定源', 'Big Buck Bunny'],
  ['video', 'https://www.w3schools.com/html/movie.mp4', 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=400', '稳定源', 'Elephants Dream'],
  ['video', 'https://videos.pexels.com/video-files/856974/856974-hd_1920_1080_30fps.mp4', 'https://images.pexels.com/photos/856974/pexels-photo-856974.jpeg?w=400', '自然', '海浪拍打'],
  ['video', 'https://videos.pexels.com/video-files/1192116/1192116-hd_1920_1080_30fps.mp4', 'https://images.pexels.com/photos/1192116/pexels-photo-1192116.jpeg?w=400', '自然', '星空流动'],
  ['video', 'https://videos.pexels.com/video-files/2169880/2169880-hd_1920_1080_30fps.mp4', 'https://images.pexels.com/photos/2169880/pexels-photo-2169880.jpeg?w=400', '自然', '自然之美'],
  ['video', 'https://cdn.plyr.io/static/demo/View_From_A_Blue_Moon_Trailer-576p.mp4', 'https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?w=400', '稳定源', '蓝色月亮预告片'],
  ['video', 'https://media.w3.org/2010/05/sintel/trailer.mp4', 'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?w=400', '稳定源', 'Sintel 预告片'],
  ['video', 'https://media.w3.org/2010/05/video/movie_300.mp4', 'https://images.unsplash.com/photo-1501785888041-af3ef285b470?w=400', '稳定源', '短片段'],
];

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('缺少 DATABASE_URL。本地跑 node --env-file=.env.local scripts/seed-materials.mjs');
  process.exit(1);
}

const ca = process.env.DATABASE_CA_CERT?.trim();
const ssl = ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };
const [base, search] = url.split('?');
const query = new URLSearchParams(search);
query.delete('sslmode');

const pool = new pg.Pool({
  connectionString: [...query.keys()].length ? `${base}?${query}` : base,
  ssl,
  max: 2,
  connectionTimeoutMillis: 15000,
});

try {
  let inserted = 0;
  // sort 从大到小给：前台按 sort DESC 排，这样数组顺序就是原来的展示顺序
  for (let i = 0; i < SEED.length; i++) {
    const [kind, u, thumb, category, title] = SEED[i];
    const r = await pool.query(
      `INSERT INTO materials (kind, url, thumb_url, category, title, sort)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (url) DO NOTHING`,
      [kind, u, thumb, category, title, (SEED.length - i) * 10]
    );
    inserted += r.rowCount;
  }

  const total = await pool.query('SELECT count(*)::int AS n, count(*) FILTER (WHERE enabled = 1)::int AS on FROM materials');
  console.log(`本次新插入 ${inserted} 条，跳过已存在 ${SEED.length - inserted} 条`);
  console.log(`表内现有 ${total.rows[0].n} 条（其中启用 ${total.rows[0].on} 条）`);
} catch (err) {
  console.error('种子写入失败：', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
