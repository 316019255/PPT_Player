import test from 'node:test';
import assert from 'node:assert/strict';

import { createMaterialDupTable, putMaterial, scanFolder } from '../src/lib/localMaterials.ts';
import { createMediaResolver } from '../src/lib/pptxSink.ts';

/**
 * 覆盖 B4/B5：一批入库只开一趟全库游标。
 *
 * 这里的假 indexedDB 不只记账——files 里真的放记录、游标真的走一遍，
 * 所以既能量出「开了几趟游标」，也能验「命中的是不是对的张」。
 * 图片解码用假 createImageBitmap / OffscreenCanvas 顶掉：这一层要测的是查重管道，
 * 「浏览器解不开坏图就别入库」由别的用例管。
 * 全库游标趟数是关键指标：库里已有 N 张、这批要存 M 张时，老写法是 M 趟（每存一张重扫一遍库），
 * 现在必须是 1 趟。
 */

const state = { files: [], thumbs: new Map(), folder: null, cursorReads: 0, puts: 0 };

function objectStore(name, tx) {
  if (name === 'files') {
    return {
      openCursor() {
        state.cursorReads += 1;
        const req = { result: null, onsuccess: null, onerror: null };
        let i = 0;
        const fire = () => {
          const rec = state.files[i];
          i += 1;
          req.result = rec ? { value: rec, continue: () => queueMicrotask(fire) } : null;
          req.onsuccess?.();
        };
        queueMicrotask(fire);
        return req;
      },
      put(rec) {
        state.puts += 1;
        state.files.push(rec);
        queueMicrotask(() => tx.oncomplete?.());
      },
    };
  }
  if (name === 'thumbs') {
    return { put: (blob, key) => state.thumbs.set(key, blob) };
  }
  return {
    get: (key) => {
      const req = { result: key === 'folder' ? state.folder : undefined, onsuccess: null, onerror: null };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  };
}

function installBrowserBits() {
  state.files = [];
  state.thumbs = new Map();
  state.folder = null;
  state.cursorReads = 0;
  state.puts = 0;
  globalThis.OffscreenCanvas = class {
    constructor(w, h) {
      this.width = w;
      this.height = h;
    }
    getContext() {
      return { fillStyle: '', fillRect() {}, drawImage() {} };
    }
    convertToBlob() {
      return Promise.resolve(new Blob(['jpeg'], { type: 'image/jpeg' }));
    }
  };
  globalThis.createImageBitmap = () => Promise.resolve({ width: 10, height: 8, close() {} });
  globalThis.indexedDB = {
    open() {
      const req = {};
      req.result = {
        objectStoreNames: { contains: () => true },
        createObjectStore() {},
        close() {},
        transaction() {
          const tx = { objectStore: (name) => objectStore(name, tx), oncomplete: null, onerror: null, onabort: null };
          return tx;
        },
      };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  };
}

/** 一张能过查重、也存得进去的假图片 */
const png = (name, content = 'x') => new File([content], name, { type: 'image/png' });

/** 已存在的 + 要扫出来的，两处得是同一张：体积和 MIME 都得对上 */
const handleOf = (file) => ({ kind: 'file', name: file.name, getFile: () => Promise.resolve(file) });

/** 库里已有这张：塞一条记录，返回那个 File（同一份字节再去当文件夹里的那一个） */
function seedLib(name, content = 'x') {
  const file = png(name, content);
  state.files.push({
    key: `k-${name}`,
    name,
    kind: 'image',
    mime: 'image/png',
    size: file.size,
    createdAt: 1,
    blob: file,
  });
  return file;
}

test('一批 50 张新图共用一张表 = 1 趟全库读；各建各的 = 每张 1 趟', async () => {
  installBrowserBits();
  seedLib('old-a.png');

  const table = await createMaterialDupTable();
  assert.equal(state.cursorReads, 1, '建表本身就该只开一趟');
  for (let i = 0; i < 50; i++) await putMaterial(png(`pic-${i}.png`), table);
  assert.equal(state.cursorReads, 1, '存这 50 张一次都没再读库');
  assert.equal(state.files.length, 51);

  // 对照组：不传表（单文件添加那条路），每张自己扫一遍库
  for (let i = 50; i < 100; i++) await putMaterial(png(`pic-${i}.png`));
  assert.equal(state.cursorReads, 51, '老写法的 50 张就是 50 趟，而且趟数跟着库一起涨');
});

test('表记住这一批刚存的那张：同一张图第二次不多存一份', async () => {
  installBrowserBits();

  const table = await createMaterialDupTable();
  const first = await putMaterial(png('same.png', 'aaaa'), table);
  const writes = state.puts;
  const again = await putMaterial(png('same.png', 'aaaa'), table);
  assert.equal(again.key, first.key, '命中的是刚存的那张，不是又插一份');
  assert.equal(state.puts, writes, '命中时一次写都不该有');
  assert.equal(state.files.length, 1);
});

test('不跨批缓存：下一批新建的表照样看得见上一批存进去的', async () => {
  installBrowserBits();
  const file = png('fresh.png', 'bb');
  const meta = await putMaterial(file, await createMaterialDupTable());

  const probe = { name: file.name, size: file.size, mime: 'image/png' };
  assert.equal((await createMaterialDupTable()).find(probe)?.key, meta.key, '别的标签页写的，下一批得能看到');
  assert.equal(state.cursorReads, 2, '入库时建的那趟 + 这一趟新表');
});

test('扫描文件夹：整批一趟全库读，库里已有的算「已存在」不再解码', async () => {
  installBrowserBits();
  const handles = [];
  for (let i = 0; i < 10; i++) handles.push(handleOf(seedLib(`in-lib-${i}.png`, 'zz')));
  for (let i = 0; i < 40; i++) handles.push(handleOf(png(`brand-new-${i}.png`, 'yyyy')));
  handles.push({ kind: 'directory', name: 'sub' });
  handles.push(handleOf(new File(['x'], 'notes.txt')));
  handles.push(handleOf(png('.DS_Store')));

  state.folder = {
    name: '素材',
    savedAt: 1,
    handle: {
      name: '素材',
      queryPermission: () => Promise.resolve('granted'),
      values: () => {
        let i = 0;
        return {
          next: () => Promise.resolve(i < handles.length ? { value: handles[i++], done: false } : { done: true }),
        };
      },
    },
  };

  const report = await scanFolder();
  assert.equal(report.added.length, 40);
  assert.equal(report.unchanged, 10, '库里同名同体积同 MIME 的直接跳过');
  assert.equal(report.unsupported, 1, '白名单外的后缀不算素材');
  assert.deepEqual(report.failed, []);
  assert.equal(state.cursorReads, 1, '40 张新增 + 10 张已存在 = 还是只有建表那一趟');
  assert.equal(state.files.length, 50);
  assert.equal(state.thumbs.size, 40, '跳过的老素材连预览图都不重编');
});

/** 字节内容不重要：假解码器什么都解得开，这里只看查重管道和落库次数 */
const partBytes = (tag) => new TextEncoder().encode(`PNGBYTES-${tag}`).slice();

test('一份 pptx 落本机：30 张图共用一张表，同一个 media 部件不多存一份', async () => {
  installBrowserBits();
  const { resolveMedia, stats } = createMediaResolver({ cloud: false });

  const first = await resolveMedia('ppt/media/image1.png', partBytes('a'));
  for (let i = 2; i <= 30; i++) {
    const one = await resolveMedia(`ppt/media/image${i}.png`, partBytes(`${i}`));
    assert.equal(one.ok, true, one.ok ? '' : one.reason);
  }
  assert.equal(stats.localStored, 30);
  assert.equal(state.cursorReads, 1, '第一张图才建表，后面 29 张一次库都没读');

  // 同一个部件被两页引用：只该有一份字节进库，两页拿到同一个引用
  const again = await resolveMedia('ppt/media/image1.png', partBytes('a'));
  assert.deepEqual(again, first);
  assert.equal(state.files.length, 30, '重复部件没有再存一份');

  const second = createMediaResolver({ cloud: false });
  await second.resolveMedia('ppt/media/image1.png', partBytes('a'));
  assert.equal(state.cursorReads, 2, '换一份 pptx 就重新建表，不跨导入留脏表');
});
