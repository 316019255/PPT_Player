import test from 'node:test';
import assert from 'node:assert/strict';

import { isSameMaterial, localRefValue, scanFolder } from '../src/lib/localMaterials.ts';

const meta = {
  key: 'k1',
  name: 'sea.png',
  kind: 'image',
  mime: 'image/png',
  size: 1000,
  createdAt: 1,
};

test('名字+体积+MIME 全同才算已有，扫描时不会重复解码', () => {
  assert.equal(isSameMaterial(meta, { name: 'sea.png', size: 1000, mime: 'image/png' }), true);
});

test('任一项不同就是新素材', () => {
  assert.equal(isSameMaterial(meta, { name: 'sea.jpg', size: 1000, mime: 'image/png' }), false);
  assert.equal(isSameMaterial(meta, { name: 'sea.png', size: 1001, mime: 'image/png' }), false);
  // 同名同体积但类型对不上（比如改过扩展名），要重新入库重新解码
  assert.equal(isSameMaterial(meta, { name: 'sea.png', size: 1000, mime: 'image/webp' }), false);
});

test('File 要先把 .type 转成 mime 再比对，直接塞 File 永远不匹配', () => {
  const file = new File(['xyz'], 'sea.png', { type: 'image/png' });
  const stored = { ...meta, size: file.size };
  // File 上没有 .mime 字段：直接传 File 会拿 undefined 去比，等于每次都当成新文件
  assert.equal(isSameMaterial(stored, file), false);
  assert.equal(isSameMaterial(stored, { name: file.name, size: file.size, mime: file.type }), true);
});

test('引用串只在 local: 前缀下拼装', () => {
  assert.equal(localRefValue('abc'), 'local:abc');
});

test('没有 IndexedDB 的环境里扫描直接失败，不会假装扫过', async () => {
  await assert.rejects(() => scanFolder(), /本地素材库|素材文件夹/);
});
